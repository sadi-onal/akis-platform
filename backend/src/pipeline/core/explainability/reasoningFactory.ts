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
    decision: opts.regenerated ? `Spec yeniden uretildi: "${title}"` : `Spec uretildi: "${title}"`,
    reasoning: [
      `${output.clarificationsAsked ?? 0} aciklayici soru soruldu`,
      `${usCount} kullanici hikayesi tanimlandi`,
      `${acCount} kabul kriteri yazildi`,
    ],
    assumptions: output.assumptions ?? [],
    confidence: {
      score: confidencePercent,
      factors: [
        `Aciklayici sorulara cevap: ${output.clarificationsAsked ?? 0}`,
        `Kabul kriteri sayisi: ${acCount}`,
        `Kullanici hikayesi sayisi: ${usCount}`,
      ],
    },
    ...(opts.regenerated ? { risks: ['Spec kullanici geri bildirimiyle yeniden uretildi'] } : {}),
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
    decision: `Scaffold uretildi: ${filesCreated} dosya, ${totalLoc} satir kod`,
    reasoning: [
      `Stack: ${stack}`,
      `Branch: ${output.branch ?? 'bilinmeyen'}`,
      committed ? 'GitHub repo guncellendi' : 'Commit dogrulanmadi',
      ...(output.summary ? [output.summary] : []),
    ],
    assumptions: ['Spec onaylandi ve scaffold icin yeterli ayrintidaydi'],
    confidence: {
      score: confidence,
      factors: [
        `Dosya sayisi: ${filesCreated}`,
        `Toplam LOC: ${totalLoc}`,
        `Commit dogrulandi: ${committed}`,
      ],
    },
    ...(output.metadata?.committed === false
      ? { risks: ['Scaffold commit edilemedi — manuel inceleme gerekebilir'] }
      : {}),
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
    decision: `${totalTests} test uretildi, %${coverage} kabul kriteri kapsami`,
    reasoning: [
      `${fileCount} test dosyasi yazildi`,
      `Karsilanmayan kriter sayisi: ${uncovered.length}`,
      ...(output.gherkinFeatures && output.gherkinFeatures.length > 0
        ? [`${output.gherkinFeatures.length} Gherkin feature uretildi`]
        : []),
    ],
    assumptions: ['Proto kodu test yazimi icin GitHub uzerinden okunabilir durumdaydi'],
    confidence: {
      score: coverage,
      factors: [
        `Toplam test: ${totalTests}`,
        `Coverage: %${coverage}`,
        `Test dosyasi: ${fileCount}`,
      ],
    },
    ...(uncovered.length > 0
      ? {
          risks: [
            `Karsilanmayan AC: ${uncovered.slice(0, 5).join(', ')}${uncovered.length > 5 ? '...' : ''}`,
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
        ? 'Spec onaylandi'
        : 'Spec reddedildi'
      : result.approved
        ? 'Kod onaylandi'
        : 'Kod reddedildi';
  const criticalAndMajor =
    result.findings
      ?.filter((f) => f.severity === 'critical' || f.severity === 'major')
      .map((f) => f.description) ?? [];
  return {
    agentName: 'critic',
    timestamp: opts.now ?? new Date(),
    decision: decisionLabel,
    reasoning: result.findings?.map((f) => f.description) ?? [],
    assumptions:
      opts.reviewType === 'spec'
        ? ['Spec yapısal kontrolleri tamamlandi']
        : ['Spec uyumu ve temel guvenlik bulgulari otomatik kontrol edildi'],
    confidence: {
      score: result.overallScore ?? 0,
      factors: [
        `${findingsCount} bulgu raporlandi`,
        `Inceleme: ${opts.reviewType === 'spec' ? 'spec' : 'kod'}`,
      ],
    },
    ...(criticalAndMajor.length > 0 ? { risks: criticalAndMajor } : {}),
  };
}
