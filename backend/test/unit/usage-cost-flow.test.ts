/**
 * PR-V (Settings → Usage tab): verifies that `pipelines.metrics.estimatedCost`
 * is populated alongside the existing token counters as AI calls flow through
 * the orchestrator.
 *
 * Before this fix the JSONB field was never written, so the
 * `/api/usage/current-month` query SUM'd to 0 and the Usage tab always showed
 * "$0.00 tahmini maliyet" — even after the user had consumed real tokens.
 *
 * The contract under test:
 *   1. `PipelineOrchestrator.createTokenCallback` accepts an optional
 *      `estimatedCostUsd` per call.
 *   2. `flushTokenUsage()` writes the accumulated cost to
 *      `pipelines.metrics.estimatedCost` (preserving the field name expected
 *      by the SQL in `backend/src/api/usage.ts`).
 *   3. The accumulator is per-pipeline and resets after flush.
 *   4. Costs add together across multiple AI calls in the same pipeline (so
 *      Scribe → Proto → Trace each contributes to a single running total).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PipelineOrchestrator } from '../../src/pipeline/core/orchestrator/PipelineOrchestrator.js';

interface CapturedUpdate {
  id: string;
  patch: { metrics?: Record<string, unknown> } & Record<string, unknown>;
}

function makeOrchestratorWithCapture(initialMetrics: Record<string, unknown> = {}): {
  orch: PipelineOrchestrator;
  updates: CapturedUpdate[];
} {
  const updates: CapturedUpdate[] = [];
  const stubStore = {
    create: async () => ({ id: 'stub' }) as never,
    getById: async (id: string) =>
      ({
        id,
        metrics: { ...initialMetrics },
      }) as never,
    update: async (id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch: patch as CapturedUpdate['patch'] });
      return { id } as never;
    },
    listByUser: async () => [],
    listChildren: async () => [],
  };
  const orch = new PipelineOrchestrator(stubStore as never);
  return { orch, updates };
}

describe('PipelineOrchestrator cost tracking (PR-V settings/usage)', () => {
  it('createTokenCallback captures estimatedCostUsd alongside tokens', () => {
    const { orch } = makeOrchestratorWithCapture();
    const cb = orch.createTokenCallback('p-cost-1');
    cb({ inputTokens: 1000, outputTokens: 200, estimatedCostUsd: 0.0125 });
    cb({ inputTokens: 500, outputTokens: 100, estimatedCostUsd: 0.0075 });

    // Live usage reflects token totals from the same accumulator
    const live = orch.getLiveTokenUsage('p-cost-1');
    assert.equal(live.inputTokens, 1500);
    assert.equal(live.outputTokens, 300);
    assert.equal(live.totalTokens, 1800);
  });

  it('flushTokenUsage writes metrics.estimatedCost to the store', async () => {
    const { orch, updates } = makeOrchestratorWithCapture();
    const cb = orch.createTokenCallback('p-cost-2');
    cb({ inputTokens: 1000, outputTokens: 200, estimatedCostUsd: 0.0125 });
    cb({ inputTokens: 500, outputTokens: 100, estimatedCostUsd: 0.0075 });

    // Drive the same private flush path the orchestrator hits when each
    // stage finalizes — exposed via a small test hook (see below).
    await (orch as unknown as { flushTokenUsage(id: string): Promise<void> }).flushTokenUsage(
      'p-cost-2'
    );

    assert.equal(updates.length, 1, 'expected a single store.update call');
    const metrics = updates[0].patch.metrics as Record<string, unknown>;
    assert.equal(metrics.inputTokens, 1500);
    assert.equal(metrics.outputTokens, 300);
    assert.equal(metrics.totalTokens, 1800);
    // 0.0125 + 0.0075 = 0.02 — must land in the JSONB field the usage SQL reads.
    assert.equal(metrics.estimatedCost, 0.02);
  });

  it('flushTokenUsage adds to any persisted cost (cross-stage accumulation)', async () => {
    // Simulate the Proto flush running after Scribe already persisted some
    // metrics — costs must accumulate, not overwrite.
    const { orch, updates } = makeOrchestratorWithCapture({
      inputTokens: 800,
      outputTokens: 200,
      totalTokens: 1000,
      estimatedCost: 0.05,
    });
    const cb = orch.createTokenCallback('p-cost-3');
    cb({ inputTokens: 400, outputTokens: 100, estimatedCostUsd: 0.025 });

    await (orch as unknown as { flushTokenUsage(id: string): Promise<void> }).flushTokenUsage(
      'p-cost-3'
    );

    const metrics = updates[0].patch.metrics as Record<string, unknown>;
    assert.equal(metrics.inputTokens, 1200);
    assert.equal(metrics.outputTokens, 300);
    assert.equal(metrics.totalTokens, 1500);
    // 0.05 (persisted) + 0.025 (new) = 0.075
    assert.equal(metrics.estimatedCost, 0.075);
  });

  it('callbacks without estimatedCostUsd still flush tokens (graceful fallback)', async () => {
    // Mock providers / unknown models won't supply a cost. The orchestrator
    // should still write tokens; estimatedCost stays absent (or 0) so the
    // usage endpoint falls back to its per-token estimator.
    const { orch, updates } = makeOrchestratorWithCapture();
    const cb = orch.createTokenCallback('p-cost-4');
    cb({ inputTokens: 100, outputTokens: 50 });

    await (orch as unknown as { flushTokenUsage(id: string): Promise<void> }).flushTokenUsage(
      'p-cost-4'
    );

    assert.equal(updates.length, 1);
    const metrics = updates[0].patch.metrics as Record<string, unknown>;
    assert.equal(metrics.inputTokens, 100);
    assert.equal(metrics.outputTokens, 50);
    // estimatedCost should not be a positive bogus number when no cost was
    // ever reported. Either absent or 0 is acceptable.
    const cost = (metrics.estimatedCost as number | undefined) ?? 0;
    assert.equal(cost, 0);
  });

  it('cost accumulators stay disjoint across pipelines', async () => {
    const { orch, updates } = makeOrchestratorWithCapture();
    const cbA = orch.createTokenCallback('p-cost-A');
    const cbB = orch.createTokenCallback('p-cost-B');
    cbA({ inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.01 });
    cbB({ inputTokens: 200, outputTokens: 100, estimatedCostUsd: 0.05 });

    const flush = (orch as unknown as { flushTokenUsage(id: string): Promise<void> })
      .flushTokenUsage;
    await flush.call(orch, 'p-cost-A');
    await flush.call(orch, 'p-cost-B');

    assert.equal(updates.length, 2);
    const aMetrics = updates.find((u) => u.id === 'p-cost-A')!.patch.metrics as Record<
      string,
      unknown
    >;
    const bMetrics = updates.find((u) => u.id === 'p-cost-B')!.patch.metrics as Record<
      string,
      unknown
    >;
    assert.equal(aMetrics.estimatedCost, 0.01);
    assert.equal(bMetrics.estimatedCost, 0.05);
  });
});
