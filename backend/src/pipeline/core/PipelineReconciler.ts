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
import type { PipelineStage } from './contracts/PipelineTypes.js';
import { createPipelineError, PipelineErrorCode } from './contracts/PipelineErrors.js';
import { logger } from '../../lib/logger.js';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;    // 5 minutes
const STUCK_THRESHOLD_MS = 15 * 60 * 1000;   // 15 minutes

const RUNNING_STAGES: PipelineStage[] = [
  'scribe_generating',
  'scribe_clarifying', // only if genuinely abandoned (user never answered)
  'proto_building',
  'trace_testing',
];

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
    logger.info(`[Reconciler] Started (interval: ${SWEEP_INTERVAL_MS / 1000}s, threshold: ${STUCK_THRESHOLD_MS / 1000}s)`);
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

    const stuckPipelines = await (this.store as PipelineStore & {
      listStuck(stages: PipelineStage[], olderThan: Date): Promise<Array<{ id: string; stage: PipelineStage; updatedAt: Date }>>;
    }).listStuck(RUNNING_STAGES, threshold);

    for (const p of stuckPipelines) {
      try {
        const stuckMinutes = Math.round((now - p.updatedAt.getTime()) / 60_000);
        const error = createPipelineError(
          PipelineErrorCode.PIPELINE_TIMEOUT,
          `Pipeline ${p.stage} aşamasında ${stuckMinutes} dakikadır yanıt vermiyor. Otomatik olarak durduruldu.`,
        );
        await this.store.update(p.id, { stage: 'failed', error });
        recovered++;
        logger.warn(`[Reconciler] Recovered stuck pipeline ${p.id} (was ${p.stage} for ${stuckMinutes}min)`);
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
