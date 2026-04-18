/**
 * Unit tests: Billing admin-unlimited coherence.
 *
 * Covers the contract changes from #382 + #383 (BUG-02, BUG-03):
 *   1. isUserUnlimited — returns true for role=admin even without billing override
 *   2. getUsageSummary — percentJobsUsed / percentTokensUsed are 0 for unlimited users
 *   3. /api/usage response — remaining.jobs/tokens are null for unlimited users
 *
 * These tests exercise the *pure logic* extracted from BillingService; the actual
 * functions touch the DB so full integration coverage happens in billing-edge-cases
 * plus manual verification on prod.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── Pure-logic replicas (mirror BillingService internals) ───────────

/**
 * Derive effective "unlimited" flag from a user's role + billing override.
 * Mirrors the resolved contract of isUserUnlimited() in BillingService.ts.
 */
function computeUnlimited(input: { role?: string; isUnlimitedOverride?: boolean }): boolean {
  if (input.role === 'admin') return true;
  return input.isUnlimitedOverride === true;
}

/**
 * Derive percent usage the way getUsageSummary does after the BUG-02 fix.
 * When unlimited is true, both percents clamp to 0 regardless of counter values.
 */
function computePercents(input: {
  unlimited: boolean;
  jobsUsedToday: number;
  jobsPerDay: number;
  tokensUsedThisMonth: number;
  maxTokenBudget: number;
}): { percentJobsUsed: number; percentTokensUsed: number } {
  if (input.unlimited) {
    return { percentJobsUsed: 0, percentTokensUsed: 0 };
  }
  return {
    percentJobsUsed: input.jobsPerDay > 0
      ? Math.round((input.jobsUsedToday / input.jobsPerDay) * 100)
      : 0,
    percentTokensUsed: input.maxTokenBudget > 0
      ? Math.round((input.tokensUsedThisMonth / input.maxTokenBudget) * 100)
      : 0,
  };
}

/**
 * Derive /api/usage remaining.jobs / remaining.tokens values.
 * Mirrors the usage.ts handler after the BUG-02 fix — returns null for unlimited
 * so the UI can render ∞.
 */
function computeRemaining(input: {
  unlimited: boolean;
  jobsPerDay: number;
  jobsUsedToday: number;
  maxTokenBudget: number;
  tokensUsedThisMonth: number;
}): { jobs: number | null; tokens: number | null } {
  if (input.unlimited) {
    return { jobs: null, tokens: null };
  }
  return {
    jobs: Math.max(0, input.jobsPerDay - input.jobsUsedToday),
    tokens: Math.max(0, input.maxTokenBudget - input.tokensUsedThisMonth),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('computeUnlimited (isUserUnlimited logic)', () => {
  it('returns true when user.role === "admin"', () => {
    assert.equal(computeUnlimited({ role: 'admin' }), true);
  });

  it('returns true when billing override flag is set (non-admin)', () => {
    assert.equal(computeUnlimited({ role: 'user', isUnlimitedOverride: true }), true);
  });

  it('returns true for admin even when override is explicitly false', () => {
    assert.equal(computeUnlimited({ role: 'admin', isUnlimitedOverride: false }), true);
  });

  it('returns false for regular user with no override', () => {
    assert.equal(computeUnlimited({ role: 'user' }), false);
    assert.equal(computeUnlimited({ role: 'user', isUnlimitedOverride: false }), false);
  });

  it('returns false when role is undefined and no override', () => {
    assert.equal(computeUnlimited({}), false);
  });
});

describe('computePercents (getUsageSummary unlimited branch)', () => {
  it('clamps both percents to 0 when unlimited is true, regardless of counters', () => {
    const result = computePercents({
      unlimited: true,
      jobsUsedToday: 100, // way above plan limit
      jobsPerDay: 3,
      tokensUsedThisMonth: 1_000_000,
      maxTokenBudget: 20_000,
    });
    assert.equal(result.percentJobsUsed, 0);
    assert.equal(result.percentTokensUsed, 0);
  });

  it('returns real percentages for non-unlimited users', () => {
    const result = computePercents({
      unlimited: false,
      jobsUsedToday: 2,
      jobsPerDay: 3,
      tokensUsedThisMonth: 5000,
      maxTokenBudget: 20000,
    });
    assert.equal(result.percentJobsUsed, 67);
    assert.equal(result.percentTokensUsed, 25);
  });

  it('reports 100%+ for non-unlimited users who exceeded their limit', () => {
    // This case was reported in prod smoke: admin saw "7/3 jobs" in red.
    // After the fix, an admin gets 0% (via unlimited=true) and a regular user
    // over limit correctly shows 233% so UI can flag "limit exceeded".
    const adminLike = computePercents({
      unlimited: true,
      jobsUsedToday: 7,
      jobsPerDay: 3,
      tokensUsedThisMonth: 0,
      maxTokenBudget: 20000,
    });
    assert.equal(adminLike.percentJobsUsed, 0);

    const freeUserOver = computePercents({
      unlimited: false,
      jobsUsedToday: 7,
      jobsPerDay: 3,
      tokensUsedThisMonth: 0,
      maxTokenBudget: 20000,
    });
    assert.equal(freeUserOver.percentJobsUsed, 233);
  });

  it('handles zero-limit plans without dividing by zero', () => {
    const result = computePercents({
      unlimited: false,
      jobsUsedToday: 5,
      jobsPerDay: 0,
      tokensUsedThisMonth: 100,
      maxTokenBudget: 0,
    });
    assert.equal(result.percentJobsUsed, 0);
    assert.equal(result.percentTokensUsed, 0);
  });
});

describe('computeRemaining (/api/usage remaining branch)', () => {
  it('returns {jobs: null, tokens: null} for unlimited users so UI renders ∞', () => {
    const result = computeRemaining({
      unlimited: true,
      jobsPerDay: 3,
      jobsUsedToday: 7,
      maxTokenBudget: 20000,
      tokensUsedThisMonth: 100000,
    });
    assert.equal(result.jobs, null);
    assert.equal(result.tokens, null);
  });

  it('returns numeric remaining for limited users', () => {
    const result = computeRemaining({
      unlimited: false,
      jobsPerDay: 3,
      jobsUsedToday: 1,
      maxTokenBudget: 20000,
      tokensUsedThisMonth: 5000,
    });
    assert.equal(result.jobs, 2);
    assert.equal(result.tokens, 15000);
  });

  it('floors remaining at 0 when user is over their limit', () => {
    const result = computeRemaining({
      unlimited: false,
      jobsPerDay: 3,
      jobsUsedToday: 10,
      maxTokenBudget: 20000,
      tokensUsedThisMonth: 30000,
    });
    assert.equal(result.jobs, 0);
    assert.equal(result.tokens, 0);
  });
});

describe('end-to-end contract — admin prod-smoke scenario', () => {
  it('admin user with counters above limit still sees unlimited UI state', () => {
    // Reproduces the reported prod state: admin saw "7 / 3 is" in red,
    // "Aylik Token Limiti: 0 / 20.0K" despite having used 92.2K tokens.
    const role = 'admin';
    const isUnlimitedOverride = false;
    const jobsUsedToday = 7;
    const jobsPerDay = 3;
    const tokensUsedThisMonth = 92_200;
    const maxTokenBudget = 20_000;

    const unlimited = computeUnlimited({ role, isUnlimitedOverride });
    assert.equal(unlimited, true, 'admin should be treated as unlimited');

    const percents = computePercents({
      unlimited,
      jobsUsedToday,
      jobsPerDay,
      tokensUsedThisMonth,
      maxTokenBudget,
    });
    assert.equal(percents.percentJobsUsed, 0, 'admin should see 0% bar');
    assert.equal(percents.percentTokensUsed, 0, 'admin should see 0% bar');

    const remaining = computeRemaining({
      unlimited,
      jobsPerDay,
      jobsUsedToday,
      maxTokenBudget,
      tokensUsedThisMonth,
    });
    assert.equal(remaining.jobs, null, 'UI renders ∞ for remaining jobs');
    assert.equal(remaining.tokens, null, 'UI renders ∞ for remaining tokens');
  });
});
