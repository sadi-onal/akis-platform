// Pure factory that turns a pipeline (+ optional parent) into a
// RegressionReport. No side effects, no I/O — same style as
// reasoningFactory.ts so it can be unit-tested in isolation.
//
// Status precedence (most-positive last so a later branch can overwrite
// an earlier one):
//
//   no_baseline    — relevant pipeline never produced a Trace run
//   degraded       — Trace ran but left uncovered AC, or FixLoop ended
//                    without success
//   self_healed    — FixLoop ran and the last iteration passed
//   verified_baseline — Trace passed cleanly, no FixLoop needed

import type { PipelineState } from '../contracts/PipelineTypes.js';
import type {
  RegressionBaseline,
  RegressionFixLoop,
  RegressionReport,
  RegressionStatus,
} from './RegressionTypes.js';

export interface BuildRegressionReportArgs {
  pipeline: PipelineState;
  parentPipeline?: PipelineState;
  /** Activity-log derived count of FixLoop runs (any agent recorded fix-loop step). */
  fixLoopActivityCount?: number;
  /**
   * Whether the last FixLoop ended with `tests_passed`. When undefined,
   * the factory infers from baseline coverage (no uncovered AC means the
   * loop landed). Pass explicitly when the metrics service records a
   * non-`tests_passed` termination so the report reflects reality.
   */
  fixLoopSucceeded?: boolean;
}

export function buildRegressionReport(args: BuildRegressionReportArgs): RegressionReport {
  const { pipeline, parentPipeline, fixLoopActivityCount, fixLoopSucceeded } = args;

  const isIteration = isIterationChild(pipeline);
  // For iteration children we read baseline from the parent — iteration
  // mode does not re-run Trace today (orchestrator line ~1086) so the
  // parent's last Trace is the only meaningful baseline we can show.
  const baselineSource = isIteration ? parentPipeline : pipeline;
  const baseline = extractBaseline(baselineSource);

  const fixLoop = buildFixLoop(baselineSource, fixLoopActivityCount, fixLoopSucceeded);

  const iterationFilesChanged = isIteration ? (pipeline.protoOutput?.files?.length ?? null) : null;
  const iterationRequest = isIteration ? readIterationRequest(pipeline) : undefined;

  const status = pickStatus(baseline, fixLoop);

  const headline = buildHeadline(status, baseline, fixLoop, iterationFilesChanged);
  const bakkalSummary = buildBakkalSummary({
    isIteration,
    iterationFilesChanged,
    iterationRequest,
    baseline,
    fixLoop,
  });

  const out: RegressionReport = {
    pipelineId: pipeline.id,
    baseline,
    fixLoop,
    status,
    headline,
    bakkalSummary,
  };

  if (isIteration) {
    out.parentPipelineId = readParentPipelineId(pipeline);
    if (iterationFilesChanged != null) out.iterationFilesChanged = iterationFilesChanged;
    if (iterationRequest) out.iterationRequest = iterationRequest;
  }

  return out;
}

// ─── Helpers ─────────────────────────────────────────────────

function isIterationChild(pipeline: PipelineState): boolean {
  return Boolean(readParentPipelineId(pipeline));
}

function readParentPipelineId(pipeline: PipelineState): string | undefined {
  const raw = (pipeline.intermediateState as Record<string, unknown> | undefined)?.parentPipelineId;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function readIterationRequest(pipeline: PipelineState): string | undefined {
  const raw = (pipeline.intermediateState as Record<string, unknown> | undefined)?.iterationRequest;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function extractBaseline(pipeline: PipelineState | undefined): RegressionBaseline | null {
  const ts = pipeline?.traceOutput?.testSummary;
  if (!ts) return null;
  return {
    totalTests: ts.totalTests ?? 0,
    coveragePercentage: ts.coveragePercentage ?? 0,
    coveredCriteria: [...(ts.coveredCriteria ?? [])],
    uncoveredCriteria: [...(ts.uncoveredCriteria ?? [])],
  };
}

function buildFixLoop(
  pipeline: PipelineState | undefined,
  activityCount: number | undefined,
  succeeded: boolean | undefined
): RegressionFixLoop {
  const runs = Math.max(0, activityCount ?? 0);
  const triggered = runs > 0;
  // When the orchestrator did not pass an explicit success flag, infer
  // from the pipeline stage: `completed` after a FixLoop run means
  // tests_passed; `completed_partial` means the loop ran out without
  // success.
  const inferredSuccess = pipeline?.stage === 'completed';
  const succeededFinal = triggered ? (succeeded ?? inferredSuccess) : false;
  return {
    runs,
    triggered,
    succeeded: succeededFinal,
  };
}

function pickStatus(
  baseline: RegressionBaseline | null,
  fixLoop: RegressionFixLoop
): RegressionStatus {
  // Most-positive-last cascade:
  let status: RegressionStatus = 'no_baseline';
  if (baseline) {
    status = baseline.uncoveredCriteria.length > 0 ? 'degraded' : 'verified_baseline';
    if (fixLoop.triggered) {
      status = fixLoop.succeeded ? 'self_healed' : 'degraded';
    }
  }
  return status;
}

function buildHeadline(
  status: RegressionStatus,
  baseline: RegressionBaseline | null,
  fixLoop: RegressionFixLoop,
  iterationFilesChanged: number | null
): string {
  switch (status) {
    case 'verified_baseline': {
      const tests = baseline?.totalTests ?? 0;
      const coverage = baseline?.coveragePercentage ?? 0;
      if (iterationFilesChanged != null) {
        return `Doğrulanmış: ${tests} test, %${coverage} kapsam`;
      }
      return `Doğrulanmış baseline: ${tests} test, %${coverage} kapsam`;
    }
    case 'self_healed':
      return `Kendini düzeltti: FixLoop ${fixLoop.runs} kez çalıştı`;
    case 'degraded': {
      const uncovered = baseline?.uncoveredCriteria.length ?? 0;
      return `Eksik kapsam: ${uncovered} kriter dışarıda`;
    }
    case 'no_baseline':
    default:
      return 'Test taban çizgisi yok';
  }
}

function buildBakkalSummary(args: {
  isIteration: boolean;
  iterationFilesChanged: number | null;
  iterationRequest: string | undefined;
  baseline: RegressionBaseline | null;
  fixLoop: RegressionFixLoop;
}): string {
  const { isIteration, iterationFilesChanged, baseline, fixLoop } = args;
  const sentences: string[] = [];

  if (isIteration) {
    const fileCount = iterationFilesChanged ?? 0;
    sentences.push(`Bu değişiklik ${fileCount} dosyaya dokundu.`);
  }

  if (baseline) {
    sentences.push(
      `Projenin baseline güveni: ${baseline.totalTests} testle %${baseline.coveragePercentage} kapsam.`
    );
    if (baseline.uncoveredCriteria.length > 0) {
      sentences.push(`${baseline.uncoveredCriteria.length} kabul kriteri hâlâ test dışında.`);
    }
  } else {
    sentences.push('Projenin henüz bir test taban çizgisi yok.');
  }

  if (fixLoop.triggered) {
    const verb = fixLoop.succeeded ? 'kendini düzeltti' : 'düzelmeye çalıştı ama başaramadı';
    sentences.push(`AKIS başlangıçta ${fixLoop.runs} kez ${verb}.`);
  }

  return sentences.join(' ');
}
