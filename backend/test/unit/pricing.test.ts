/**
 * Unit tests for AI model pricing functions.
 *
 * Source of truth (Claude rates): https://platform.claude.com/docs/en/about-claude/pricing
 * Verified 2026-05-19 against the official doc table.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';

import {
  estimateCostUsd,
  getModelPricing,
  getContextWindow,
  DEFAULT_CONTEXT_WINDOW,
} from '../../src/services/ai/pricing.js';

// ─── getModelPricing ────────────────────────────────────────────────

describe('getModelPricing', () => {
  test('returns pricing for gpt-4o-mini', () => {
    const p = getModelPricing('gpt-4o-mini');
    assert.ok(p);
    assert.strictEqual(p.inputUsdPer1M, 0.15);
    assert.strictEqual(p.outputUsdPer1M, 0.6);
  });

  test('returns pricing for gpt-4o', () => {
    const p = getModelPricing('gpt-4o');
    assert.ok(p);
    assert.strictEqual(p.inputUsdPer1M, 5);
    assert.strictEqual(p.outputUsdPer1M, 15);
  });

  test('returns pricing for gpt-4.1-mini', () => {
    const p = getModelPricing('gpt-4.1-mini');
    assert.ok(p);
    assert.strictEqual(p.inputUsdPer1M, 0.3);
    assert.strictEqual(p.outputUsdPer1M, 1.2);
  });

  test('returns null for unknown model', () => {
    assert.strictEqual(getModelPricing('unknown-model'), null);
    assert.strictEqual(getModelPricing(''), null);
    // Note: 'anthropic/claude-sonnet-4' is NOT in the OpenRouter map, but
    // prefix-matching may catch it. We just confirm the function doesn't crash.
    const p = getModelPricing('totally-bogus-model-name-xyz');
    assert.strictEqual(p, null);
  });

  // ─── Claude doc verification (https://platform.claude.com/docs/en/about-claude/pricing)

  test('Claude Opus 4.7 — $5 in / $25 out / $6.25 cache-5m-write / $10 cache-1h-write / $0.50 cache-read', () => {
    const p = getModelPricing('claude-opus-4-7');
    assert.ok(p);
    assert.strictEqual(p.inputUsdPer1M, 5);
    assert.strictEqual(p.outputUsdPer1M, 25);
    assert.strictEqual(p.cacheWrite5mUsdPer1M, 6.25);
    assert.strictEqual(p.cacheWrite1hUsdPer1M, 10);
    assert.strictEqual(p.cacheReadUsdPer1M, 0.5);
  });

  test('Claude Opus 4.6 matches Opus 4.7 rates', () => {
    const p = getModelPricing('claude-opus-4-6');
    assert.ok(p);
    assert.strictEqual(p.inputUsdPer1M, 5);
    assert.strictEqual(p.outputUsdPer1M, 25);
  });

  test('Claude Opus 4.5 matches Opus 4.7 rates', () => {
    const p = getModelPricing('claude-opus-4-5');
    assert.ok(p);
    assert.strictEqual(p.inputUsdPer1M, 5);
    assert.strictEqual(p.outputUsdPer1M, 25);
  });

  test('Claude Opus 4.1 (deprecated) — $15 in / $75 out', () => {
    const p = getModelPricing('claude-opus-4-1');
    assert.ok(p);
    assert.strictEqual(p.inputUsdPer1M, 15);
    assert.strictEqual(p.outputUsdPer1M, 75);
    assert.strictEqual(p.cacheWrite5mUsdPer1M, 18.75);
    assert.strictEqual(p.cacheReadUsdPer1M, 1.5);
  });

  test('Claude Sonnet 4.6 — $3 in / $15 out / $3.75 cache-5m / $0.30 cache-read', () => {
    const p = getModelPricing('claude-sonnet-4-6');
    assert.ok(p);
    assert.strictEqual(p.inputUsdPer1M, 3);
    assert.strictEqual(p.outputUsdPer1M, 15);
    assert.strictEqual(p.cacheWrite5mUsdPer1M, 3.75);
    assert.strictEqual(p.cacheWrite1hUsdPer1M, 6);
    assert.strictEqual(p.cacheReadUsdPer1M, 0.3);
  });

  test('Claude Sonnet 4.5 / 4 (deprecated) match Sonnet 4.6 rates', () => {
    const p45 = getModelPricing('claude-sonnet-4-5');
    const p4 = getModelPricing('claude-sonnet-4');
    assert.ok(p45 && p4);
    assert.strictEqual(p45.inputUsdPer1M, 3);
    assert.strictEqual(p45.outputUsdPer1M, 15);
    assert.strictEqual(p4.inputUsdPer1M, 3);
    assert.strictEqual(p4.outputUsdPer1M, 15);
  });

  test('Claude Haiku 4.5 — $1 in / $5 out / $1.25 cache-5m / $0.10 cache-read', () => {
    const p = getModelPricing('claude-haiku-4-5');
    assert.ok(p);
    assert.strictEqual(p.inputUsdPer1M, 1);
    assert.strictEqual(p.outputUsdPer1M, 5);
    assert.strictEqual(p.cacheWrite5mUsdPer1M, 1.25);
    assert.strictEqual(p.cacheWrite1hUsdPer1M, 2);
    assert.strictEqual(p.cacheReadUsdPer1M, 0.1);
  });

  test('Claude Haiku 3.5 (retired) — $0.80 in / $4 out / $0.08 cache-read', () => {
    const p = getModelPricing('claude-haiku-3-5');
    assert.ok(p);
    assert.strictEqual(p.inputUsdPer1M, 0.8);
    assert.strictEqual(p.outputUsdPer1M, 4);
    assert.strictEqual(p.cacheWrite5mUsdPer1M, 1.0);
    assert.strictEqual(p.cacheWrite1hUsdPer1M, 1.6);
    assert.strictEqual(p.cacheReadUsdPer1M, 0.08);
  });

  test('Gemini 1.5 Pro — $1.25 in / $5 out', () => {
    const p = getModelPricing('gemini-1.5-pro');
    assert.ok(p);
    assert.strictEqual(p.inputUsdPer1M, 1.25);
    assert.strictEqual(p.outputUsdPer1M, 5);
  });

  test('Gemini 1.5 Flash — $0.075 in / $0.30 out', () => {
    const p = getModelPricing('gemini-1.5-flash');
    assert.ok(p);
    assert.strictEqual(p.inputUsdPer1M, 0.075);
    assert.strictEqual(p.outputUsdPer1M, 0.3);
  });
});

// ─── estimateCostUsd ────────────────────────────────────────────────

describe('estimateCostUsd', () => {
  test('returns null for unknown model', () => {
    assert.strictEqual(estimateCostUsd('totally-bogus-model-xyz', 1000, 1000), null);
  });

  test('calculates cost for gpt-4o-mini', () => {
    // 1M input tokens * 0.15 + 1M output tokens * 0.6 = 0.75
    const cost = estimateCostUsd('gpt-4o-mini', 1_000_000, 1_000_000);
    assert.strictEqual(cost, 0.75);
  });

  test('calculates cost for gpt-4o', () => {
    // 1M input * 5 + 1M output * 15 = 20
    const cost = estimateCostUsd('gpt-4o', 1_000_000, 1_000_000);
    assert.strictEqual(cost, 20);
  });

  test('returns 0 for zero tokens', () => {
    assert.strictEqual(estimateCostUsd('gpt-4o-mini', 0, 0), 0);
  });

  test('handles undefined tokens as zero', () => {
    assert.strictEqual(estimateCostUsd('gpt-4o-mini'), 0);
    assert.strictEqual(estimateCostUsd('gpt-4o-mini', undefined, undefined), 0);
  });

  test('handles input-only', () => {
    // 500k tokens * 0.15/1M = 0.075
    assert.strictEqual(estimateCostUsd('gpt-4o-mini', 500_000, 0), 0.075);
  });

  test('handles output-only', () => {
    // 500k tokens * 0.6/1M = 0.3
    assert.strictEqual(estimateCostUsd('gpt-4o-mini', 0, 500_000), 0.3);
  });

  test('rounds to 6 decimal places', () => {
    // 1 token * 0.15/1M = 0.00000015 -> rounds to 0
    const cost = estimateCostUsd('gpt-4o-mini', 1, 0);
    assert.ok(cost !== null);
    const decimals = cost.toString().split('.')[1]?.length ?? 0;
    assert.ok(decimals <= 6);
  });

  test('small token count precision', () => {
    // 1000 input * 5/1M = 0.005
    assert.strictEqual(estimateCostUsd('gpt-4o', 1000, 0), 0.005);
  });

  // ─── Claude doc-verbatim cost calculations ──────────────────────

  test('Claude Opus 4.7 input cost matches official rate ($5/MTok)', () => {
    // 1M input × $5 / MTok = $5
    assert.strictEqual(estimateCostUsd('claude-opus-4-7', 1_000_000, 0), 5);
  });

  test('Claude Opus 4.7 output cost matches official rate ($25/MTok)', () => {
    // 1M output × $25 / MTok = $25
    assert.strictEqual(estimateCostUsd('claude-opus-4-7', 0, 1_000_000), 25);
  });

  test('Claude Sonnet 4.6 mixed — 1M in + 1M out = $18', () => {
    // 1M × $3 + 1M × $15 = $18
    assert.strictEqual(estimateCostUsd('claude-sonnet-4-6', 1_000_000, 1_000_000), 18);
  });

  test('Claude Haiku 4.5 output cost — $5/MTok (not $4 — that is Haiku 3.5)', () => {
    // Regression guard: prior code mistakenly used Haiku-3.5 rates for Haiku-4.5.
    assert.strictEqual(estimateCostUsd('claude-haiku-4-5', 0, 1_000_000), 5);
  });

  test('Claude Opus 4.7 cache-read pricing is 0.1× base input ($0.50/MTok)', () => {
    // 1M cache-read tokens × $0.50/MTok = $0.50
    assert.strictEqual(estimateCostUsd('claude-opus-4-7', 0, 0, 0, 1_000_000), 0.5);
  });

  test('Claude Sonnet 4.6 cache-write (5m) is 1.25× base input ($3.75/MTok)', () => {
    // 1M cache-write tokens × $3.75/MTok = $3.75
    assert.strictEqual(estimateCostUsd('claude-sonnet-4-6', 0, 0, 1_000_000, 0), 3.75);
  });

  test('Claude Haiku 4.5 cache-read is $0.10/MTok', () => {
    assert.strictEqual(estimateCostUsd('claude-haiku-4-5', 0, 0, 0, 1_000_000), 0.1);
  });

  test('Claude Opus 4.1 (deprecated) — 1M in + 1M out = $90', () => {
    // $15 + $75 = $90
    assert.strictEqual(estimateCostUsd('claude-opus-4-1', 1_000_000, 1_000_000), 90);
  });

  // ─── OpenAI / Gemini cost calculations ──────────────────────────

  test('OpenAI gpt-4o input — 1M × $5 = $5', () => {
    assert.strictEqual(estimateCostUsd('gpt-4o', 1_000_000, 0), 5);
  });

  test('OpenAI gpt-4-turbo — 1M in + 1M out = $40', () => {
    // $10 + $30 = $40
    assert.strictEqual(estimateCostUsd('gpt-4-turbo', 1_000_000, 1_000_000), 40);
  });

  test('Gemini 1.5 Flash output — 1M × $0.30 = $0.30', () => {
    assert.strictEqual(estimateCostUsd('gemini-1.5-flash', 0, 1_000_000), 0.3);
  });

  test('Gemini 1.5 Pro input — 1M × $1.25 = $1.25', () => {
    assert.strictEqual(estimateCostUsd('gemini-1.5-pro', 1_000_000, 0), 1.25);
  });

  test('Cache tokens for non-Claude model fall back to multiplier (no explicit cache rate)', () => {
    // gpt-4o has no cacheRead override; falls back to 0.1 × $5 = $0.50/MTok.
    // 1M cache-read × $0.50/MTok = $0.50.
    assert.strictEqual(estimateCostUsd('gpt-4o', 0, 0, 0, 1_000_000), 0.5);
  });
});

// ─── getContextWindow ───────────────────────────────────────────────

describe('getContextWindow', () => {
  test('returns 200k for Claude Opus 4.7', () => {
    assert.strictEqual(getContextWindow('claude-opus-4-7'), 200_000);
  });

  test('returns 1M for Gemini 1.5 Flash', () => {
    assert.strictEqual(getContextWindow('gemini-1.5-flash'), 1_000_000);
  });

  test('falls back to DEFAULT_CONTEXT_WINDOW for unknown model', () => {
    assert.strictEqual(
      getContextWindow('totally-bogus-model-name-xyz-not-real'),
      DEFAULT_CONTEXT_WINDOW
    );
  });
});
