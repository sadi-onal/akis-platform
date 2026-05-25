/**
 * Metrics-related helper functions extracted from PipelineOrchestrator.
 *
 * Kademe 1 refactor -- zero behavior change, pure mechanical extraction.
 * Token accumulators and stage-start timestamps are passed as explicit Maps.
 */
import type { PipelineMetrics } from '../../contracts/PipelineTypes.js';
import type { PipelineStore } from '../PipelineOrchestrator.js';
import type { TokenUsageCallback } from '../../pipeline-factory.js';
import { logger } from '../../../../lib/logger.js';

// ── Token accumulator type (matches the in-memory shape) ────

export interface TokenAccumulator {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  hasCost: boolean;
}

// ── Token usage functions ────────────────────────────────────

/** Create a callback that accumulates token + cost usage for a specific pipeline. */
export function createTokenCallback(
  pipelineId: string,
  tokenAccumulators: Map<string, TokenAccumulator>
): TokenUsageCallback {
  return (usage) => {
    const acc = tokenAccumulators.get(pipelineId) ?? {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      hasCost: false,
    };
    acc.inputTokens += usage.inputTokens;
    acc.outputTokens += usage.outputTokens;
    if (typeof usage.estimatedCostUsd === 'number' && Number.isFinite(usage.estimatedCostUsd)) {
      acc.estimatedCostUsd += usage.estimatedCostUsd;
      acc.hasCost = true;
    }
    tokenAccumulators.set(pipelineId, acc);
  };
}

/** Flush accumulated token usage to the pipeline's metrics in the DB. */
export async function flushTokenUsage(
  pipelineId: string,
  tokenAccumulators: Map<string, TokenAccumulator>,
  store: PipelineStore
): Promise<void> {
  const acc = tokenAccumulators.get(pipelineId);
  if (!acc || (acc.inputTokens === 0 && acc.outputTokens === 0)) return;

  try {
    const pipeline = await store.getById(pipelineId);
    if (!pipeline) return;
    const metrics = pipeline.metrics;
    const updatedMetrics: PipelineMetrics = {
      ...metrics,
      inputTokens: (metrics.inputTokens ?? 0) + acc.inputTokens,
      outputTokens: (metrics.outputTokens ?? 0) + acc.outputTokens,
      totalTokens: (metrics.totalTokens ?? 0) + acc.inputTokens + acc.outputTokens,
    };
    const persistedCost = metrics.estimatedCost ?? 0;
    if (acc.hasCost || persistedCost > 0) {
      const sum = persistedCost + acc.estimatedCostUsd;
      updatedMetrics.estimatedCost = Number(sum.toFixed(6));
    }
    await store.update(pipelineId, { metrics: updatedMetrics });
    tokenAccumulators.delete(pipelineId);
  } catch (err) {
    logger.warn({ err, pipelineId }, '[Pipeline] Token usage flush failed (non-fatal)');
  }
}

/**
 * Return the live token usage for a pipeline by summing the DB-persisted
 * metrics with any in-memory accumulator that has not been flushed yet.
 */
export function getLiveTokenUsage(
  pipelineId: string,
  tokenAccumulators: Map<string, TokenAccumulator>,
  persistedMetrics?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
): { inputTokens: number; outputTokens: number; totalTokens: number } {
  const persisted = persistedMetrics ?? {};
  const acc = tokenAccumulators.get(pipelineId);
  const accInput = acc?.inputTokens ?? 0;
  const accOutput = acc?.outputTokens ?? 0;
  const inputTokens = (persisted.inputTokens ?? 0) + accInput;
  const outputTokens = (persisted.outputTokens ?? 0) + accOutput;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

// ── Stage timing functions ───────────────────────────────────

/** Record the start timestamp for a pipeline stage. Returns the epoch ms. */
export function markStageStarted(
  pipelineId: string,
  stage: 'scribe' | 'proto' | 'trace',
  stageStartedAt: Map<string, number>
): number {
  const now = Date.now();
  stageStartedAt.set(`${pipelineId}:${stage}`, now);
  return now;
}

/**
 * Compute and clear `durationMs` for the given stage. One-shot -- the
 * tracker entry is deleted after read so a stale value cannot leak into
 * a later completion.
 */
export function getStageDurationMs(
  pipelineId: string,
  stage: 'scribe' | 'proto' | 'trace',
  stageStartedAt: Map<string, number>
): number | undefined {
  const startedAt = stageStartedAt.get(`${pipelineId}:${stage}`);
  if (!startedAt) return undefined;
  const duration = Date.now() - startedAt;
  stageStartedAt.delete(`${pipelineId}:${stage}`);
  return duration >= 0 ? duration : undefined;
}

/**
 * Remove all stage-start entries for a pipeline. Called on terminal
 * transitions (failure, cancellation) so the in-memory map doesn't
 * accumulate dead keys.
 */
export function clearStageStarts(pipelineId: string, stageStartedAt: Map<string, number>): void {
  const prefix = `${pipelineId}:`;
  for (const key of stageStartedAt.keys()) {
    if (key.startsWith(prefix)) {
      stageStartedAt.delete(key);
    }
  }
}
