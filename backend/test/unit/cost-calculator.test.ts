/**
 * Unit tests for CostCalculator — role-aware wholesale vs retail pricing.
 * Issue #449.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateCost,
  calculateBreakdown,
  aggregateCost,
  estimateRetailCostUsd,
} from '../../src/services/billing/CostCalculator.js';

// Known model: claude-sonnet-4-6 → $3 / $15 per 1M
// For 1_000_000 input + 1_000_000 output: wholesale = $3 + $15 = $18
const SONNET_MODEL = 'claude-sonnet-4-6';

describe('CostCalculator — calculateBreakdown', () => {
  test('returns zero cost when no tokens used (known model)', () => {
    const { breakdown, unknownModel } = calculateBreakdown(
      { inputTokens: 0, outputTokens: 0, model: SONNET_MODEL },
      1.5
    );
    assert.equal(unknownModel, false);
    assert.equal(breakdown.wholesale, 0);
    assert.equal(breakdown.retail, 0);
    assert.equal(breakdown.margin, 0);
    assert.equal(breakdown.markup, 1.5);
  });

  test('sonnet 4.6 — 1M in + 1M out → wholesale $18, retail 1.5x = $27', () => {
    const { breakdown } = calculateBreakdown(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, model: SONNET_MODEL },
      1.5
    );
    assert.equal(breakdown.wholesale, 18);
    assert.equal(breakdown.input, 3);
    assert.equal(breakdown.output, 15);
    assert.equal(breakdown.retail, 27);
    assert.equal(breakdown.margin, 9);
  });

  test('flags unknown model with zero breakdown', () => {
    const { breakdown, unknownModel } = calculateBreakdown(
      { inputTokens: 100_000, outputTokens: 50_000, model: 'nonexistent-model-xyz' },
      1.5
    );
    assert.equal(unknownModel, true);
    assert.equal(breakdown.wholesale, 0);
    assert.equal(breakdown.retail, 0);
  });

  test('custom markup (2.0 = 100% margin)', () => {
    const { breakdown } = calculateBreakdown(
      { inputTokens: 1_000_000, outputTokens: 0, model: SONNET_MODEL },
      2.0
    );
    assert.equal(breakdown.wholesale, 3);
    assert.equal(breakdown.retail, 6);
    assert.equal(breakdown.margin, 3);
    assert.equal(breakdown.markup, 2.0);
  });

  test('markup 1.0 (no margin) retail equals wholesale', () => {
    const { breakdown } = calculateBreakdown(
      { inputTokens: 500_000, outputTokens: 100_000, model: SONNET_MODEL },
      1.0
    );
    assert.equal(breakdown.retail, breakdown.wholesale);
    assert.equal(breakdown.margin, 0);
  });

  test('rounds to 6 decimal places', () => {
    const { breakdown } = calculateBreakdown(
      { inputTokens: 123, outputTokens: 456, model: SONNET_MODEL },
      1.5
    );
    // 123/1M * 3 = 0.000369, 456/1M * 15 = 0.00684 → 0.007209 wholesale
    assert.equal(breakdown.input, 0.000369);
    assert.equal(breakdown.output, 0.00684);
    assert.equal(breakdown.wholesale, 0.007209);
    // 0.007209 * 1.5 = 0.0108135 → rounded to 6 dp
    assert.equal(breakdown.retail, 0.010814);
  });
});

describe('CostCalculator — calculateCost (role-aware)', () => {
  test('admin user sees wholesale as displayCost', () => {
    const result = calculateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, model: SONNET_MODEL },
      { role: 'admin' },
      1.5
    );
    assert.equal(result.displayCost, 18);
    assert.equal(result.breakdown.wholesale, 18);
    assert.equal(result.breakdown.retail, 27);
    assert.equal(result.currency, 'USD');
    assert.equal(result.model, SONNET_MODEL);
    assert.equal(result.unknownModel, false);
  });

  test('regular member sees retail as displayCost', () => {
    const result = calculateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, model: SONNET_MODEL },
      { role: 'member' },
      1.5
    );
    assert.equal(result.displayCost, 27);
    // Breakdown still populated — caller (API) decides whether to expose it
    assert.equal(result.breakdown.wholesale, 18);
    assert.equal(result.breakdown.retail, 27);
  });

  test('unknown role treated as non-admin (retail)', () => {
    const result = calculateCost(
      { inputTokens: 1_000_000, outputTokens: 0, model: SONNET_MODEL },
      { role: 'unknown-role' },
      1.5
    );
    assert.equal(result.displayCost, 4.5); // 3 * 1.5
  });

  test('unknown model returns 0 displayCost and flags unknownModel', () => {
    const result = calculateCost(
      { inputTokens: 100, outputTokens: 50, model: 'nonexistent' },
      { role: 'admin' },
      1.5
    );
    assert.equal(result.unknownModel, true);
    assert.equal(result.displayCost, 0);
  });
});

describe('CostCalculator — aggregateCost', () => {
  test('admin sees stored wholesale as-is', () => {
    const r = aggregateCost(12.345678, { role: 'admin' }, 1.5);
    assert.equal(r.displayCost, 12.345678);
    assert.equal(r.breakdown.wholesale, 12.345678);
    assert.equal(r.breakdown.retail, 18.518517); // 12.345678 * 1.5
    assert.equal(r.breakdown.margin, 6.172839);
  });

  test('member sees retail (wholesale x markup)', () => {
    const r = aggregateCost(10, { role: 'member' }, 1.5);
    assert.equal(r.displayCost, 15);
    assert.equal(r.breakdown.wholesale, 10);
    assert.equal(r.breakdown.retail, 15);
  });

  test('handles zero wholesale gracefully', () => {
    const r = aggregateCost(0, { role: 'admin' }, 1.5);
    assert.equal(r.displayCost, 0);
    assert.equal(r.breakdown.wholesale, 0);
    assert.equal(r.breakdown.retail, 0);
    assert.equal(r.breakdown.margin, 0);
  });

  test('handles NaN / undefined-ish wholesale as zero', () => {
    const r = aggregateCost(Number.NaN as unknown as number, { role: 'member' }, 1.5);
    assert.equal(r.displayCost, 0);
  });

  test('aggregate breakdown leaves input/output at 0 (no per-token detail)', () => {
    const r = aggregateCost(5, { role: 'admin' }, 1.5);
    assert.equal(r.breakdown.input, 0);
    assert.equal(r.breakdown.output, 0);
  });
});

describe('CostCalculator — estimateRetailCostUsd', () => {
  test('applies markup to wholesale estimate', () => {
    const r = estimateRetailCostUsd(SONNET_MODEL, 1_000_000, 0, 1.5);
    assert.equal(r, 4.5); // 3 * 1.5
  });

  test('returns null for unknown model', () => {
    const r = estimateRetailCostUsd('nonexistent', 1000, 1000, 1.5);
    assert.equal(r, null);
  });

  test('handles zero tokens', () => {
    const r = estimateRetailCostUsd(SONNET_MODEL, 0, 0, 1.5);
    assert.equal(r, 0);
  });
});
