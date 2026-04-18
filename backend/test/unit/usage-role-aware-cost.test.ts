/**
 * Unit tests for /api/usage role-aware cost accounting (Issue #449).
 * These re-implement the transformation logic from src/api/usage.ts so we can
 * exercise the admin-vs-member behaviour without spinning up Fastify + DB.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { aggregateCost, type CostBreakdown } from '../../src/services/billing/CostCalculator.js';

type Role = 'admin' | 'member';

interface UsageResponse {
  estimatedCost: number;
  userIsAdmin: boolean;
  wholesaleCostUsd?: number;
  breakdown?: CostBreakdown;
}

/**
 * Mirrors the GET /api/usage transformation in usage.ts — receives the DB-stored
 * wholesale cost and returns the user-facing response payload.
 */
function buildUsageResponse(storedWholesale: number, role: Role, markup = 1.5): UsageResponse {
  const { displayCost, breakdown } = aggregateCost(storedWholesale, { role }, markup);
  const userIsAdmin = role === 'admin';
  const adminPayload: Pick<UsageResponse, 'userIsAdmin' | 'wholesaleCostUsd' | 'breakdown'> =
    userIsAdmin
      ? { userIsAdmin: true, wholesaleCostUsd: Number(storedWholesale.toFixed(6)), breakdown }
      : { userIsAdmin: false };
  return {
    estimatedCost: Number(displayCost.toFixed(6)),
    ...adminPayload,
  };
}

describe('/api/usage — admin response', () => {
  test('admin sees wholesale as estimatedCost', () => {
    const res = buildUsageResponse(12.5, 'admin');
    assert.equal(res.estimatedCost, 12.5);
    assert.equal(res.userIsAdmin, true);
    assert.equal(res.wholesaleCostUsd, 12.5);
  });

  test('admin response includes breakdown with wholesale/retail/margin', () => {
    const res = buildUsageResponse(10, 'admin', 1.5);
    assert.ok(res.breakdown);
    assert.equal(res.breakdown!.wholesale, 10);
    assert.equal(res.breakdown!.retail, 15);
    assert.equal(res.breakdown!.margin, 5);
    assert.equal(res.breakdown!.markup, 1.5);
  });

  test('admin with zero cost', () => {
    const res = buildUsageResponse(0, 'admin');
    assert.equal(res.estimatedCost, 0);
    assert.equal(res.wholesaleCostUsd, 0);
    assert.equal(res.breakdown!.wholesale, 0);
  });
});

describe('/api/usage — member response', () => {
  test('member sees retail as estimatedCost', () => {
    const res = buildUsageResponse(10, 'member', 1.5);
    assert.equal(res.estimatedCost, 15);
  });

  test('member response does NOT include breakdown or wholesale', () => {
    const res = buildUsageResponse(10, 'member', 1.5);
    assert.equal(res.userIsAdmin, false);
    assert.equal(res.breakdown, undefined);
    assert.equal(res.wholesaleCostUsd, undefined);
  });

  test('member with custom markup 2.0', () => {
    const res = buildUsageResponse(5, 'member', 2.0);
    assert.equal(res.estimatedCost, 10);
  });

  test('member with zero cost', () => {
    const res = buildUsageResponse(0, 'member');
    assert.equal(res.estimatedCost, 0);
  });
});

describe('/api/usage — admin vs member invariants', () => {
  test('admin estimatedCost <= member estimatedCost for markup > 1', () => {
    const admin = buildUsageResponse(20, 'admin', 1.5);
    const member = buildUsageResponse(20, 'member', 1.5);
    assert.ok(admin.estimatedCost <= member.estimatedCost);
    assert.equal(admin.estimatedCost, 20);
    assert.equal(member.estimatedCost, 30);
  });

  test('margin = retail - wholesale exactly', () => {
    const admin = buildUsageResponse(7.5, 'admin', 1.6);
    const expectedRetail = Number((7.5 * 1.6).toFixed(6));
    const expectedMargin = Number((expectedRetail - 7.5).toFixed(6));
    assert.equal(admin.breakdown!.retail, expectedRetail);
    assert.equal(admin.breakdown!.margin, expectedMargin);
  });

  test('markup 1.0 → retail equals wholesale; admin and member see same cost', () => {
    const admin = buildUsageResponse(8, 'admin', 1.0);
    const member = buildUsageResponse(8, 'member', 1.0);
    assert.equal(admin.estimatedCost, member.estimatedCost);
    assert.equal(admin.breakdown!.margin, 0);
  });
});
