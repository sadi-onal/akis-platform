/**
 * Unit tests for Anthropic prompt caching (issue #436).
 *
 * Scope: verify that
 *   1. `buildCacheableSystemBlocks` attaches `cache_control: ephemeral` to
 *      long-enough system prompts, and falls back to a plain string for short
 *      prompts (below the break-even threshold for the 1.25x write multiplier).
 *   2. The multimodal request body wraps the system prompt in the same cache
 *      block but keeps user-turn images + text uncached.
 *   3. `parseAnthropicResponse` (via multimodalClient as a proxy surface)
 *      surfaces `cache_creation_input_tokens` + `cache_read_input_tokens` when
 *      Anthropic returns them.
 *   4. `AICallMetricsCollector` accumulates the two new cache-token pools.
 *   5. `estimateCostUsd` prices cache-writes at 1.25x and cache-reads at 0.10x
 *      against the model's normal input price.
 *   6. The env flag `ANTHROPIC_PROMPT_CACHING=false` is respected as a kill
 *      switch (production escape hatch).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCacheableSystemBlocks,
  type AnthropicSystemBlock,
} from '../../src/services/ai/AIService.js';
import { buildAnthropicMultimodalBody, callAnthropicMultimodal } from '../../src/services/ai/multimodalClient.js';
import type { AnthropicImageBlock } from '../../src/services/ai/multimodalClient.js';
import { AICallMetricsCollector } from '../../src/services/ai/ai-metrics.js';
import type { AICallMetrics } from '../../src/services/ai/AIService.js';
import {
  estimateCostUsd,
  ANTHROPIC_CACHE_WRITE_MULTIPLIER,
  ANTHROPIC_CACHE_READ_MULTIPLIER,
} from '../../src/services/ai/pricing.js';

const LONG_SYSTEM_PROMPT = 'SYSTEM. '.repeat(1000); // ≫ 4096 chars
const SHORT_SYSTEM_PROMPT = 'short system prompt';

const SAMPLE_IMAGE: AnthropicImageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
};

// ─── buildCacheableSystemBlocks ─────────────────────────────────────────────

describe('buildCacheableSystemBlocks (issue #436)', () => {
  const originalFlag = process.env.ANTHROPIC_PROMPT_CACHING;
  const originalMin = process.env.ANTHROPIC_CACHE_MIN_CHARS;

  beforeEach(() => {
    delete process.env.ANTHROPIC_PROMPT_CACHING;
    delete process.env.ANTHROPIC_CACHE_MIN_CHARS;
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.ANTHROPIC_PROMPT_CACHING;
    else process.env.ANTHROPIC_PROMPT_CACHING = originalFlag;
    if (originalMin === undefined) delete process.env.ANTHROPIC_CACHE_MIN_CHARS;
    else process.env.ANTHROPIC_CACHE_MIN_CHARS = originalMin;
  });

  it('attaches cache_control: ephemeral for long system prompts', () => {
    const result = buildCacheableSystemBlocks(LONG_SYSTEM_PROMPT);
    assert.ok(Array.isArray(result), 'expected array form for long prompt');
    const blocks = result as AnthropicSystemBlock[];
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'text');
    assert.equal(blocks[0].text, LONG_SYSTEM_PROMPT);
    assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' });
  });

  it('returns a plain string for short prompts (not worth the 1.25x write cost)', () => {
    const result = buildCacheableSystemBlocks(SHORT_SYSTEM_PROMPT);
    assert.equal(typeof result, 'string');
    assert.equal(result, SHORT_SYSTEM_PROMPT);
  });

  it('returns plain string when prompt is empty', () => {
    const result = buildCacheableSystemBlocks('');
    assert.equal(result, '');
  });

  it('respects ANTHROPIC_CACHE_MIN_CHARS for test control', () => {
    process.env.ANTHROPIC_CACHE_MIN_CHARS = '10';
    const result = buildCacheableSystemBlocks('this is above ten chars');
    assert.ok(Array.isArray(result));
  });

  it('ANTHROPIC_PROMPT_CACHING=false is a kill switch — always returns string', () => {
    process.env.ANTHROPIC_PROMPT_CACHING = 'false';
    const result = buildCacheableSystemBlocks(LONG_SYSTEM_PROMPT);
    assert.equal(typeof result, 'string');
    assert.equal(result, LONG_SYSTEM_PROMPT);
  });

  it('default (flag unset) treats as enabled', () => {
    const result = buildCacheableSystemBlocks(LONG_SYSTEM_PROMPT);
    assert.ok(Array.isArray(result));
  });
});

// ─── Anthropic request builder — cache_control placement ────────────────────

describe('buildAnthropicMultimodalBody — cache_control attachment', () => {
  const originalMin = process.env.ANTHROPIC_CACHE_MIN_CHARS;
  beforeEach(() => {
    // Low threshold so short test prompts trigger caching
    process.env.ANTHROPIC_CACHE_MIN_CHARS = '5';
  });
  afterEach(() => {
    if (originalMin === undefined) delete process.env.ANTHROPIC_CACHE_MIN_CHARS;
    else process.env.ANTHROPIC_CACHE_MIN_CHARS = originalMin;
  });

  it('attaches cache_control to the SYSTEM block, not the user-turn content', () => {
    const body = buildAnthropicMultimodalBody({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are Scribe. '.repeat(10),
      userText: 'User-turn content that changes each iteration',
      images: [SAMPLE_IMAGE],
    });

    // System side: array block with cache_control
    const system = body.system as unknown;
    assert.ok(Array.isArray(system), 'system must be array when caching active');
    const sysBlocks = system as AnthropicSystemBlock[];
    assert.equal(sysBlocks[0].type, 'text');
    assert.deepEqual(sysBlocks[0].cache_control, { type: 'ephemeral' });

    // User side: images + text, NO cache_control on any block
    const messages = body.messages as Array<{ role: string; content: unknown[] }>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    const userBlocks = messages[0].content as Array<Record<string, unknown>>;
    for (const block of userBlocks) {
      assert.ok(
        !('cache_control' in block),
        `user turn block ${JSON.stringify(block).slice(0, 50)} must NOT carry cache_control`,
      );
    }
  });
});

// ─── Response parsing — cache usage fields ──────────────────────────────────

describe('multimodal response parsing — cache usage passthrough', () => {
  function fakeFetch(response: unknown): typeof fetch {
    return (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => response,
        text: async () => JSON.stringify(response),
      } as Response)) as unknown as typeof fetch;
  }

  it('surfaces cache_creation_input_tokens + cache_read_input_tokens from Anthropic response', async () => {
    const res = await callAnthropicMultimodal({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'sys',
      userText: 'hi',
      images: [],
      fetchFn: fakeFetch({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 2048,
          cache_read_input_tokens: 1024,
        },
      }),
    });

    assert.equal(res.usage?.inputTokens, 100);
    assert.equal(res.usage?.outputTokens, 50);
    assert.equal(res.usage?.cacheCreationInputTokens, 2048);
    assert.equal(res.usage?.cacheReadInputTokens, 1024);
  });

  it('omits cache fields cleanly when Anthropic did not include them', async () => {
    const res = await callAnthropicMultimodal({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'sys',
      userText: 'hi',
      images: [],
      fetchFn: fakeFetch({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    });

    assert.equal(res.usage?.cacheCreationInputTokens, undefined);
    assert.equal(res.usage?.cacheReadInputTokens, undefined);
  });
});

// ─── AICallMetricsCollector — cache-token aggregation ───────────────────────

describe('AICallMetricsCollector — cache token aggregation', () => {
  function makeMetrics(overrides: Partial<AICallMetrics> = {}): AICallMetrics {
    return {
      purpose: 'generate',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      success: true,
      durationMs: 1000,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cacheCreationInputTokens: 500,
        cacheReadInputTokens: 200,
      },
      estimatedCostUsd: 0.001,
      ...overrides,
    };
  }

  it('getTotals defaults cache fields to zero before any calls', () => {
    const collector = new AICallMetricsCollector();
    const totals = collector.getTotals();
    assert.equal(totals.totalCacheCreationInputTokens, 0);
    assert.equal(totals.totalCacheReadInputTokens, 0);
  });

  it('accumulates cache tokens across successful calls', () => {
    const collector = new AICallMetricsCollector();
    collector.record(makeMetrics());
    collector.record(
      makeMetrics({
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cacheCreationInputTokens: 100,
          cacheReadInputTokens: 300,
        },
      }),
    );
    const totals = collector.getTotals();
    assert.equal(totals.totalCacheCreationInputTokens, 600);
    assert.equal(totals.totalCacheReadInputTokens, 500);
  });

  it('ignores cache tokens on failed calls', () => {
    const collector = new AICallMetricsCollector();
    collector.record(makeMetrics({ success: false }));
    const totals = collector.getTotals();
    assert.equal(totals.totalCacheCreationInputTokens, 0);
    assert.equal(totals.totalCacheReadInputTokens, 0);
  });

  it('handles calls with cache tokens but no base inputTokens', () => {
    const collector = new AICallMetricsCollector();
    collector.record(
      makeMetrics({
        usage: { cacheCreationInputTokens: 1000, cacheReadInputTokens: 2000 },
      }),
    );
    const totals = collector.getTotals();
    assert.equal(totals.totalCacheCreationInputTokens, 1000);
    assert.equal(totals.totalCacheReadInputTokens, 2000);
    assert.equal(totals.totalInputTokens, 0);
  });
});

// ─── estimateCostUsd — cache price multipliers ──────────────────────────────

describe('estimateCostUsd — Anthropic cache pricing', () => {
  it('writes cost 1.25x input price', () => {
    // 1M cache-write tokens on a $3/M input model → $3 × 1.25 = $3.75
    const cost = estimateCostUsd('claude-sonnet-4-6', 0, 0, 1_000_000, 0);
    assert.equal(cost, 3.75);
    assert.equal(ANTHROPIC_CACHE_WRITE_MULTIPLIER, 1.25);
  });

  it('reads cost 0.1x input price', () => {
    // 1M cache-read tokens on a $3/M input model → $3 × 0.10 = $0.30
    const cost = estimateCostUsd('claude-sonnet-4-6', 0, 0, 0, 1_000_000);
    assert.equal(cost, 0.3);
    assert.equal(ANTHROPIC_CACHE_READ_MULTIPLIER, 0.1);
  });

  it('combines base + cache costs additively', () => {
    // 1M input (base) + 1M output + 1M cache write + 1M cache read
    // = 3.00 + 15.00 + 3.75 + 0.30 = 22.05
    const cost = estimateCostUsd('claude-sonnet-4-6', 1_000_000, 1_000_000, 1_000_000, 1_000_000);
    assert.equal(cost, 22.05);
  });

  it('omitting cache args is backward compatible', () => {
    const withoutCache = estimateCostUsd('claude-sonnet-4-6', 1_000_000, 1_000_000);
    const withZeroCache = estimateCostUsd('claude-sonnet-4-6', 1_000_000, 1_000_000, 0, 0);
    assert.equal(withoutCache, withZeroCache);
    assert.equal(withoutCache, 18); // 3 + 15
  });

  it('returns null for unknown model even with cache tokens', () => {
    assert.equal(estimateCostUsd('no-such-model', 0, 0, 1000, 1000), null);
  });

  it('cache-read on a $5/M input model (gpt-4o) prices at $5 × 0.10', () => {
    // 1M cache-read tokens × $5/M × 0.10 = $0.50
    // (OpenAI doesn't actually expose cache tokens, but the pricing formula is
    // model-agnostic — this guards against accidental coupling to Anthropic.)
    const cost = estimateCostUsd('gpt-4o', 0, 0, 0, 1_000_000);
    assert.equal(cost, 0.5);
  });
});
