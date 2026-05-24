/**
 * PipelineReconciler — periodic sweep for stuck pipelines.
 *
 * Pipelines can get stuck in running states (scribe_generating, proto_building,
 * trace_testing) if failPipeline() itself fails (e.g., DB outage) or if the
 * process crashes mid-execution. The reconciler runs every SWEEP_INTERVAL_MS,
 * finds pipelines stuck longer than STUCK_THRESHOLD_MS, and transitions them
 * to 'failed' so users can retry.
 */
import type { PipelineStore } from './orchestrator/PipelineOrchestrator.js';
import type { PipelineStage, ScribeMessageType } from './contracts/PipelineTypes.js';
import { createPipelineError, PipelineErrorCode } from './contracts/PipelineErrors.js';
import { stageLabelTR } from './utils/stageLabels.js';
import { logger } from '../../lib/logger.js';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STUCK_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

const RUNNING_STAGES: PipelineStage[] = [
  'scribe_generating',
  'scribe_clarifying', // only if genuinely abandoned (user never answered)
  'critic_reviewing_spec',
  'critic_reviewing_code',
  'proto_building',
  'trace_testing',
  'fix_loop_iteration',
  'ci_running',
];

type StuckEventKind = 'trace_failed' | 'scribe_failed' | 'proto_failed';
const eventKindByStage: Partial<Record<PipelineStage, StuckEventKind>> = {
  trace_testing: 'trace_failed',
  scribe_generating: 'scribe_failed',
  scribe_clarifying: 'scribe_failed',
  proto_building: 'proto_failed',
};

function buildStuckEvent(
  kind: StuckEventKind,
  stage: PipelineStage,
  prevConversation: ScribeMessageType[],
  stuckMinutes: number
): ScribeMessageType {
  const label = stageLabelTR(stage);
  const errorMessage = `${label} ${stuckMinutes} dakika boyunca yanıt vermedi. Otomatik olarak durduruldu.`;
  const timestamp = new Date().toISOString();
  if (kind === 'trace_failed') {
    const iteration =
      prevConversation.filter((m: ScribeMessageType) => m.type === 'trace_completed').length + 1;
    return {
      type: 'trace_failed',
      content: { iteration, errorCode: 'PIPELINE_TIMEOUT', errorMessage, recoveryAction: 'retry' },
      timestamp,
    };
  }
  if (kind === 'proto_failed') {
    const iteration =
      prevConversation.filter((m: ScribeMessageType) => m.type === 'proto_completed').length + 1;
    return {
      type: 'proto_failed',
      content: { iteration, errorCode: 'PIPELINE_TIMEOUT', errorMessage, recoveryAction: 'retry' },
      timestamp,
    };
  }
  // scribe_failed
  return {
    type: 'scribe_failed',
    content: {
      stageStuck: stage,
      errorCode: 'PIPELINE_TIMEOUT',
      errorMessage,
      recoveryAction: 'retry',
    },
    timestamp,
  };
}

export class PipelineReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private store: PipelineStore) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep().catch((err) => {
        logger.error({ err }, '[Reconciler] Sweep failed');
      });
    }, SWEEP_INTERVAL_MS);
    logger.info(
      `[Reconciler] Started (interval: ${SWEEP_INTERVAL_MS / 1000}s, threshold: ${STUCK_THRESHOLD_MS / 1000}s)`
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('[Reconciler] Stopped');
    }
  }

  /** Exposed for testing — runs one reconciliation pass. */
  async sweep(): Promise<number> {
    const now = Date.now();
    const threshold = new Date(now - STUCK_THRESHOLD_MS);
    let recovered = 0;

    // listByUser is the only query method available on PipelineStore.
    // For reconciliation, we need a broader query. Rather than expanding
    // the interface, we use a brute-force approach: iterate all users.
    // In practice, stuck pipelines are rare, so this is acceptable.
    // A more efficient approach would add a `listStuck()` to PipelineStore.
    //
    // For now, the reconciler is disabled if no listStuck method is available.
    if (!('listStuck' in this.store)) {
      return 0;
    }

    const stuckPipelines = await (
      this.store as PipelineStore & {
        listStuck(
          stages: PipelineStage[],
          olderThan: Date
        ): Promise<Array<{ id: string; stage: PipelineStage; updatedAt: Date }>>;
      }
    ).listStuck(RUNNING_STAGES, threshold);

    for (const p of stuckPipelines) {
      try {
        const stuckMinutes = Math.round((now - p.updatedAt.getTime()) / 60_000);
        const error = createPipelineError(
          PipelineErrorCode.PIPELINE_TIMEOUT,
          `Pipeline ${p.stage} aşamasında ${stuckMinutes} dakikadır yanıt vermiyor. Otomatik olarak durduruldu.`
        );

        // Re-fetch full state so we can append the chat event atomically with the failure transition.
        const full = await this.store.getById(p.id);
        if (!full) {
          logger.warn(`[Reconciler] Pipeline ${p.id} disappeared between listStuck and get`);
          continue;
        }

        // Compute the per-stage chat event from the stage→event mapping.
        const eventKind = eventKindByStage[p.stage];
        const conversation = eventKind
          ? [
              ...full.scribeConversation,
              buildStuckEvent(eventKind, p.stage, full.scribeConversation, stuckMinutes),
            ]
          : full.scribeConversation;

        await this.store.update(p.id, { stage: 'failed', error, scribeConversation: conversation });
        recovered++;
        logger.warn(
          `[Reconciler] Recovered stuck pipeline ${p.id} (was ${p.stage} for ${stuckMinutes}min)`
        );
      } catch (err) {
        logger.error({ err, pipelineId: p.id }, '[Reconciler] Failed to recover pipeline');
      }
    }

    if (recovered > 0) {
      logger.info(`[Reconciler] Recovered ${recovered} stuck pipeline(s)`);
    }
    return recovered;
  }
}
