/**
 * BillingService — Plan enforcement, usage tracking, admin unlimited mode
 *
 * Resilient: all DB queries are wrapped in try-catch so missing tables
 * (e.g., before migration 0022/0023 is run) do not crash the app.
 */
import { db } from '../../db/client.js';
import { plans, subscriptions, usageCounters, userBillingOverrides, workspaceBillingSettings, billingNotifications } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { eq, and, sql, desc } from 'drizzle-orm';

export interface UserPlan {
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

export interface UsageSummary {
  jobsUsedToday: number;
  tokensUsedThisMonth: number;
  jobsLimit: number;
  tokensLimit: number;
  percentJobsUsed: number;
  percentTokensUsed: number;
}

export interface LimitCheckResult {
  allowed: boolean;
  reason?: string;
  code?: string;
  upgradeRequired?: boolean;
  currentUsage?: { jobsToday: number; tokensMonth: number };
  limits?: { jobsPerDay: number; maxTokenBudget: number };
}

export interface BillingSettings {
  monthlyBudgetUsd: number | null;
  softThresholdPct: number;
  hardStopEnabled: boolean;
}

export interface UserOverride {
  userId: string;
  monthlyBudgetUsd: number | null;
  isUnlimited: boolean;
}

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

/**
 * Get the active plan for a user. Falls back to 'free' if no subscription.
 */
export async function getUserPlan(userId: string): Promise<UserPlan> {
  try {
    const sub = await db
      .select({ planId: subscriptions.planId, status: subscriptions.status })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, 'active')))
      .limit(1);

    const planId = sub.length > 0 ? sub[0].planId : 'free';

    const plan = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
    if (plan.length === 0) return FREE_PLAN;

    const p = plan[0];
    return {
      planId: p.id,
      tier: p.tier,
      name: p.name,
      jobsPerDay: p.jobsPerDay,
      maxTokenBudget: p.maxTokenBudget,
      maxAgents: p.maxAgents,
      depthModesAllowed: p.depthModesAllowed ?? ['lite', 'standard'],
      maxOutputTokensPerJob: p.maxOutputTokensPerJob,
      passesAllowed: p.passesAllowed,
      priorityQueue: p.priorityQueue,
      priceMonthly: p.priceMonthly,
    };
  } catch (err) {
    logger.warn(`[Billing] getUserPlan failed (tables may not exist yet): ${(err as Error).message}`);
    return FREE_PLAN;
  }
}

/**
 * Get usage summary for a user
 */
export async function getUsageSummary(userId: string): Promise<UsageSummary> {
  try {
    const plan = await getUserPlan(userId);
    const todayKey = new Date().toISOString().slice(0, 10);
    const monthKey = new Date().toISOString().slice(0, 7);

    const [dailyUsage] = await db
      .select({ jobsUsed: usageCounters.jobsUsed })
      .from(usageCounters)
      .where(and(eq(usageCounters.userId, userId), eq(usageCounters.periodKey, todayKey), eq(usageCounters.periodType, 'daily')))
      .limit(1);

    const [monthlyUsage] = await db
      .select({ tokensUsed: usageCounters.tokensUsed })
      .from(usageCounters)
      .where(and(eq(usageCounters.userId, userId), eq(usageCounters.periodKey, monthKey), eq(usageCounters.periodType, 'monthly')))
      .limit(1);

    const jobsUsedToday = dailyUsage?.jobsUsed ?? 0;
    const tokensUsedThisMonth = monthlyUsage?.tokensUsed ?? 0;

    return {
      jobsUsedToday,
      tokensUsedThisMonth,
      jobsLimit: plan.jobsPerDay,
      tokensLimit: plan.maxTokenBudget,
      percentJobsUsed: plan.jobsPerDay > 0 ? Math.round((jobsUsedToday / plan.jobsPerDay) * 100) : 0,
      percentTokensUsed: plan.maxTokenBudget > 0 ? Math.round((tokensUsedThisMonth / plan.maxTokenBudget) * 100) : 0,
    };
  } catch (err) {
    logger.warn(`[Billing] getUsageSummary failed: ${(err as Error).message}`);
    return { jobsUsedToday: 0, tokensUsedThisMonth: 0, jobsLimit: FREE_PLAN.jobsPerDay, tokensLimit: FREE_PLAN.maxTokenBudget, percentJobsUsed: 0, percentTokensUsed: 0 };
  }
}

/**
 * Check if a user is unlimited (admin override)
 */
export async function isUserUnlimited(userId: string): Promise<boolean> {
  try {
    const [override] = await db
      .select({ isUnlimited: userBillingOverrides.isUnlimited })
      .from(userBillingOverrides)
      .where(eq(userBillingOverrides.userId, userId))
      .limit(1);
    return override?.isUnlimited ?? false;
  } catch {
    return false;
  }
}

/**
 * Check if a user can start a new job (pre-flight limit check).
 * Admin/unlimited users bypass all limits.
 */
export async function checkUsageLimits(userId: string): Promise<LimitCheckResult> {
  // Admin bypass
  if (await isUserUnlimited(userId)) {
    return { allowed: true };
  }

  try {
    const plan = await getUserPlan(userId);
    const todayKey = new Date().toISOString().slice(0, 10);

    const [dailyUsage] = await db
      .select({ jobsUsed: usageCounters.jobsUsed })
      .from(usageCounters)
      .where(and(eq(usageCounters.userId, userId), eq(usageCounters.periodKey, todayKey), eq(usageCounters.periodType, 'daily')))
      .limit(1);

    const jobsToday = dailyUsage?.jobsUsed ?? 0;

    if (jobsToday >= plan.jobsPerDay) {
      return {
        allowed: false,
        reason: `Günlük iş limiti doldu (${plan.jobsPerDay}/${plan.jobsPerDay}). Daha fazlası için planınızı yükseltin.`,
        code: 'BILLING_JOBS_LIMIT',
        upgradeRequired: true,
        currentUsage: { jobsToday, tokensMonth: 0 },
        limits: { jobsPerDay: plan.jobsPerDay, maxTokenBudget: plan.maxTokenBudget },
      };
    }

    // Token budget check (monthly)
    const monthKey = new Date().toISOString().slice(0, 7);
    const [monthlyUsage] = await db
      .select({ tokensUsed: usageCounters.tokensUsed })
      .from(usageCounters)
      .where(and(eq(usageCounters.userId, userId), eq(usageCounters.periodKey, monthKey), eq(usageCounters.periodType, 'monthly')))
      .limit(1);

    const tokensMonth = monthlyUsage?.tokensUsed ?? 0;

    if (plan.maxTokenBudget > 0 && tokensMonth >= plan.maxTokenBudget) {
      return {
        allowed: false,
        reason: `Aylık token bütçesi doldu (${tokensMonth.toLocaleString()}/${plan.maxTokenBudget.toLocaleString()}). Daha fazlası için planınızı yükseltin.`,
        code: 'BILLING_TOKEN_LIMIT',
        upgradeRequired: true,
        currentUsage: { jobsToday, tokensMonth },
        limits: { jobsPerDay: plan.jobsPerDay, maxTokenBudget: plan.maxTokenBudget },
      };
    }

    return {
      allowed: true,
      currentUsage: { jobsToday, tokensMonth },
      limits: { jobsPerDay: plan.jobsPerDay, maxTokenBudget: plan.maxTokenBudget },
    };
  } catch (err) {
    logger.warn(`[Billing] checkUsageLimits failed, allowing job: ${(err as Error).message}`);
    return { allowed: true };
  }
}

/**
 * Increment usage counters after a job runs
 */
export async function incrementUsage(userId: string, tokensUsed: number = 0): Promise<void> {
  try {
    const todayKey = new Date().toISOString().slice(0, 10);
    const monthKey = new Date().toISOString().slice(0, 7);

    await db
      .insert(usageCounters)
      .values({ userId, periodKey: todayKey, periodType: 'daily', jobsUsed: 1, tokensUsed: 0 })
      .onConflictDoUpdate({
        target: [usageCounters.userId, usageCounters.periodKey, usageCounters.periodType],
        set: { jobsUsed: sql`${usageCounters.jobsUsed} + 1`, updatedAt: new Date() },
      });

    if (tokensUsed > 0) {
      await db
        .insert(usageCounters)
        .values({ userId, periodKey: monthKey, periodType: 'monthly', jobsUsed: 0, tokensUsed })
        .onConflictDoUpdate({
          target: [usageCounters.userId, usageCounters.periodKey, usageCounters.periodType],
          set: { tokensUsed: sql`${usageCounters.tokensUsed} + ${tokensUsed}`, updatedAt: new Date() },
        });
    }

    // Check soft threshold for notifications
    await checkSoftThreshold(userId);
  } catch (err) {
    logger.warn(`[Billing] incrementUsage failed: ${(err as Error).message}`);
  }
}

/**
 * Check soft threshold and create notification if needed (dedupe per day)
 */
async function checkSoftThreshold(userId: string): Promise<void> {
  try {
    const usage = await getUsageSummary(userId);
    const settings = await getWorkspaceBillingSettings();

    const thresholdPct = parseFloat(String(settings.softThresholdPct)) * 100;
    if (usage.percentJobsUsed >= thresholdPct || usage.percentTokensUsed >= thresholdPct) {
      const todayKey = new Date().toISOString().slice(0, 10);
      // Dedupe: check if notification already sent today
      const existing = await db
        .select({ id: billingNotifications.id })
        .from(billingNotifications)
        .where(and(
          eq(billingNotifications.userId, userId),
          eq(billingNotifications.type, 'soft_threshold'),
          sql`${billingNotifications.createdAt}::date = ${todayKey}::date`,
        ))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(billingNotifications).values({
          userId,
          type: 'soft_threshold',
          payload: { percentJobsUsed: usage.percentJobsUsed, percentTokensUsed: usage.percentTokensUsed, threshold: thresholdPct },
        });
      }
    }
  } catch {
    // Non-critical
  }
}

/**
 * Get workspace billing settings (singleton)
 */
export async function getWorkspaceBillingSettings(): Promise<BillingSettings> {
  try {
    const [row] = await db.select().from(workspaceBillingSettings).limit(1);
    if (!row) {
      return { monthlyBudgetUsd: null, softThresholdPct: 0.80, hardStopEnabled: true };
    }
    return {
      monthlyBudgetUsd: row.monthlyBudgetUsd ? parseFloat(String(row.monthlyBudgetUsd)) : null,
      softThresholdPct: parseFloat(String(row.softThresholdPct)),
      hardStopEnabled: row.hardStopEnabled,
    };
  } catch {
    return { monthlyBudgetUsd: null, softThresholdPct: 0.80, hardStopEnabled: true };
  }
}

/**
 * Update workspace billing settings (admin-only)
 */
export async function updateWorkspaceBillingSettings(settings: Partial<BillingSettings>): Promise<BillingSettings> {
  const [existing] = await db.select().from(workspaceBillingSettings).limit(1);

  if (existing) {
    await db.update(workspaceBillingSettings)
      .set({
        ...(settings.monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd: settings.monthlyBudgetUsd?.toString() ?? null } : {}),
        ...(settings.softThresholdPct !== undefined ? { softThresholdPct: settings.softThresholdPct.toString() } : {}),
        ...(settings.hardStopEnabled !== undefined ? { hardStopEnabled: settings.hardStopEnabled } : {}),
        updatedAt: new Date(),
      })
      .where(eq(workspaceBillingSettings.id, existing.id));
  } else {
    await db.insert(workspaceBillingSettings).values({
      monthlyBudgetUsd: settings.monthlyBudgetUsd?.toString() ?? null,
      softThresholdPct: (settings.softThresholdPct ?? 0.80).toString(),
      hardStopEnabled: settings.hardStopEnabled ?? true,
    });
  }

  return getWorkspaceBillingSettings();
}

/**
 * Get user billing override
 */
export async function getUserOverride(userId: string): Promise<UserOverride | null> {
  try {
    const [row] = await db.select().from(userBillingOverrides).where(eq(userBillingOverrides.userId, userId)).limit(1);
    if (!row) return null;
    return {
      userId: row.userId,
      monthlyBudgetUsd: row.monthlyBudgetUsd ? parseFloat(String(row.monthlyBudgetUsd)) : null,
      isUnlimited: row.isUnlimited,
    };
  } catch {
    return null;
  }
}

/**
 * Set user billing override (admin-only)
 */
export async function setUserOverride(userId: string, override: { monthlyBudgetUsd?: number | null; isUnlimited?: boolean }): Promise<void> {
  await db
    .insert(userBillingOverrides)
    .values({
      userId,
      monthlyBudgetUsd: override.monthlyBudgetUsd?.toString() ?? null,
      isUnlimited: override.isUnlimited ?? false,
    })
    .onConflictDoUpdate({
      target: [userBillingOverrides.userId],
      set: {
        ...(override.monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd: override.monthlyBudgetUsd?.toString() ?? null } : {}),
        ...(override.isUnlimited !== undefined ? { isUnlimited: override.isUnlimited } : {}),
        updatedAt: new Date(),
      },
    });
}

/**
 * Get billing notifications for a user
 */
export async function getNotifications(userId: string, limit = 20): Promise<{ id: string; type: string; payload: unknown; readAt: Date | null; createdAt: Date }[]> {
  try {
    return await db
      .select()
      .from(billingNotifications)
      .where(eq(billingNotifications.userId, userId))
      .orderBy(desc(billingNotifications.createdAt))
      .limit(limit);
  } catch {
    return [];
  }
}

/**
 * Get all available plans (for pricing page / plan selector)
 */
export async function getAvailablePlans() {
  try {
    return db.select().from(plans).where(eq(plans.isActive, true)).orderBy(plans.sortOrder);
  } catch {
    return [];
  }
}
