/**
 * Pipeline metrics type definitions.
 *
 * These types capture per-stage and per-run timing, success/failure,
 * and agent-specific metadata for every pipeline execution.
 */

export interface StageMetric {
  stageName: string;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  success: boolean;
  /** Agent-specific metrics (e.g. Scribe: confidenceScore, Proto: filesGenerated) */
  metadata: Record<string, unknown>;
}

export interface PipelineRunMetric {
  pipelineId: string;
  startedAt: Date;
  completedAt?: Date;
  totalDurationMs?: number;
  stages: StageMetric[];
  finalStatus: string;
  /** Aggregate LLM token usage across all stages */
  totalTokensUsed?: number;
  /** Estimated LLM API cost in USD */
  estimatedCostUsd?: number;
}

export interface MetricsSummary {
  totalRuns: number;
  successRate: number;
  avgDurationMs: number;
  avgScribeConfidence: number;
  avgCriticScore: number;
  fixLoopStats: {
    avgIterations: number;
    fixSuccessRate: number;
  };
}
