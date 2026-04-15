/**
 * In-memory pipeline metrics collection service.
 *
 * Tracks per-stage timing and metadata for every pipeline run,
 * and provides aggregate summaries across all recorded runs.
 */

import type { StageMetric, PipelineRunMetric, MetricsSummary } from './MetricTypes.js';

interface PendingStage {
  stageName: string;
  startedAt: Date;
}

export class PipelineMetricsService {
  private runs = new Map<string, PipelineRunMetric>();
  private pending = new Map<string, PendingStage>();

  /** Build a composite key for the pending-stage map. */
  private pendingKey(pipelineId: string, stageName: string): string {
    return `${pipelineId}::${stageName}`;
  }

  /** Ensure a PipelineRunMetric record exists for the given pipeline. */
  private ensureRun(pipelineId: string): PipelineRunMetric {
    let run = this.runs.get(pipelineId);
    if (!run) {
      run = {
        pipelineId,
        startedAt: new Date(),
        stages: [],
        finalStatus: 'in_progress',
      };
      this.runs.set(pipelineId, run);
    }
    return run;
  }

  /**
   * Start timing a stage. Creates the pipeline run record if it does not exist.
   */
  startStage(pipelineId: string, stageName: string): void {
    this.ensureRun(pipelineId);

    const key = this.pendingKey(pipelineId, stageName);
    this.pending.set(key, {
      stageName,
      startedAt: new Date(),
    });
  }

  /**
   * Stop timing a stage and record the result.
   *
   * @throws Error if startStage was not called for this pipeline/stage pair.
   */
  endStage(
    pipelineId: string,
    stageName: string,
    success: boolean,
    metadata: Record<string, unknown> = {},
  ): void {
    const key = this.pendingKey(pipelineId, stageName);
    const pendingStage = this.pending.get(key);

    if (!pendingStage) {
      throw new Error(
        `Cannot end stage "${stageName}" for pipeline "${pipelineId}": stage was never started.`,
      );
    }

    this.pending.delete(key);

    const completedAt = new Date();
    const durationMs = completedAt.getTime() - pendingStage.startedAt.getTime();

    const stageMetric: StageMetric = {
      stageName,
      startedAt: pendingStage.startedAt,
      completedAt,
      durationMs,
      success,
      metadata,
    };

    const run = this.ensureRun(pipelineId);
    run.stages.push(stageMetric);

    // Update run-level timing
    run.completedAt = completedAt;
    run.totalDurationMs = completedAt.getTime() - run.startedAt.getTime();

    // Update final status based on stage success
    if (!success) {
      run.finalStatus = 'failed';
    } else {
      run.finalStatus = 'completed';
    }
  }

  /**
   * Retrieve metrics for a specific pipeline run.
   */
  getRunMetrics(pipelineId: string): PipelineRunMetric | undefined {
    return this.runs.get(pipelineId);
  }

  /**
   * Compute an aggregate summary across all recorded runs.
   */
  getSummary(): MetricsSummary {
    const allRuns = Array.from(this.runs.values());

    if (allRuns.length === 0) {
      return {
        totalRuns: 0,
        successRate: 0,
        avgDurationMs: 0,
        avgScribeConfidence: 0,
        avgCriticScore: 0,
        fixLoopStats: {
          avgIterations: 0,
          fixSuccessRate: 0,
        },
      };
    }

    const totalRuns = allRuns.length;

    // Success rate
    const successCount = allRuns.filter((r) => r.finalStatus === 'completed').length;
    const successRate = successCount / totalRuns;

    // Average duration (only for runs that have a totalDurationMs)
    const durations = allRuns
      .map((r) => r.totalDurationMs)
      .filter((d): d is number => d !== undefined);
    const avgDurationMs =
      durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

    // Average Scribe confidence
    const scribeStages = allRuns.flatMap((r) =>
      r.stages.filter((s) => s.stageName === 'scribe'),
    );
    const confidenceValues = scribeStages
      .map((s) => s.metadata.confidenceScore)
      .filter((v): v is number => typeof v === 'number');
    const avgScribeConfidence =
      confidenceValues.length > 0
        ? confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length
        : 0;

    // Average Critic score
    const criticStages = allRuns.flatMap((r) =>
      r.stages.filter(
        (s) => s.stageName === 'critic_spec' || s.stageName === 'critic_code',
      ),
    );
    const criticScores = criticStages
      .map((s) => s.metadata.overallScore)
      .filter((v): v is number => typeof v === 'number');
    const avgCriticScore =
      criticScores.length > 0
        ? criticScores.reduce((a, b) => a + b, 0) / criticScores.length
        : 0;

    // Fix loop stats
    const fixLoopStages = allRuns.flatMap((r) =>
      r.stages.filter((s) => s.stageName === 'fix_loop'),
    );
    const iterationCounts = fixLoopStages
      .map((s) => s.metadata.iterationCount)
      .filter((v): v is number => typeof v === 'number');
    const avgIterations =
      iterationCounts.length > 0
        ? iterationCounts.reduce((a, b) => a + b, 0) / iterationCounts.length
        : 0;
    const fixSuccessCount = fixLoopStages.filter((s) => s.success).length;
    const fixSuccessRate =
      fixLoopStages.length > 0 ? fixSuccessCount / fixLoopStages.length : 0;

    return {
      totalRuns,
      successRate,
      avgDurationMs,
      avgScribeConfidence,
      avgCriticScore,
      fixLoopStats: {
        avgIterations,
        fixSuccessRate,
      },
    };
  }
}
