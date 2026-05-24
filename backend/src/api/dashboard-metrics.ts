import { FastifyInstance } from 'fastify';
import { sql, and, gte, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { requireAuth } from '../utils/auth.js';

interface DashboardMetrics {
  period: '7d' | '30d';
  avgQualityScore: number | null;
  successRate: number;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  topFailureReason: string | null;
  topFailureCount: number;
}

export async function dashboardMetricsRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/dashboard/metrics
   * Returns aggregated quality and reliability metrics for the dashboard
   */
  fastify.get(
    '/api/dashboard/metrics',
    {
      schema: {
        description: 'Get dashboard quality and reliability metrics',
        tags: ['dashboard'],
        querystring: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['7d', '30d'], default: '7d' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              period: { type: 'string' },
              avgQualityScore: { type: ['number', 'null'] },
              successRate: { type: 'number' },
              totalJobs: { type: 'number' },
              completedJobs: { type: 'number' },
              failedJobs: { type: 'number' },
              topFailureReason: { type: ['string', 'null'] },
              topFailureCount: { type: 'number' },
            },
          },
        },
      },
    },
    async (request) => {
      const user = await requireAuth(request);
      const query = request.query as { period?: '7d' | '30d' } | undefined;
      const period = query?.period || '7d';
      const daysAgo = period === '30d' ? 30 : 7;
      const since = new Date();
      since.setDate(since.getDate() - daysAgo);

      const userIdFilter = eq(sql`(${jobs.payload}->>'userId')::text`, user.id);

      // Get aggregate stats
      const [stats] = await db
        .select({
          totalJobs: sql<number>`count(*)::int`,
          completedJobs: sql<number>`count(*) filter (where ${jobs.state} = 'completed')::int`,
          failedJobs: sql<number>`count(*) filter (where ${jobs.state} = 'failed')::int`,
          avgQualityScore: sql<number | null>`avg(${jobs.qualityScore})::float`,
        })
        .from(jobs)
        .where(and(gte(jobs.createdAt, since), userIdFilter));

      // Get top failure reason
      const failureReasons = await db
        .select({
          errorCode: jobs.errorCode,
          count: sql<number>`count(*)::int`,
        })
        .from(jobs)
        .where(
          and(
            gte(jobs.createdAt, since),
            eq(jobs.state, 'failed'),
            userIdFilter
          )
        )
        .groupBy(jobs.errorCode)
        .orderBy(sql`count(*) desc`)
        .limit(1);

      const total = stats.totalJobs || 0;
      const completed = stats.completedJobs || 0;
      const failed = stats.failedJobs || 0;

      const result: DashboardMetrics = {
        period,
        avgQualityScore: stats.avgQualityScore ? Math.round(stats.avgQualityScore * 10) / 10 : null,
        successRate: total > 0 ? Math.round((completed / total) * 100) : 100,
        totalJobs: total,
        completedJobs: completed,
        failedJobs: failed,
        topFailureReason: failureReasons[0]?.errorCode || null,
        topFailureCount: failureReasons[0]?.count || 0,
      };

      return result;
    }
  );
}
