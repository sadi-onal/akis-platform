/**
 * Usage API - Token usage and cost tracking (analytics only).
 *
 * Queries the pipelines table for the current month's metrics. No plan
 * tier / quota / limit enforcement — every account is unlimited.
 *
 * Cost accounting:
 *   - Admins see the REAL wholesale cost we pay the provider plus a breakdown.
 *   - Regular users see retail = wholesale × AI_COST_MARKUP.
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/client.js';
import { pipelines } from '../db/schema.js';
import { and, eq, gte, sql, ne } from 'drizzle-orm';
import { requireAuth } from '../utils/auth.js';
import { aggregateCost, type CostBreakdown } from '../services/billing/CostCalculator.js';

// Cost estimation per token (Claude Sonnet 4 pricing as baseline)
const COST_PER_INPUT_TOKEN = 3.0 / 1_000_000; // $3 per 1M input tokens
const COST_PER_OUTPUT_TOKEN = 15.0 / 1_000_000; // $15 per 1M output tokens

export async function usageRoutes(fastify: FastifyInstance) {
  // GET /api/usage/current-month
  fastify.get(
    '/api/usage/current-month',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);

        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        // Aggregate usage from pipelines created this month
        const result = await db
          .select({
            jobCount: sql<number>`COUNT(*)::int`,
            inputTokens: sql<number>`COALESCE(SUM((${pipelines.metrics}->>'inputTokens')::int), 0)::int`,
            outputTokens: sql<number>`COALESCE(SUM((${pipelines.metrics}->>'outputTokens')::int), 0)::int`,
            totalTokens: sql<number>`COALESCE(SUM((${pipelines.metrics}->>'totalTokens')::int), 0)::int`,
            estimatedCost: sql<string>`COALESCE(SUM((${pipelines.metrics}->>'estimatedCost')::numeric), 0)::numeric(12,6)`,
          })
          .from(pipelines)
          .where(
            and(
              eq(pipelines.userId, user.id),
              gte(pipelines.createdAt, startOfMonth),
              ne(pipelines.stage, 'cancelled'),
            )
          );

        const stats = result[0] || {
          jobCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCost: '0',
        };

        const inputTokens = stats.inputTokens || 0;
        const outputTokens = stats.outputTokens || 0;
        const totalTokens = stats.totalTokens || 0;

        // Wholesale cost — either from stored per-pipeline metrics or estimated from tokens.
        // This is what the provider actually charges us; it is the basis for role-aware display.
        const storedCost = parseFloat(stats.estimatedCost) || 0;
        const wholesaleCostUsd = storedCost > 0
          ? storedCost
          : (inputTokens * COST_PER_INPUT_TOKEN) + (outputTokens * COST_PER_OUTPUT_TOKEN);

        // Role-aware display cost: admin → wholesale, user → retail (wholesale × markup).
        // Breakdown is only echoed to admins below.
        const { displayCost: estimatedCostUsd, breakdown } = aggregateCost(
          wholesaleCostUsd,
          { role: user.role },
        );
        const userIsAdmin = user.role === 'admin';

        // Daily breakdown
        const dailyResult = await db
          .select({
            day: sql<string>`TO_CHAR(${pipelines.createdAt}, 'YYYY-MM-DD')`,
            tokens: sql<number>`COALESCE(SUM((${pipelines.metrics}->>'totalTokens')::int), 0)::int`,
            cost: sql<string>`COALESCE(SUM((${pipelines.metrics}->>'estimatedCost')::numeric), 0)::numeric(12,6)`,
            jobCount: sql<number>`COUNT(*)::int`,
          })
          .from(pipelines)
          .where(
            and(
              eq(pipelines.userId, user.id),
              gte(pipelines.createdAt, startOfMonth),
              ne(pipelines.stage, 'cancelled'),
            )
          )
          .groupBy(sql`TO_CHAR(${pipelines.createdAt}, 'YYYY-MM-DD')`)
          .orderBy(sql`TO_CHAR(${pipelines.createdAt}, 'YYYY-MM-DD')`);

        // Daily rows — apply same role-aware cost transform per day so the UI
        // chart and the totals line up.
        const daily = dailyResult.map(d => {
          const dailyWholesale = parseFloat(d.cost) || 0;
          const { displayCost: dailyDisplay } = aggregateCost(dailyWholesale, { role: user.role });
          return {
            date: d.day,
            tokens: d.tokens,
            cost: parseFloat(dailyDisplay.toFixed(6)),
            jobs: d.jobCount,
          };
        });

        // Admin-only breakdown payload — strip for non-admins so wholesale
        // prices don't leak to end users.
        const adminCostPayload: {
          breakdown: CostBreakdown;
          wholesaleCostUsd: number;
          userIsAdmin: true;
        } | { userIsAdmin: false } = userIsAdmin
          ? {
              userIsAdmin: true,
              wholesaleCostUsd: parseFloat(wholesaleCostUsd.toFixed(6)),
              breakdown,
            }
          : { userIsAdmin: false };

        return reply.code(200).send({
          period: {
            start: startOfMonth.toISOString(),
            end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString(),
          },
          usage: {
            inputTokens,
            outputTokens,
            totalTokens,
            estimatedCostUsd: parseFloat(estimatedCostUsd.toFixed(6)),
            jobCount: stats.jobCount,
          },
          daily,
          ...adminCostPayload,
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }
        throw err;
      }
    }
  );

  // GET /api/usage — Aggregate monthly usage (analytics only, no plan limits)
  fastify.get(
    '/api/usage',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);

        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const result = await db
          .select({
            totalJobs: sql<number>`COUNT(*)::int`,
            totalTokens: sql<number>`COALESCE(SUM((${pipelines.metrics}->>'totalTokens')::int), 0)::int`,
            estimatedCost: sql<string>`COALESCE(SUM((${pipelines.metrics}->>'estimatedCost')::numeric), 0)::numeric(12,6)`,
          })
          .from(pipelines)
          .where(
            and(
              eq(pipelines.userId, user.id),
              gte(pipelines.createdAt, startOfMonth),
              ne(pipelines.stage, 'cancelled'),
            )
          );

        const stats = result[0] || { totalJobs: 0, totalTokens: 0, estimatedCost: '0' };

        const wholesaleCostUsd = parseFloat(stats.estimatedCost) || 0;
        const { displayCost: estimatedCostDisplay, breakdown } = aggregateCost(
          wholesaleCostUsd,
          { role: user.role },
        );
        const userIsAdmin = user.role === 'admin';

        const adminCostPayload: {
          breakdown: CostBreakdown;
          wholesaleCostUsd: number;
          userIsAdmin: true;
        } | { userIsAdmin: false } = userIsAdmin
          ? {
              userIsAdmin: true,
              wholesaleCostUsd: parseFloat(wholesaleCostUsd.toFixed(6)),
              breakdown,
            }
          : { userIsAdmin: false };

        return reply.code(200).send({
          totalJobs: stats.totalJobs,
          totalTokens: stats.totalTokens,
          estimatedCost: parseFloat(estimatedCostDisplay.toFixed(6)),
          period: 'monthly',
          role: user.role,
          ...adminCostPayload,
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }
        throw err;
      }
    }
  );
}
