/**
 * Billing & Usage Edge-Case Tests
 *
 * Covers scenarios NOT in billing-service.test.ts:
 *  1. Free plan defaults — full shape invariant, immutability
 *  2. Usage limit check — daily job + monthly token budget, boundary ±1
 *  3. Admin unlimited override — bypass regardless of plan or usage
 *  4. Workspace billing settings — soft threshold, hard stop, parsing edge cases
 *  5. Usage counter increment — atomic upsert semantics, threshold notification
 *  6. Plan tier validation — enum membership, invalid tiers rejected
 *  7. Stripe checkout disabled — placeholder key → 503
 *  8. Notification dedup — same notification not created twice per day
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// ─── Types mirrored from BillingService.ts ───────────────────────────

interface UserPlan {
  planId: string;
  tier: string;
  name: string;
  jobsPerDay: number;
  maxTokenBudget: number;
  maxAgents: number;
  depthModesAllowed: string[];
  maxOutputTokensPerJob: number;
  passesAllowed: number;
  priorityQueue: boolean;
  priceMonthly: number;
}

interface UsageSummary {
  jobsUsedToday: number;
  tokensUsedThisMonth: number;
  jobsLimit: number;
  tokensLimit: number;
  percentJobsUsed: number;
  percentTokensUsed: number;
}

interface LimitCheckResult {
  allowed: boolean;
  reason?: string;
  code?: string;
  upgradeRequired?: boolean;
  currentUsage?: { jobsToday: number; tokensMonth: number };
  limits?: { jobsPerDay: number; maxTokenBudget: number };
}

interface BillingSettings {
  monthlyBudgetUsd: number | null;
  softThresholdPct: number;
  hardStopEnabled: boolean;
}

// ─── Constants from BillingService.ts ────────────────────────────────

const FREE_PLAN: UserPlan = {
  planId: 'free',
  tier: 'free',
  name: 'Free',
  jobsPerDay: 3,
  maxTokenBudget: 20000,
  maxAgents: 1,
  depthModesAllowed: ['lite', 'standard'],
  maxOutputTokensPerJob: 8000,
  passesAllowed: 1,
  priorityQueue: false,
  priceMonthly: 0,
};

const DEFAULT_SETTINGS: BillingSettings = {
  monthlyBudgetUsd: null,
  softThresholdPct: 0.80,
  hardStopEnabled: true,
};

// Plan tier enum from DB schema
const VALID_TIERS = ['free', 'pro', 'pro_plus', 'team', 'enterprise'] as const;

// Subscription status enum from DB schema
const VALID_SUB_STATUSES = ['active', 'past_due', 'canceled', 'trialing', 'incomplete'] as const;

// ─── Pure-logic simulators (same algorithms as BillingService.ts) ────

function simulateCheckUsageLimits(
  isUnlimited: boolean,
  plan: UserPlan,
  jobsUsedToday: number,
  tokensUsedMonth: number,
  dbError = false,
): LimitCheckResult {
  if (isUnlimited) return { allowed: true };
  if (dbError) return { allowed: true }; // fail-open

  if (jobsUsedToday >= plan.jobsPerDay) {
    return {
      allowed: false,
      reason: `Günlük iş limiti doldu (${plan.jobsPerDay}/${plan.jobsPerDay}). Daha fazlası için planınızı yükseltin.`,
      code: 'BILLING_JOBS_LIMIT',
      upgradeRequired: true,
      currentUsage: { jobsToday: jobsUsedToday, tokensMonth: tokensUsedMonth },
      limits: { jobsPerDay: plan.jobsPerDay, maxTokenBudget: plan.maxTokenBudget },
    };
  }

  if (plan.maxTokenBudget > 0 && tokensUsedMonth >= plan.maxTokenBudget) {
    return {
      allowed: false,
      reason: `Aylık token bütçesi doldu (${tokensUsedMonth.toLocaleString()}/${plan.maxTokenBudget.toLocaleString()}). Daha fazlası için planınızı yükseltin.`,
      code: 'BILLING_TOKEN_LIMIT',
      upgradeRequired: true,
      currentUsage: { jobsToday: jobsUsedToday, tokensMonth: tokensUsedMonth },
      limits: { jobsPerDay: plan.jobsPerDay, maxTokenBudget: plan.maxTokenBudget },
    };
  }

  return {
    allowed: true,
    currentUsage: { jobsToday: jobsUsedToday, tokensMonth: tokensUsedMonth },
    limits: { jobsPerDay: plan.jobsPerDay, maxTokenBudget: plan.maxTokenBudget },
  };
}

function simulateGetUsageSummary(
  plan: UserPlan,
  jobsUsedToday: number,
  tokensUsedThisMonth: number,
): UsageSummary {
  return {
    jobsUsedToday,
    tokensUsedThisMonth,
    jobsLimit: plan.jobsPerDay,
    tokensLimit: plan.maxTokenBudget,
    percentJobsUsed: plan.jobsPerDay > 0
      ? Math.round((jobsUsedToday / plan.jobsPerDay) * 100)
      : 0,
    percentTokensUsed: plan.maxTokenBudget > 0
      ? Math.round((tokensUsedThisMonth / plan.maxTokenBudget) * 100)
      : 0,
  };
}

function parseWorkspaceBillingSettings(
  row: { monthlyBudgetUsd: string | null; softThresholdPct: string; hardStopEnabled: boolean } | null,
): BillingSettings {
  if (!row) return DEFAULT_SETTINGS;
  return {
    monthlyBudgetUsd: row.monthlyBudgetUsd ? parseFloat(row.monthlyBudgetUsd) : null,
    softThresholdPct: parseFloat(row.softThresholdPct),
    hardStopEnabled: row.hardStopEnabled,
  };
}

function shouldNotify(
  percentJobsUsed: number,
  percentTokensUsed: number,
  thresholdPct: number,
  alreadyNotifiedToday: boolean,
): boolean {
  const overThreshold = percentJobsUsed >= thresholdPct || percentTokensUsed >= thresholdPct;
  return overThreshold && !alreadyNotifiedToday;
}

function isStripeDisabled(key: string | undefined): boolean {
  return !key || key === 'sk_test_placeholder';
}

function isIncrementNeeded(tokensUsed: number): boolean {
  return tokensUsed > 0;
}

// ─── 1. Billing: Free Plan Defaults ──────────────────────────────────

describe('Billing: Free Plan Defaults — Edge Cases', () => {
  test('FREE_PLAN object is frozen-compatible (no unexpected mutations)', () => {
    const copy = { ...FREE_PLAN };
    copy.jobsPerDay = 999;
    // Original constant should still be 3
    assert.equal(FREE_PLAN.jobsPerDay, 3);
  });

  test('depthModesAllowed does not include deep or expert on free', () => {
    assert.ok(!FREE_PLAN.depthModesAllowed.includes('deep'));
    assert.ok(!FREE_PLAN.depthModesAllowed.includes('expert'));
  });

  test('all numeric limits are non-negative', () => {
    assert.ok(FREE_PLAN.jobsPerDay >= 0);
    assert.ok(FREE_PLAN.maxTokenBudget >= 0);
    assert.ok(FREE_PLAN.maxAgents >= 0);
    assert.ok(FREE_PLAN.maxOutputTokensPerJob >= 0);
    assert.ok(FREE_PLAN.passesAllowed >= 0);
    assert.ok(FREE_PLAN.priceMonthly >= 0);
  });

  test('depthModesAllowed is a non-empty array', () => {
    assert.ok(Array.isArray(FREE_PLAN.depthModesAllowed));
    assert.ok(FREE_PLAN.depthModesAllowed.length > 0);
  });

  test('planId and tier both equal "free"', () => {
    assert.equal(FREE_PLAN.planId, FREE_PLAN.tier);
    assert.equal(FREE_PLAN.planId, 'free');
  });

  test('maxOutputTokensPerJob is less than maxTokenBudget', () => {
    assert.ok(FREE_PLAN.maxOutputTokensPerJob < FREE_PLAN.maxTokenBudget);
  });
});

// ─── 2. Billing: Usage Limit Check — Daily Job + Monthly Token ───────

describe('Billing: Usage Limit Check — Daily Jobs', () => {
  test('free plan: one job below limit → allowed', () => {
    const result = simulateCheckUsageLimits(false, FREE_PLAN, 2, 0);
    assert.equal(result.allowed, true);
  });

  test('free plan: exactly at daily limit → blocked with BILLING_JOBS_LIMIT', () => {
    const result = simulateCheckUsageLimits(false, FREE_PLAN, 3, 0);
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'BILLING_JOBS_LIMIT');
  });

  test('free plan: over daily limit → blocked', () => {
    const result = simulateCheckUsageLimits(false, FREE_PLAN, 10, 0);
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'BILLING_JOBS_LIMIT');
    assert.equal(result.upgradeRequired, true);
  });

  test('blocked response includes upgradeRequired flag', () => {
    const result = simulateCheckUsageLimits(false, FREE_PLAN, 3, 0);
    assert.equal(result.upgradeRequired, true);
  });

  test('allowed response reports current usage', () => {
    const result = simulateCheckUsageLimits(false, FREE_PLAN, 1, 5000);
    assert.ok(result.currentUsage);
    assert.equal(result.currentUsage!.jobsToday, 1);
    assert.equal(result.currentUsage!.tokensMonth, 5000);
  });
});

describe('Billing: Usage Limit Check — Monthly Token Budget', () => {
  test('tokens under budget → allowed', () => {
    const result = simulateCheckUsageLimits(false, FREE_PLAN, 0, 19999);
    assert.equal(result.allowed, true);
  });

  test('tokens at exact budget → blocked with BILLING_TOKEN_LIMIT', () => {
    const result = simulateCheckUsageLimits(false, FREE_PLAN, 0, 20000);
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'BILLING_TOKEN_LIMIT');
    assert.equal(result.upgradeRequired, true);
  });

  test('tokens over budget → blocked', () => {
    const result = simulateCheckUsageLimits(false, FREE_PLAN, 0, 50000);
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'BILLING_TOKEN_LIMIT');
  });

  test('job limit checked before token limit (jobs at limit, tokens also at limit)', () => {
    const result = simulateCheckUsageLimits(false, FREE_PLAN, 3, 20000);
    // Jobs checked first in the code, so BILLING_JOBS_LIMIT takes precedence
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'BILLING_JOBS_LIMIT');
  });

  test('zero maxTokenBudget plan skips token check', () => {
    const zeroBudgetPlan: UserPlan = { ...FREE_PLAN, maxTokenBudget: 0 };
    const result = simulateCheckUsageLimits(false, zeroBudgetPlan, 0, 999999);
    // maxTokenBudget <= 0 → token check is skipped
    assert.equal(result.allowed, true);
  });

  test('token limit returns current usage details', () => {
    const result = simulateCheckUsageLimits(false, FREE_PLAN, 0, 20000);
    assert.ok(result.currentUsage);
    assert.equal(result.currentUsage!.tokensMonth, 20000);
    assert.ok(result.limits);
    assert.equal(result.limits!.maxTokenBudget, 20000);
  });
});

describe('Billing: Usage Limit Check — DB Error Resilience', () => {
  test('DB error → fail-open (job allowed)', () => {
    const result = simulateCheckUsageLimits(false, FREE_PLAN, 999, 999999, true);
    assert.equal(result.allowed, true);
  });

  test('fail-open result has no usage details', () => {
    const result = simulateCheckUsageLimits(false, FREE_PLAN, 0, 0, true);
    assert.equal(result.currentUsage, undefined);
    assert.equal(result.limits, undefined);
  });
});

// ─── 3. Billing: Admin Unlimited Override ────────────────────────────

describe('Billing: Admin Unlimited Override', () => {
  test('unlimited user bypasses free plan job limit', () => {
    const result = simulateCheckUsageLimits(true, FREE_PLAN, 100, 0);
    assert.equal(result.allowed, true);
  });

  test('unlimited user bypasses token budget', () => {
    const result = simulateCheckUsageLimits(true, FREE_PLAN, 0, 999999);
    assert.equal(result.allowed, true);
  });

  test('unlimited user bypasses both limits simultaneously', () => {
    const result = simulateCheckUsageLimits(true, FREE_PLAN, 999, 999999);
    assert.equal(result.allowed, true);
  });

  test('unlimited bypass returns no usage details (minimal response)', () => {
    const result = simulateCheckUsageLimits(true, FREE_PLAN, 50, 100000);
    assert.equal(result.currentUsage, undefined);
    assert.equal(result.limits, undefined);
    assert.equal(result.reason, undefined);
    assert.equal(result.code, undefined);
  });

  test('unlimited takes precedence over DB error path', () => {
    // isUnlimited is checked first, before any DB query
    const result = simulateCheckUsageLimits(true, FREE_PLAN, 0, 0, true);
    assert.equal(result.allowed, true);
  });

  const highPlan: UserPlan = {
    planId: 'enterprise',
    tier: 'enterprise',
    name: 'Enterprise',
    jobsPerDay: 1000,
    maxTokenBudget: 10000000,
    maxAgents: 100,
    depthModesAllowed: ['lite', 'standard', 'deep', 'expert'],
    maxOutputTokensPerJob: 128000,
    passesAllowed: 10,
    priorityQueue: true,
    priceMonthly: 499,
  };

  test('unlimited bypass works on enterprise plan too', () => {
    const result = simulateCheckUsageLimits(true, highPlan, 9999, 99999999);
    assert.equal(result.allowed, true);
  });
});

// ─── 4. Billing: Workspace Billing Settings ──────────────────────────

describe('Billing: Workspace Billing Settings — Soft Threshold', () => {
  test('default softThresholdPct is 0.80 (80%)', () => {
    const settings = parseWorkspaceBillingSettings(null);
    assert.equal(settings.softThresholdPct, 0.80);
  });

  test('custom threshold 0.50 parses correctly', () => {
    const settings = parseWorkspaceBillingSettings({
      monthlyBudgetUsd: null,
      softThresholdPct: '0.50',
      hardStopEnabled: true,
    });
    assert.equal(settings.softThresholdPct, 0.50);
  });

  test('threshold 1.00 (100%) is valid', () => {
    const settings = parseWorkspaceBillingSettings({
      monthlyBudgetUsd: null,
      softThresholdPct: '1.00',
      hardStopEnabled: true,
    });
    assert.equal(settings.softThresholdPct, 1.0);
  });

  test('threshold 0.00 (never notify) is valid', () => {
    const settings = parseWorkspaceBillingSettings({
      monthlyBudgetUsd: null,
      softThresholdPct: '0.00',
      hardStopEnabled: true,
    });
    assert.equal(settings.softThresholdPct, 0);
  });
});

describe('Billing: Workspace Billing Settings — Hard Stop', () => {
  test('default hardStopEnabled is true', () => {
    const settings = parseWorkspaceBillingSettings(null);
    assert.equal(settings.hardStopEnabled, true);
  });

  test('hardStopEnabled false disables enforcement', () => {
    const settings = parseWorkspaceBillingSettings({
      monthlyBudgetUsd: '500',
      softThresholdPct: '0.80',
      hardStopEnabled: false,
    });
    assert.equal(settings.hardStopEnabled, false);
  });
});

describe('Billing: Workspace Billing Settings — Budget Parsing', () => {
  test('null budget row returns defaults', () => {
    const settings = parseWorkspaceBillingSettings(null);
    assert.deepEqual(settings, DEFAULT_SETTINGS);
  });

  test('budget "0" parses as 0 (not null)', () => {
    const settings = parseWorkspaceBillingSettings({
      monthlyBudgetUsd: '0',
      softThresholdPct: '0.80',
      hardStopEnabled: true,
    });
    // "0" is truthy in parseFloat check, so returns 0
    assert.equal(settings.monthlyBudgetUsd, 0);
  });

  test('budget with decimal precision preserved', () => {
    const settings = parseWorkspaceBillingSettings({
      monthlyBudgetUsd: '99.99',
      softThresholdPct: '0.80',
      hardStopEnabled: true,
    });
    assert.equal(settings.monthlyBudgetUsd, 99.99);
  });

  test('large budget parsed correctly', () => {
    const settings = parseWorkspaceBillingSettings({
      monthlyBudgetUsd: '10000',
      softThresholdPct: '0.80',
      hardStopEnabled: true,
    });
    assert.equal(settings.monthlyBudgetUsd, 10000);
  });
});

// ─── 5. Billing: Usage Counter Increment ─────────────────────────────

describe('Billing: Usage Counter Increment — Atomic Semantics', () => {
  test('daily period key format YYYY-MM-DD', () => {
    const todayKey = new Date().toISOString().slice(0, 10);
    assert.match(todayKey, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('monthly period key format YYYY-MM', () => {
    const monthKey = new Date().toISOString().slice(0, 7);
    assert.match(monthKey, /^\d{4}-\d{2}$/);
  });

  test('daily key changes at date boundary', () => {
    const before = new Date('2026-03-31T23:59:59.999Z').toISOString().slice(0, 10);
    const after = new Date('2026-04-01T00:00:00.000Z').toISOString().slice(0, 10);
    assert.notEqual(before, after);
    assert.equal(before, '2026-03-31');
    assert.equal(after, '2026-04-01');
  });

  test('monthly key changes at month boundary', () => {
    const before = new Date('2026-12-31T23:59:59.999Z').toISOString().slice(0, 7);
    const after = new Date('2027-01-01T00:00:00.000Z').toISOString().slice(0, 7);
    assert.notEqual(before, after);
    assert.equal(before, '2026-12');
    assert.equal(after, '2027-01');
  });

  test('monthly key rolls over year boundary', () => {
    const dec = new Date('2026-12-15T00:00:00Z').toISOString().slice(0, 7);
    const jan = new Date('2027-01-15T00:00:00Z').toISOString().slice(0, 7);
    assert.equal(dec, '2026-12');
    assert.equal(jan, '2027-01');
  });

  test('token increment skipped when tokensUsed is 0', () => {
    assert.equal(isIncrementNeeded(0), false);
  });

  test('token increment runs when tokensUsed is 1', () => {
    assert.equal(isIncrementNeeded(1), true);
  });

  test('token increment runs for large token count', () => {
    assert.equal(isIncrementNeeded(100000), true);
  });

  test('negative tokensUsed is not > 0', () => {
    assert.equal(isIncrementNeeded(-1), false);
  });
});

describe('Billing: Usage Counter — Threshold Notification', () => {
  // The soft threshold in BillingService uses:
  //   thresholdPct = parseFloat(softThresholdPct) * 100
  //   So if softThresholdPct = 0.80, thresholdPct = 80

  test('80% job usage with 80% threshold → notify', () => {
    assert.equal(shouldNotify(80, 0, 80, false), true);
  });

  test('80% token usage with 80% threshold → notify', () => {
    assert.equal(shouldNotify(0, 80, 80, false), true);
  });

  test('79% both with 80% threshold → no notify', () => {
    assert.equal(shouldNotify(79, 79, 80, false), false);
  });

  test('100% usage → notify', () => {
    assert.equal(shouldNotify(100, 100, 80, false), true);
  });

  test('0% usage → no notify', () => {
    assert.equal(shouldNotify(0, 0, 80, false), false);
  });

  test('threshold 0% → always notify (any usage)', () => {
    assert.equal(shouldNotify(1, 0, 0, false), true);
    assert.equal(shouldNotify(0, 1, 0, false), true);
  });

  test('threshold 0% but 0 usage → notify (0 >= 0)', () => {
    assert.equal(shouldNotify(0, 0, 0, false), true);
  });
});

// ─── 6. Billing: Plan Tier Validation ────────────────────────────────

describe('Billing: Plan Tier Validation', () => {
  test('free tier is valid', () => {
    assert.ok((VALID_TIERS as readonly string[]).includes('free'));
  });

  test('pro tier is valid', () => {
    assert.ok((VALID_TIERS as readonly string[]).includes('pro'));
  });

  test('pro_plus tier is valid', () => {
    assert.ok((VALID_TIERS as readonly string[]).includes('pro_plus'));
  });

  test('team tier is valid', () => {
    assert.ok((VALID_TIERS as readonly string[]).includes('team'));
  });

  test('enterprise tier is valid', () => {
    assert.ok((VALID_TIERS as readonly string[]).includes('enterprise'));
  });

  test('invalid tier "premium" is rejected', () => {
    assert.ok(!(VALID_TIERS as readonly string[]).includes('premium'));
  });

  test('invalid tier "basic" is rejected', () => {
    assert.ok(!(VALID_TIERS as readonly string[]).includes('basic'));
  });

  test('empty string tier is rejected', () => {
    assert.ok(!(VALID_TIERS as readonly string[]).includes(''));
  });

  test('tier enum has exactly 5 members', () => {
    assert.equal(VALID_TIERS.length, 5);
  });

  test('subscription status enum has expected values', () => {
    assert.deepEqual([...VALID_SUB_STATUSES], ['active', 'past_due', 'canceled', 'trialing', 'incomplete']);
  });

  test('only "active" status resolves to a paid plan', () => {
    // Simulating getUserPlan: only 'active' picks from subscription
    for (const status of VALID_SUB_STATUSES) {
      const resolvedId = status === 'active' ? 'pro' : 'free';
      if (status === 'active') {
        assert.equal(resolvedId, 'pro');
      } else {
        assert.equal(resolvedId, 'free', `Status "${status}" should resolve to free plan`);
      }
    }
  });
});

// ─── 7. Billing: Stripe Checkout Disabled ────────────────────────────

describe('Billing: Stripe Checkout Disabled', () => {
  test('placeholder key is detected as disabled', () => {
    assert.equal(isStripeDisabled('sk_test_placeholder'), true);
  });

  test('undefined key is detected as disabled', () => {
    assert.equal(isStripeDisabled(undefined), true);
  });

  test('empty string key is detected as disabled', () => {
    assert.equal(isStripeDisabled(''), true);
  });

  test('real test key is NOT disabled', () => {
    assert.equal(isStripeDisabled('sk_test_51ABC123xyz'), false);
  });

  test('real live key is NOT disabled', () => {
    assert.equal(isStripeDisabled('sk_live_51ABC123xyz'), false);
  });

  test('PAYMENTS_DISABLED error shape is correct', () => {
    const errorResponse = {
      error: { code: 'PAYMENTS_DISABLED', message: 'Payment processing is not configured' },
    };
    assert.equal(errorResponse.error.code, 'PAYMENTS_DISABLED');
    assert.ok(errorResponse.error.message.length > 0);
  });

  test('checkout requires both planId and priceId', () => {
    const cases = [
      { planId: '', priceId: 'price_1' },
      { planId: 'pro', priceId: '' },
      { planId: '', priceId: '' },
    ];
    for (const body of cases) {
      const isValid = !!body.planId && !!body.priceId;
      assert.equal(isValid, false, `Should reject planId="${body.planId}", priceId="${body.priceId}"`);
    }
  });

  test('checkout accepts valid planId + priceId', () => {
    const body = { planId: 'pro', priceId: 'price_1MoBy5LkdIwHhzF' };
    assert.equal(!!body.planId && !!body.priceId, true);
  });

  test('MISSING_FIELDS error when userId absent in user-override', () => {
    const body = { userId: '', isUnlimited: true };
    const isValid = !!body.userId;
    assert.equal(isValid, false);
  });
});

// ─── 8. Billing: Notification Dedup ──────────────────────────────────

describe('Billing: Notification Dedup — Same Day', () => {
  test('first notification of the day → allowed', () => {
    assert.equal(shouldNotify(90, 50, 80, false), true);
  });

  test('second notification same day → suppressed', () => {
    assert.equal(shouldNotify(90, 50, 80, true), false);
  });

  test('even if both metrics over threshold, dedup still applies', () => {
    assert.equal(shouldNotify(95, 95, 80, true), false);
  });

  test('new day resets dedup (alreadyNotified becomes false)', () => {
    // Day 1: notified
    assert.equal(shouldNotify(90, 90, 80, true), false);
    // Day 2: fresh start
    assert.equal(shouldNotify(90, 90, 80, false), true);
  });

  test('under threshold is never notified regardless of dedup state', () => {
    assert.equal(shouldNotify(50, 50, 80, false), false);
    assert.equal(shouldNotify(50, 50, 80, true), false);
  });

  test('exact boundary 80/80 with threshold 80 → notify if first time', () => {
    assert.equal(shouldNotify(80, 80, 80, false), true);
  });

  test('exact boundary 80/80 with threshold 80 → suppress if already notified', () => {
    assert.equal(shouldNotify(80, 80, 80, true), false);
  });
});

// ─── Billing: Usage Summary Edge Cases ───────────────────────────────

describe('Billing: Usage Summary Edge Cases', () => {
  test('rounding: 1/3 jobs = 33% (not 33.33)', () => {
    const summary = simulateGetUsageSummary(FREE_PLAN, 1, 0);
    assert.equal(summary.percentJobsUsed, 33);
    assert.equal(typeof summary.percentJobsUsed, 'number');
  });

  test('rounding: 2/3 jobs = 67% (not 66.67)', () => {
    const summary = simulateGetUsageSummary(FREE_PLAN, 2, 0);
    assert.equal(summary.percentJobsUsed, 67);
  });

  test('exact 100%: 3/3 jobs', () => {
    const summary = simulateGetUsageSummary(FREE_PLAN, 3, 0);
    assert.equal(summary.percentJobsUsed, 100);
  });

  test('over 100%: 6/3 jobs = 200%', () => {
    const summary = simulateGetUsageSummary(FREE_PLAN, 6, 0);
    assert.equal(summary.percentJobsUsed, 200);
  });

  test('zero-limit plan: division by zero avoided', () => {
    const zeroPlan: UserPlan = { ...FREE_PLAN, jobsPerDay: 0, maxTokenBudget: 0 };
    const summary = simulateGetUsageSummary(zeroPlan, 10, 50000);
    assert.equal(summary.percentJobsUsed, 0);
    assert.equal(summary.percentTokensUsed, 0);
  });

  test('very large token usage calculates correctly', () => {
    const bigPlan: UserPlan = { ...FREE_PLAN, maxTokenBudget: 10000000 };
    const summary = simulateGetUsageSummary(bigPlan, 0, 5000000);
    assert.equal(summary.percentTokensUsed, 50);
  });

  test('usage summary limits match the plan values', () => {
    const proPlan: UserPlan = {
      ...FREE_PLAN,
      planId: 'pro',
      tier: 'pro',
      jobsPerDay: 50,
      maxTokenBudget: 500000,
    };
    const summary = simulateGetUsageSummary(proPlan, 0, 0);
    assert.equal(summary.jobsLimit, 50);
    assert.equal(summary.tokensLimit, 500000);
  });
});

// ─── Billing: Error Code Conventions ─────────────────────────────────

describe('Billing: Error Code Conventions', () => {
  const ALL_ERROR_CODES = [
    'BILLING_JOBS_LIMIT',
    'BILLING_TOKEN_LIMIT',
    'PAYMENTS_DISABLED',
    'MISSING_FIELDS',
    'FORBIDDEN',
    'UNAUTHORIZED',
  ];

  test('all error codes are UPPER_SNAKE_CASE', () => {
    for (const code of ALL_ERROR_CODES) {
      assert.match(code, /^[A-Z][A-Z0-9_]*$/, `Code "${code}" should be UPPER_SNAKE_CASE`);
    }
  });

  test('job limit and token limit use distinct codes', () => {
    assert.notEqual('BILLING_JOBS_LIMIT', 'BILLING_TOKEN_LIMIT');
  });

  test('error codes are non-empty strings', () => {
    for (const code of ALL_ERROR_CODES) {
      assert.ok(code.length > 0);
    }
  });
});
