// RegressionService — orchestrates the data lookups needed to assemble a
// RegressionReport for a single pipeline. The actual report shape is
// produced by the pure `buildRegressionReport` factory; this class is
// the thin boundary that talks to the store + activity log.
//
// Iteration mode in v0.7.x does NOT re-run Trace (orchestrator line
// ~1086). So when the requested pipeline is an iteration child we read
// the baseline + FixLoop signals from the parent pipeline; the child's
// own contribution is the `iterationFilesChanged` count surfaced via
// `protoOutput.files`.

import type { PipelineState } from '../contracts/PipelineTypes.js';
import type { AgentActivitySelect } from '../../db/agent-activity-schema.js';
import { buildRegressionReport } from './regressionFactory.js';
import type { RegressionReport } from './RegressionTypes.js';

export interface RegressionStoreLike {
  getById(id: string): Promise<PipelineState | null>;
}

export interface RegressionActivityServiceLike {
  listByPipeline(pipelineId: string, limit?: number): Promise<AgentActivitySelect[]>;
}

/**
 * Minimal slice of the in-memory metrics service. We only need the
 * `fix_loop` stage records to compute run count + success — exposing
 * the full `PipelineRunMetric` would tightly couple this service to
 * the metrics module shape.
 */
export interface RegressionMetricsLike {
  getRunMetrics(pipelineId: string):
    | {
        stages: Array<{
          stageName: string;
          success: boolean;
          metadata: Record<string, unknown>;
        }>;
      }
    | undefined;
}

export interface RegressionServiceDeps {
  store: RegressionStoreLike;
  activityService?: RegressionActivityServiceLike;
  metricsService?: RegressionMetricsLike;
}

/**
 * Activity action prefixes that indicate a FixLoop iteration was
 * recorded. The orchestrator emits these via metricsService when a
 * FixLoop run terminates; we count them as a proxy for "AKIS düzeltti
 * mi?" without depending on the in-memory metricsService instance
 * (which is wiped on restart).
 */
const FIX_LOOP_ACTIONS = ['fix_loop_iteration', 'iteration_applied'];

export class RegressionService {
  constructor(private deps: RegressionServiceDeps) {}

  /**
   * Build a RegressionReport for the given pipeline. Throws when the
   * pipeline does not exist; callers (route layer) should translate to
   * the standard 404 response.
   */
  async getReport(pipelineId: string): Promise<RegressionReport> {
    const pipeline = await this.deps.store.getById(pipelineId);
    if (!pipeline) {
      throw new Error(`Pipeline ${pipelineId} not found`);
    }

    const parentPipelineId = readParentPipelineId(pipeline);
    const isIteration = Boolean(parentPipelineId);
    const parentPipeline = parentPipelineId
      ? ((await this.deps.store.getById(parentPipelineId)) ?? undefined)
      : undefined;

    // For iteration children we want the baseline pipeline's FixLoop
    // history — that's where the "AKIS düzeltti mi?" signal lives. The
    // iteration child itself never runs FixLoop today.
    const fixLoopPipelineId = isIteration ? (parentPipelineId as string) : pipelineId;
    const { fixLoopActivityCount, fixLoopSucceeded } =
      await this.collectFixLoopSignal(fixLoopPipelineId);

    return buildRegressionReport({
      pipeline,
      parentPipeline,
      fixLoopActivityCount,
      fixLoopSucceeded,
    });
  }

  private async collectFixLoopSignal(pipelineId: string): Promise<{
    fixLoopActivityCount: number;
    fixLoopSucceeded?: boolean;
  }> {
    // Preferred: in-memory metrics service. The orchestrator records
    // `fix_loop` stages with `iterationCount` + `terminationReason` in
    // metadata, which gives us both run count and success in one pass.
    const metrics = this.deps.metricsService?.getRunMetrics(pipelineId);
    if (metrics) {
      const fixStages = metrics.stages.filter((s) => s.stageName === 'fix_loop');
      if (fixStages.length > 0) {
        const last = fixStages[fixStages.length - 1]!;
        const iterationCount =
          typeof last.metadata.iterationCount === 'number'
            ? (last.metadata.iterationCount as number)
            : fixStages.length;
        return {
          fixLoopActivityCount: iterationCount,
          fixLoopSucceeded: last.success === true,
        };
      }
    }

    // Fallback: count fix-loop activity-log records. Less precise on
    // success but durable across restarts.
    const activityService = this.deps.activityService;
    if (!activityService) return { fixLoopActivityCount: 0 };
    const activities = await safeListByPipeline(activityService, pipelineId);
    const fixLoopActivities = activities.filter((a) => FIX_LOOP_ACTIONS.includes(a.action ?? ''));
    return { fixLoopActivityCount: fixLoopActivities.length };
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function readParentPipelineId(pipeline: PipelineState): string | undefined {
  const raw = (pipeline.intermediateState as Record<string, unknown> | undefined)?.parentPipelineId;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

async function safeListByPipeline(
  activityService: RegressionActivityServiceLike,
  pipelineId: string
): Promise<AgentActivitySelect[]> {
  try {
    return await activityService.listByPipeline(pipelineId, 200);
  } catch {
    // Activity log is non-essential — degrade gracefully. The report
    // will still surface baseline + status; only the FixLoop run count
    // becomes 0.
    return [];
  }
}
