// Pure factories that turn agent outputs into AgentReasoning records.
// Kept side-effect-free so they can be unit-tested in isolation; the
// orchestrator just calls these and pushes the result into ExplainabilityService.

import type { AgentReasoning } from './ExplainabilityTypes.js';
import type { ScribeOutput, ProtoOutput, TraceOutput } from '../contracts/PipelineTypes.js';
import type { CriticReviewOutput } from '../../agents/critic/CriticTypes.js';

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
  opts: { now?: Date } = {}
): AgentReasoning {
  const filesCreated = output.metadata?.filesCreated ?? output.files?.length ?? 0;
  const totalLoc = output.metadata?.totalLinesOfCode ?? 0;
  const stack = output.metadata?.stackUsed ?? 'bilinmeyen';
  const committed = output.metadata?.committed === true;
  // Heuristic confidence: committed scaffolds with 6+ files = high; just
  // committed = medium; uncommitted = low. Mirrors MIN_SCAFFOLD_FILES from
  // ProtoAgent so a "passes Proto's own minimum" output reads as confident.
  const confidence = committed && filesCreated >= 6 ? 88 : committed ? 70 : 55;
  return {
    agentName: 'proto',
    timestamp: opts.now ?? new Date(),
    decision: `İskelet üretildi: ${filesCreated} dosya, ${totalLoc} satır kod`,
    reasoning: [
      `Teknoloji seti: ${stack}`,
      `Dal: ${output.branch ?? 'bilinmeyen'}`,
      committed ? 'GitHub deposu güncellendi' : "Henüz GitHub'a gönderilmedi",
      ...(output.summary ? [output.summary] : []),
    ],
    assumptions: ['Spec onaylandı ve iskelet için yeterli ayrıntıdaydı'],
    confidence: {
      score: confidence,
      factors: [
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
