/**
 * Usage API - Token usage and cost tracking
 * GET /api/usage/current-month - Get usage stats for current month
 *
 * Queries the pipelines table (not legacy jobs table) for real pipeline data.
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/client.js';
import { pipelines } from '../db/schema.js';
import { and, eq, gte, sql, ne } from 'drizzle-orm';
import { requireAuth } from '../utils/auth.js';

// Config-driven free tier
const FREE_TIER = {
  tokens: 100_000,
  costUsd: 0.50,
};

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

        // Estimate cost from tokens if no explicit cost stored
        const storedCost = parseFloat(stats.estimatedCost) || 0;
        const estimatedCostUsd = storedCost > 0
          ? storedCost
          : (inputTokens * COST_PER_INPUT_TOKEN) + (outputTokens * COST_PER_OUTPUT_TOKEN);

        // Calculate remaining free quota
        const remainingTokens = Math.max(0, FREE_TIER.tokens - totalTokens);
        const remainingCostUsd = Math.max(0, FREE_TIER.costUsd - estimatedCostUsd);

        const onDemandTokens = totalTokens > FREE_TIER.tokens ? totalTokens - FREE_TIER.tokens : 0;
        const onDemandCostUsd = estimatedCostUsd > FREE_TIER.costUsd ? estimatedCostUsd - FREE_TIER.costUsd : 0;

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
            inputTokens,
            outputTokens,
            totalTokens,
            estimatedCostUsd: parseFloat(estimatedCostUsd.toFixed(6)),
            jobCount: stats.jobCount,
          },
          freeQuota: {
            tokens: FREE_TIER.tokens,
            costUsd: FREE_TIER.costUsd,
          },
          used: {
            tokens: totalTokens,
            costUsd: parseFloat(estimatedCostUsd.toFixed(6)),
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
            tokens: Math.min(100, (totalTokens / FREE_TIER.tokens) * 100),
            cost: Math.min(100, (estimatedCostUsd / FREE_TIER.costUsd) * 100),
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
