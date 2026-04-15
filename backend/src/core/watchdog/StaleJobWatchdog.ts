import { db } from '../../db/client.js';
import { jobs } from '../../db/schema.js';
import { eq, and, lt } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';

const CHECK_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MINUTES = 15;

export class StaleJobWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.timer) return;
    logger.info('[StaleJobWatchdog] Started, checking every 60s for jobs stale > 15min');
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('[StaleJobWatchdog] Stopped');
    }
  }

  private async check(): Promise<void> {
    try {
      const threshold = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60_000);

      const staleJobs = await db
        .select({ id: jobs.id, type: jobs.type, updatedAt: jobs.updatedAt })
        .from(jobs)
        .where(
          and(
            eq(jobs.state, 'running'),
            lt(jobs.updatedAt, threshold)
          )
        );

      for (const stale of staleJobs) {
        logger.warn(`[StaleJobWatchdog] Marking stale job ${stale.id} (type=${stale.type}, lastUpdate=${stale.updatedAt.toISOString()})`);
        await db
          .update(jobs)
          .set({
            state: 'failed',
            error: 'Job timed out (stale)',
            errorCode: 'JOB_STALE_TIMEOUT',
            errorMessage: `Job was running for more than ${STALE_THRESHOLD_MINUTES} minutes without updates`,
            updatedAt: new Date(),
          })
          .where(eq(jobs.id, stale.id));
      }

      if (staleJobs.length > 0) {
        logger.info(`[StaleJobWatchdog] Cleaned up ${staleJobs.length} stale job(s)`);
      }
    } catch (error) {
      logger.error(`[StaleJobWatchdog] Check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
