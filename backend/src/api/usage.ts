/**
 * Usage API - Token usage and cost tracking
 * GET /api/usage/current-month - Get usage stats for current month
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { and, gte, sql } from 'drizzle-orm';
import { requireAuth } from '../utils/auth.js';

// Config-driven free tier (can be moved to env vars later)
const FREE_TIER = {
  tokens: 100_000,
  costUsd: 0.50,
};

export async function usageRoutes(fastify: FastifyInstance) {
  // GET /api/usage/current-month - Get usage stats for current month
  fastify.get(
    '/api/usage/current-month',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireAuth(request);

        // Get first day of current month
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        // Aggregate usage from jobs created this month
        // Note: In a full implementation, we'd use a separate usage tracking table
        // For MVP, we aggregate from jobs table
        const result = await db
          .select({
            inputTokens: sql<number>`COALESCE(SUM(${jobs.aiInputTokens}), 0)::int`,
            outputTokens: sql<number>`COALESCE(SUM(${jobs.aiOutputTokens}), 0)::int`,
            totalTokens: sql<number>`COALESCE(SUM(${jobs.aiTotalTokens}), 0)::int`,
            estimatedCostUsd: sql<string>`COALESCE(SUM(${jobs.aiEstimatedCostUsd}), 0)::numeric(12,6)`,
            jobCount: sql<number>`COUNT(*)::int`,
          })
          .from(jobs)
          .where(
            and(
              // Filter by job payload userId (Scribe jobs store userId in payload)
              sql`(${jobs.payload}->>'userId')::text = ${user.id}`,
              gte(jobs.createdAt, startOfMonth)
            )
          );

        const stats = result[0] || {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: '0',
          jobCount: 0,
        };

        const usedCostUsd = parseFloat(stats.estimatedCostUsd) || 0;
        const usedTokens = stats.totalTokens || 0;

        // Calculate remaining free quota
        const remainingTokens = Math.max(0, FREE_TIER.tokens - usedTokens);
        const remainingCostUsd = Math.max(0, FREE_TIER.costUsd - usedCostUsd);

        // Determine if over free tier
        const isOverFreeTokens = usedTokens > FREE_TIER.tokens;
        const isOverFreeCost = usedCostUsd > FREE_TIER.costUsd;
        const onDemandTokens = isOverFreeTokens ? usedTokens - FREE_TIER.tokens : 0;
        const onDemandCostUsd = isOverFreeCost ? usedCostUsd - FREE_TIER.costUsd : 0;

        // Daily breakdown for the current month
        const dailyResult = await db
          .select({
            day: sql<string>`TO_CHAR(${jobs.createdAt}, 'YYYY-MM-DD')`,
            tokens: sql<number>`COALESCE(SUM(${jobs.aiTotalTokens}), 0)::int`,
            cost: sql<string>`COALESCE(SUM(${jobs.aiEstimatedCostUsd}), 0)::numeric(12,6)`,
            jobCount: sql<number>`COUNT(*)::int`,
          })
          .from(jobs)
          .where(
            and(
              sql`(${jobs.payload}->>'userId')::text = ${user.id}`,
              gte(jobs.createdAt, startOfMonth)
            )
          )
          .groupBy(sql`TO_CHAR(${jobs.createdAt}, 'YYYY-MM-DD')`)
          .orderBy(sql`TO_CHAR(${jobs.createdAt}, 'YYYY-MM-DD')`);

        const daily = dailyResult.map(d => ({
          date: d.day,
          tokens: d.tokens,
          cost: parseFloat(parseFloat(d.cost).toFixed(6)),
          jobs: d.jobCount,
        }));

        return reply.code(200).send({
          period: {
            start: startOfMonth.toISOString(),
            end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString(),
          },
          usage: {
            inputTokens: stats.inputTokens,
            outputTokens: stats.outputTokens,
            totalTokens: stats.totalTokens,
            estimatedCostUsd: parseFloat(parseFloat(stats.estimatedCostUsd).toFixed(6)),
            jobCount: stats.jobCount,
          },
          freeQuota: {
            tokens: FREE_TIER.tokens,
            costUsd: FREE_TIER.costUsd,
          },
          used: {
            tokens: usedTokens,
            costUsd: parseFloat(usedCostUsd.toFixed(6)),
          },
          remaining: {
            tokens: remainingTokens,
            costUsd: parseFloat(remainingCostUsd.toFixed(6)),
          },
          onDemand: {
            tokens: onDemandTokens,
            costUsd: parseFloat(onDemandCostUsd.toFixed(6)),
          },
          percentUsed: {
            tokens: Math.min(100, (usedTokens / FREE_TIER.tokens) * 100),
            cost: Math.min(100, (usedCostUsd / FREE_TIER.costUsd) * 100),
          },
          daily,
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
