// Pure factories that turn agent outputs into AgentReasoning records.
// Kept side-effect-free so they can be unit-tested in isolation; the
// orchestrator just calls these and pushes the result into ExplainabilityService.

import type {
  AgentReasoning,
  IterationHistoryEntry,
  IterationTrajectory,
} from './ExplainabilityTypes.js';
import type { ScribeOutput, ProtoOutput, TraceOutput } from '../contracts/PipelineTypes.js';
import type { CriticReviewOutput } from '../../agents/critic/CriticTypes.js';
import { buildAcCoverage } from './acCoverage.js';

export function buildScribeReasoning(
  output: ScribeOutput,
  opts: { regenerated: boolean; now?: Date } = { regenerated: false }
): AgentReasoning {
  const acCount = output.spec?.acceptanceCriteria?.length ?? 0;
  const usCount = output.spec?.userStories?.length ?? 0;
  const confidencePercent = Math.round((output.confidence ?? 0) * 100);
  const title = output.spec?.title ?? '';
  return {
    agentName: 'scribe',
    timestamp: opts.now ?? new Date(),
    decision: opts.regenerated ? `Spec yeniden üretildi: "${title}"` : `Spec üretildi: "${title}"`,
    reasoning: [
      `${output.clarificationsAsked ?? 0} açıklayıcı soru soruldu`,
      `${usCount} kullanıcı hikâyesi tanımlandı`,
      `${acCount} kabul kriteri yazıldı`,
    ],
    assumptions: output.assumptions ?? [],
    confidence: {
      score: confidencePercent,
      factors: [
        `Açıklayıcı sorulara cevap: ${output.clarificationsAsked ?? 0}`,
        `Kabul kriteri sayısı: ${acCount}`,
        `Kullanıcı hikâyesi sayısı: ${usCount}`,
      ],
    },
    ...(opts.regenerated ? { risks: ['Spec kullanıcı geri bildirimiyle yeniden üretildi'] } : {}),
  };
}

export function buildProtoReasoning(
  output: ProtoOutput,
  opts: { now?: Date; scribeOutput?: ScribeOutput } = {}
): AgentReasoning {
  const filesCreated = output.metadata?.filesCreated ?? output.files?.length ?? 0;
  const totalLoc = output.metadata?.totalLinesOfCode ?? 0;
  const stack = output.metadata?.stackUsed ?? 'bilinmeyen';
  const committed = output.metadata?.committed === true;

  // PR-D: Mechanical confidence formula (committed && files≥6 → 88, …)
  // replaced by AC coverage ratio. When the spec is available, the score is
  // `staticCoveredCount / totalAcs × 100`, which is a real measurement of
  // "kaç kabul kriteri için kod üretildi" rather than a heuristic over file
  // count. When no AC are available (zero-AC spec or scribeOutput missing),
  // we fall back to a neutral status-based score: committed → 70, else → 50.
  // The fallback is intentionally flat — it doesn't pretend to know more
  // than "committed yes/no".
  const coverage = opts.scribeOutput
    ? buildAcCoverage(opts.scribeOutput, output)
    : { totalAcs: 0, staticCoveredCount: 0, dynamicCoveredCount: 0, items: [] };
  const hasAcs = coverage.totalAcs > 0;
  const acScore = hasAcs
    ? Math.round((coverage.staticCoveredCount / coverage.totalAcs) * 100)
    : null;
  const confidenceScore = acScore !== null ? acScore : committed ? 70 : 50;

  const acFactor = hasAcs
    ? `Kabul kriteri kapsamı: ${coverage.staticCoveredCount}/${coverage.totalAcs}`
    : null;

  return {
    agentName: 'proto',
    timestamp: opts.now ?? new Date(),
    decision: `İskelet üretildi: ${filesCreated} dosya, ${totalLoc} satır kod`,
    reasoning: [
      `Teknoloji seti: ${stack}`,
      `Dal: ${output.branch ?? 'bilinmeyen'}`,
      committed ? 'GitHub deposu güncellendi' : "Henüz GitHub'a gönderilmedi",
      ...(hasAcs
        ? [`${coverage.staticCoveredCount}/${coverage.totalAcs} kabul kriteri için kod üretildi`]
        : []),
      ...(output.summary ? [output.summary] : []),
    ],
    assumptions: ['Spec onaylandı ve iskelet için yeterli ayrıntıdaydı'],
    confidence: {
      score: confidenceScore,
      factors: [
        ...(acFactor ? [acFactor] : []),
        `Dosya sayısı: ${filesCreated}`,
        `Toplam satır: ${totalLoc}`,
        committed
          ? 'Uzaktaki repoya gönderildi'
          : 'Sadece local taslak — uzaktaki repoya gönderilmedi',
      ],
    },
  };
}

export function buildTraceReasoning(
  output: TraceOutput,
  opts: { now?: Date } = {}
): AgentReasoning {
  const ts = output.testSummary;
  const totalTests = ts?.totalTests ?? 0;
  const coverage = ts?.coveragePercentage ?? 0;
  const uncovered = ts?.uncoveredCriteria ?? [];
  const fileCount = output.testFiles?.length ?? 0;
  return {
    agentName: 'trace',
    timestamp: opts.now ?? new Date(),
    decision: `${totalTests} test üretildi, %${coverage} kabul kriteri kapsamı`,
    reasoning: [
      `${fileCount} test dosyası yazıldı`,
      `Karşılanmayan kriter sayısı: ${uncovered.length}`,
      ...(output.gherkinFeatures && output.gherkinFeatures.length > 0
        ? [`${output.gherkinFeatures.length} Gherkin senaryosu üretildi`]
        : []),
    ],
    assumptions: ['Proto kodu test yazımı için GitHub üzerinden okunabilir durumdaydı'],
    confidence: {
      score: coverage,
      factors: [`Toplam test: ${totalTests}`, `Kapsam: %${coverage}`, `Test dosyası: ${fileCount}`],
    },
    ...(uncovered.length > 0
      ? {
          risks: [
            `Karşılanmayan kabul kriteri: ${uncovered.slice(0, 5).join(', ')}${uncovered.length > 5 ? '...' : ''}`,
          ],
        }
      : {}),
  };
}

export function buildCriticReasoning(
  result: CriticReviewOutput,
  opts: { reviewType: 'spec' | 'code'; now?: Date }
): AgentReasoning {
  const findingsCount = result.findings?.length ?? 0;
  const decisionLabel =
    opts.reviewType === 'spec'
      ? result.approved
        ? 'Spec onaylandı'
        : 'Spec reddedildi'
      : result.approved
        ? 'Kod onaylandı'
        : 'Kod reddedildi';
  const criticalAndMajor =
    result.findings
      ?.filter((f) => f.severity === 'critical' || f.severity === 'major')
      .map((f) => f.description) ?? [];
  return {
    agentName: 'critic',
    // Distinct stage key per review type — keeps `pipeline_reasonings`'s
    // (pipeline_id, stage) UNIQUE index from collapsing spec vs code review.
    stageKey: opts.reviewType === 'spec' ? 'critic-spec' : 'critic-code',
    timestamp: opts.now ?? new Date(),
    decision: decisionLabel,
    reasoning: result.findings?.map((f) => f.description) ?? [],
    assumptions:
      opts.reviewType === 'spec'
        ? ['Spec yapısal kontrolleri tamamlandı']
        : ['Spec uyumu ve temel güvenlik bulguları otomatik kontrol edildi'],
    confidence: {
      score: result.overallScore ?? 0,
      factors: [
        `${findingsCount} bulgu raporlandı`,
        `İnceleme: ${opts.reviewType === 'spec' ? 'spec' : 'kod'}`,
      ],
    },
    ...(criticalAndMajor.length > 0 ? { risks: criticalAndMajor } : {}),
    // Structured findings — let the explainability surface group by
    // category and surface severity + suggestion. Falls back to the
    // flat `reasoning[]` bullets in clients that ignore this field.
    findings: (result.findings ?? []).map((f) => ({
      severity: f.severity,
      category: f.category,
      description: f.description,
      suggestion: f.suggestion,
      ...(f.location ? { location: f.location } : {}),
    })),
  };
}

// ─── PR-U3 M8: ReasoningFactory registry ─────────────────────────
//
// Previously the orchestrator hard-coded which builder maps to which agent
// (`buildScribeReasoning`, `buildProtoReasoning`, ...). Adding a new agent
// required hunting through orchestrator code; calling an unknown agent
// silently produced no reasoning row. The registry below decouples the
// dispatch — `recordReasoningGeneric(pipelineId, agentName, output)` can
// be called from any agent runner; unknown agents log a warning and fall
// back to a minimal placeholder so the Açıklama tab still shows the agent
// even before its dedicated builder lands.
//
// The orchestrator's typed helpers (`recordScribeReasoning`, etc.) stay as
// thin wrappers — direct callers with structured outputs still get full
// type safety, the registry is only the escape hatch.

export type ReasoningBuilder<T = unknown> = (
  output: T,
  opts?: Record<string, unknown>
) => AgentReasoning;

/**
 * Default registry shipped with the orchestrator. New agents register their
 * builder here; consumers (the orchestrator, tests, internal tools) read
 * via `lookupReasoningBuilder()` so unknown agents get a documented fallback
 * instead of `undefined`.
 */
const DEFAULT_REASONING_BUILDERS: Record<string, ReasoningBuilder<unknown>> = {
  scribe: buildScribeReasoning as ReasoningBuilder<unknown>,
  proto: buildProtoReasoning as ReasoningBuilder<unknown>,
  trace: buildTraceReasoning as ReasoningBuilder<unknown>,
  critic: buildCriticReasoning as ReasoningBuilder<unknown>,
};

const reasoningRegistry: Map<string, ReasoningBuilder<unknown>> = new Map(
  Object.entries(DEFAULT_REASONING_BUILDERS)
);

export function registerReasoningBuilder(
  agentName: string,
  builder: ReasoningBuilder<unknown>
): void {
  reasoningRegistry.set(agentName, builder);
}

export function lookupReasoningBuilder(agentName: string): ReasoningBuilder<unknown> | undefined {
  return reasoningRegistry.get(agentName);
}

/**
 * Generic fallback record for an agent that has no registered builder.
 * Returned by `lookupReasoningBuilderOrFallback()` so the explainability
 * surface always renders something instead of silently dropping the row.
 */
export function buildFallbackReasoning(
  agentName: string,
  output: unknown,
  opts: { now?: Date; decision?: string } = {}
): AgentReasoning {
  return {
    agentName,
    timestamp: opts.now ?? new Date(),
    decision: opts.decision ?? `${agentName} adımı tamamlandı`,
    reasoning: [
      `Bu ajan (${agentName}) için özel bir açıklama oluşturucusu kayıtlı değil — varsayılan kayıt kullanıldı.`,
    ],
    assumptions: [],
    confidence: { score: 0, factors: ['Yapılandırılmış ölçüm yok'] },
    // Stash raw output so a future builder can re-process it without
    // re-running the agent. JSON-safe shape relies on `output` being
    // serializable, which is enforced by ExplainabilityService.
    ...(output && typeof output === 'object'
      ? { reasoningRaw: output as Record<string, unknown> }
      : {}),
  };
}

// T4: turn the orchestrator's iterationHistory trail into the
// PipelineExplanation-facing trajectory. Pure factory — no DB, no time.
export function buildIterationTrajectory(
  history: IterationHistoryEntry[] | undefined | null
): IterationTrajectory | undefined {
  if (!history || history.length === 0) return undefined;
  const sorted = [...history].sort((a, b) => a.iteration - b.iteration);
  const firstScore = sorted[0]?.criticScore;
  const lastScore = sorted[sorted.length - 1]?.criticScore;
  const criticScoreDelta =
    typeof firstScore === 'number' && typeof lastScore === 'number'
      ? lastScore - firstScore
      : null;
  const finalDecision = sorted[sorted.length - 1]?.decision ?? null;
  return {
    entries: sorted,
    criticScoreDelta,
    finalDecision: finalDecision ?? null,
  };
}

