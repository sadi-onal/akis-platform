/**
 * Unit tests for the live token-usage helpers used by the chat token gauge
 * (issue #438):
 *
 *  - `PipelineOrchestrator.createTokenCallback` accumulates per-call usage
 *    in-memory.
 *  - `PipelineOrchestrator.getLiveTokenUsage` returns DB metric + accumulator
 *    combined, so the gauge stays current mid-stage (before the terminal
 *    `flushTokenUsage`).
 *  - `getContextWindow` resolves model aliases and prefix-matches.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PipelineOrchestrator } from '../../src/pipeline/core/orchestrator/PipelineOrchestrator.js';
import { getContextWindow, DEFAULT_CONTEXT_WINDOW } from '../../src/services/ai/pricing.js';

function makeOrchestrator(): PipelineOrchestrator {
  // The store isn't needed for these helpers — they operate on the in-memory
  // accumulator and the caller-supplied `persistedMetrics` object. A minimal
  // stub satisfies the constructor.
  const stubStore = {
    create: async () => ({ id: 'stub' } as never),
    getById: async () => null,
    update: async () => ({ id: 'stub' } as never),
    listByUser: async () => [],
    listChildren: async () => [],
  };
  return new PipelineOrchestrator(stubStore as never);
}

describe('PipelineOrchestrator token tracking', () => {
  it('createTokenCallback accumulates across calls for one pipeline', () => {
    const orch = makeOrchestrator();
    const cb = orch.createTokenCallback('p1');
    cb({ inputTokens: 100, outputTokens: 50 });
    cb({ inputTokens: 200, outputTokens: 80 });

    const live = orch.getLiveTokenUsage('p1');
    assert.equal(live.inputTokens, 300);
    assert.equal(live.outputTokens, 130);
    assert.equal(live.totalTokens, 430);
  });

  it('getLiveTokenUsage sums persisted metrics with accumulator', () => {
    const orch = makeOrchestrator();
    const cb = orch.createTokenCallback('p2');
    cb({ inputTokens: 100, outputTokens: 50 });

    const live = orch.getLiveTokenUsage('p2', {
      inputTokens: 900,
      outputTokens: 450,
      totalTokens: 1350,
    });
    assert.equal(live.inputTokens, 1000);
    assert.equal(live.outputTokens, 500);
    assert.equal(live.totalTokens, 1500);
  });

  it('getLiveTokenUsage returns zeros when pipeline has no accumulator or metrics', () => {
    const orch = makeOrchestrator();
    const live = orch.getLiveTokenUsage('never-seen');
    assert.equal(live.inputTokens, 0);
    assert.equal(live.outputTokens, 0);
    assert.equal(live.totalTokens, 0);
  });

  it('keeps accumulators disjoint across pipelines', () => {
    const orch = makeOrchestrator();
    const cbA = orch.createTokenCallback('p-a');
    const cbB = orch.createTokenCallback('p-b');
    cbA({ inputTokens: 10, outputTokens: 5 });
    cbB({ inputTokens: 100, outputTokens: 50 });

    assert.equal(orch.getLiveTokenUsage('p-a').totalTokens, 15);
    assert.equal(orch.getLiveTokenUsage('p-b').totalTokens, 150);
  });
});

describe('getContextWindow', () => {
  it('returns Anthropic 200k for known Claude models', () => {
    assert.equal(getContextWindow('claude-sonnet-4-6'), 200_000);
    assert.equal(getContextWindow('claude-sonnet-4-20250514'), 200_000);
    assert.equal(getContextWindow('claude-haiku-4-5'), 200_000);
    assert.equal(getContextWindow('claude-opus-4-20250514'), 200_000);
  });

  it('returns OpenAI GPT-4o 128k for gpt-4o family', () => {
    assert.equal(getContextWindow('gpt-4o'), 128_000);
    assert.equal(getContextWindow('gpt-4o-mini'), 128_000);
  });

  it('returns GPT-4.1 1M window for long-context models', () => {
    assert.equal(getContextWindow('gpt-4.1'), 1_047_576);
    assert.equal(getContextWindow('gpt-4.1-mini'), 1_047_576);
    assert.equal(getContextWindow('gpt-4.1-nano'), 1_047_576);
  });

  it('resolves model aliases', () => {
    // claude-sonnet-4-6 is an alias of claude-sonnet-4-20250514 in pricing.ts
    assert.equal(getContextWindow('claude-sonnet-4-6'), getContextWindow('claude-sonnet-4-20250514'));
  });

  it('falls back to DEFAULT_CONTEXT_WINDOW for unknown models', () => {
    assert.equal(getContextWindow('some-future-model-xyz'), DEFAULT_CONTEXT_WINDOW);
    assert.equal(DEFAULT_CONTEXT_WINDOW, 128_000);
  });

  it('prefix-matches versioned model names', () => {
    // Versioned Claude Haiku that shares prefix with the canonical key.
    assert.equal(getContextWindow('claude-haiku-4-5-20251001-v2'), 200_000);
  });
});
