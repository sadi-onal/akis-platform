import type { AICallMetrics } from './AIService.js';

export type AITotals = {
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  /**
   * Anthropic prompt-cache aggregates (issue #436).
   * Zero when no call in the run used caching (or provider doesn't support it).
   */
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
};

export class AICallMetricsCollector {
  private totalDurationMs = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalTokens = 0;
  private totalEstimatedCostUsd = 0;
  private hasCost = false;
  private totalCacheCreationInputTokens = 0;
  private totalCacheReadInputTokens = 0;

  record(metrics: AICallMetrics): void {
    if (!metrics.success) {
      return;
    }

    if (typeof metrics.durationMs === 'number') {
      this.totalDurationMs += metrics.durationMs;
    }

    if (metrics.usage) {
      if (typeof metrics.usage.inputTokens === 'number') {
        this.totalInputTokens += metrics.usage.inputTokens;
      }
      if (typeof metrics.usage.outputTokens === 'number') {
        this.totalOutputTokens += metrics.usage.outputTokens;
      }
      if (typeof metrics.usage.totalTokens === 'number') {
        this.totalTokens += metrics.usage.totalTokens;
      }
      if (typeof metrics.usage.cacheCreationInputTokens === 'number') {
        this.totalCacheCreationInputTokens += metrics.usage.cacheCreationInputTokens;
      }
      if (typeof metrics.usage.cacheReadInputTokens === 'number') {
        this.totalCacheReadInputTokens += metrics.usage.cacheReadInputTokens;
      }
    }

    if (typeof metrics.estimatedCostUsd === 'number') {
      this.totalEstimatedCostUsd += metrics.estimatedCostUsd;
      this.hasCost = true;
    }
  }

  getTotals(): AITotals {
    return {
      totalDurationMs: this.totalDurationMs,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalTokens: this.totalTokens,
      estimatedCostUsd: this.hasCost ? Number(this.totalEstimatedCostUsd.toFixed(6)) : null,
      totalCacheCreationInputTokens: this.totalCacheCreationInputTokens,
      totalCacheReadInputTokens: this.totalCacheReadInputTokens,
    };
  }
}
