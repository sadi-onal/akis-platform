/**
 * Analytics API — GET /api/analytics
 *
 * Period-based aggregate queries across job_ai_calls, pipelines, and
 * agent_activities. Returns summary KPIs, time-series, provider/model/agent
 * breakdowns, pipeline performance, and critic stats.
 *
 * Cost accounting mirrors usage.ts: admin → wholesale, member → retail.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sql, and, gte, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelines, jobAiCalls } from '../db/schema.js';
import { requireAuth } from '../utils/auth.js';
import { aggregateCost } from '../services/billing/CostCalculator.js';

type Period = '7d' | '14d' | '30d' | '90d';

const PERIOD_DAYS: Record<Period, number> = {
  '7d': 7,
  '14d': 14,
  '30d': 30,
  '90d': 90,
};

function parsePeriod(raw: unknown): Period {
  if (typeof raw === 'string' && raw in PERIOD_DAYS) return raw as Period;
  return '30d';
}

function resolveGroupBy(period: Period): 'day' | 'week' {
  return period === '90d' ? 'week' : 'day';
}

export async function analyticsRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/api/analytics',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await requireAuth(request);
      const query = request.query as Record<string, unknown>;
      const period = parsePeriod(query?.period);
      const days = PERIOD_DAYS[period];
      const groupBy = resolveGroupBy(period);

      const since = new Date();
      since.setDate(since.getDate() - days);

      // ── Summary KPIs ──────────────────────────────────────────────
      const [summaryRow] = await db
        .select({
          totalPipelines: sql<number>`COUNT(DISTINCT ${pipelines.id})::int`,
          successCount: sql<number>`COUNT(DISTINCT ${pipelines.id}) FILTER (WHERE ${pipelines.stage} IN ('completed', 'completed_partial'))::int`,
          failedCount: sql<number>`COUNT(DISTINCT ${pipelines.id}) FILTER (WHERE ${pipelines.stage} = 'failed')::int`,
          avgDurationMs: sql<number | null>`AVG((${pipelines.metrics}->>'totalDurationMs')::numeric)::int`,
        })
        .from(pipelines)
        .where(and(eq(pipelines.userId, user.id), gte(pipelines.createdAt, since)));

      const totalPipelines = summaryRow?.totalPipelines ?? 0;
      const successCount = summaryRow?.successCount ?? 0;
      const failedCount = summaryRow?.failedCount ?? 0;
      const resolvedCount = successCount + failedCount;
      const successRate = resolvedCount > 0
        ? Math.round((successCount / resolvedCount) * 100)
        : 100;
      const avgDurationMs = summaryRow?.avgDurationMs ?? 0;

      // Token summary from job_ai_calls (JOIN pipelines for user filter)
      const [tokenSummary] = await db
        .select({
          totalTokens: sql<number>`COALESCE(SUM(COALESCE(${jobAiCalls.totalTokens}, 0)), 0)::bigint`,
          inputTokens: sql<number>`COALESCE(SUM(COALESCE(${jobAiCalls.inputTokens}, 0)), 0)::bigint`,
          outputTokens: sql<number>`COALESCE(SUM(COALESCE(${jobAiCalls.outputTokens}, 0)), 0)::bigint`,
          totalCost: sql<string>`COALESCE(SUM(COALESCE(${jobAiCalls.estimatedCostUsd}::numeric, 0)), 0)::numeric(12,6)`,
          totalCalls: sql<number>`COUNT(*)::int`,
        })
        .from(jobAiCalls)
        .innerJoin(pipelines, eq(jobAiCalls.pipelineId, pipelines.id))
        .where(and(eq(pipelines.userId, user.id), gte(pipelines.createdAt, since)));

      const totalTokens = Number(tokenSummary?.totalTokens ?? 0);
      const inputTokens = Number(tokenSummary?.inputTokens ?? 0);
      const outputTokens = Number(tokenSummary?.outputTokens ?? 0);
      const wholesaleCost = parseFloat(String(tokenSummary?.totalCost ?? '0'));

      // Cache token aggregates
      let cacheReadTokens = 0;
      let cacheCreationTokens = 0;
      try {
        const cacheResult = await db.execute<{ cache_read: string; cache_creation: string }>(
          sql`SELECT
                COALESCE(SUM((p.metrics->>'cacheReadInputTokens')::bigint), 0)::text AS cache_read,
                COALESCE(SUM((p.metrics->>'cacheCreationInputTokens')::bigint), 0)::text AS cache_creation
              FROM pipelines p
              WHERE p.user_id = ${user.id} AND p.created_at >= ${since}`,
        );
        const cacheRow = cacheResult.rows[0];
        if (cacheRow) {
          cacheReadTokens = Number(cacheRow.cache_read);
          cacheCreationTokens = Number(cacheRow.cache_creation);
        }
      } catch { /* metrics columns may not have cache data yet */ }

      const cacheSavingsPercent = totalTokens > 0
        ? Math.round((cacheReadTokens / (totalTokens + cacheReadTokens)) * 100)
        : 0;

      const { displayCost: estimatedCostUsdDisplay } = aggregateCost(wholesaleCost, { role: user.role });

      // ── Time series (gap-filled with generate_series) ────────────
      // truncFn/interval are hardcoded ('day'|'week') — safe as sql.raw()
      const truncFn = sql.raw(groupBy === 'week' ? 'week' : 'day');
      const intervalLit = sql.raw(groupBy === 'week' ? '1 week' : '1 day');

      const timeSeriesRows = await db.execute<{
        date: string;
        pipeline_count: string;
        tokens: string;
        input_tokens: string;
        output_tokens: string;
        cost: string;
        success_count: string;
        fail_count: string;
      }>(
        sql`WITH date_range AS (
              SELECT TO_CHAR(d::date, 'YYYY-MM-DD') AS date
              FROM generate_series(
                DATE_TRUNC('${truncFn}', ${since}::timestamptz)::date,
                CURRENT_DATE,
                '${intervalLit}'::interval
              ) AS d
            ),
            pipeline_data AS (
              SELECT TO_CHAR(DATE_TRUNC('${truncFn}', p.created_at), 'YYYY-MM-DD') AS date,
                     COUNT(DISTINCT p.id)::text AS pipeline_count,
                     COALESCE(SUM(COALESCE(c.total_tokens, 0)), 0)::text AS tokens,
                     COALESCE(SUM(COALESCE(c.input_tokens, 0)), 0)::text AS input_tokens,
                     COALESCE(SUM(COALESCE(c.output_tokens, 0)), 0)::text AS output_tokens,
                     COALESCE(SUM(COALESCE(c.estimated_cost_usd::numeric, 0)), 0)::numeric(12,6)::text AS cost,
                     COUNT(DISTINCT p.id) FILTER (WHERE p.stage IN ('completed', 'completed_partial'))::text AS success_count,
                     COUNT(DISTINCT p.id) FILTER (WHERE p.stage = 'failed')::text AS fail_count
              FROM pipelines p
              LEFT JOIN job_ai_calls c ON c.pipeline_id = p.id
              WHERE p.user_id = ${user.id} AND p.created_at >= ${since}
              GROUP BY TO_CHAR(DATE_TRUNC('${truncFn}', p.created_at), 'YYYY-MM-DD')
            )
            SELECT dr.date,
                   COALESCE(pd.pipeline_count, '0') AS pipeline_count,
                   COALESCE(pd.tokens, '0') AS tokens,
                   COALESCE(pd.input_tokens, '0') AS input_tokens,
                   COALESCE(pd.output_tokens, '0') AS output_tokens,
                   COALESCE(pd.cost, '0.000000') AS cost,
                   COALESCE(pd.success_count, '0') AS success_count,
                   COALESCE(pd.fail_count, '0') AS fail_count
            FROM date_range dr
            LEFT JOIN pipeline_data pd ON pd.date = dr.date
            ORDER BY dr.date`,
      );

      const timeSeries = timeSeriesRows.rows.map((r) => ({
        date: r.date,
        pipelines: Number(r.pipeline_count),
        tokens: Number(r.tokens),
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        cost: parseFloat(r.cost),
        successCount: Number(r.success_count),
        failCount: Number(r.fail_count),
      }));

      // ── Provider breakdown ────────────────────────────────────────
      const providerRows = await db.execute<{
        provider: string;
        calls: string;
        tokens: string;
        cost: string;
        avg_duration: string;
      }>(
        sql`SELECT c.provider,
                   COUNT(*)::text AS calls,
                   COALESCE(SUM(COALESCE(c.total_tokens, 0)), 0)::text AS tokens,
                   COALESCE(SUM(COALESCE(c.estimated_cost_usd::numeric, 0)), 0)::numeric(12,6)::text AS cost,
                   COALESCE(AVG(c.duration_ms), 0)::int::text AS avg_duration
            FROM job_ai_calls c
            JOIN pipelines p ON c.pipeline_id = p.id
            WHERE p.user_id = ${user.id} AND p.created_at >= ${since}
            GROUP BY c.provider
            ORDER BY SUM(COALESCE(c.total_tokens, 0)) DESC`,
      );

      const providerBreakdown = providerRows.rows.map((r) => ({
        provider: r.provider,
        calls: Number(r.calls),
        tokens: Number(r.tokens),
        cost: parseFloat(r.cost),
        avgDurationMs: Number(r.avg_duration),
      }));

      // ── Model breakdown ───────────────────────────────────────────
      const modelRows = await db.execute<{
        model: string;
        provider: string;
        calls: string;
        input_tokens: string;
        output_tokens: string;
        cost: string;
      }>(
        sql`SELECT c.model, c.provider,
                   COUNT(*)::text AS calls,
                   COALESCE(SUM(COALESCE(c.input_tokens, 0)), 0)::text AS input_tokens,
                   COALESCE(SUM(COALESCE(c.output_tokens, 0)), 0)::text AS output_tokens,
                   COALESCE(SUM(COALESCE(c.estimated_cost_usd::numeric, 0)), 0)::numeric(12,6)::text AS cost
            FROM job_ai_calls c
            JOIN pipelines p ON c.pipeline_id = p.id
            WHERE p.user_id = ${user.id} AND p.created_at >= ${since}
            GROUP BY c.model, c.provider
            ORDER BY SUM(COALESCE(c.total_tokens, 0)) DESC`,
      );

      const modelBreakdown = modelRows.rows.map((r) => ({
        model: r.model,
        provider: r.provider,
        calls: Number(r.calls),
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        cost: parseFloat(r.cost),
      }));

      // ── Agent breakdown (from job_ai_calls.purpose) ────────────────
      // Token data is stored in job_ai_calls, not agent_activities.
      // The `purpose` column maps to agent names (scribe, proto, trace, etc.).
      let agentBreakdown: Array<{
        agent: string;
        calls: number;
        inputTokens: number;
        outputTokens: number;
        avgConfidence: number | null;
      }> = [];
      try {
        // Primary: aggregate from job_ai_calls grouped by purpose
        const agentTokenRows = await db.execute<{
          agent: string;
          calls: string;
          input_tokens: string;
          output_tokens: string;
        }>(
          sql`SELECT COALESCE(c.purpose, 'unknown') AS agent,
                     COUNT(*)::text AS calls,
                     COALESCE(SUM(COALESCE(c.input_tokens, 0)), 0)::text AS input_tokens,
                     COALESCE(SUM(COALESCE(c.output_tokens, 0)), 0)::text AS output_tokens
              FROM job_ai_calls c
              JOIN pipelines p ON c.pipeline_id = p.id
              WHERE p.user_id = ${user.id} AND p.created_at >= ${since}
              GROUP BY COALESCE(c.purpose, 'unknown')
              ORDER BY SUM(COALESCE(c.total_tokens, 0)) DESC`,
        );

        // Optionally enrich with avg confidence from agent_activities
        const confidenceMap: Record<string, number> = {};
        try {
          const confRows = await db.execute<{ agent: string; avg_confidence: string | null }>(
            sql`SELECT aa.agent,
                       ROUND(AVG(aa.confidence)::numeric, 2)::text AS avg_confidence
                FROM agent_activities aa
                JOIN pipelines p ON aa.pipeline_id = p.id
                WHERE p.user_id = ${user.id} AND p.created_at >= ${since}
                GROUP BY aa.agent`,
          );
          for (const r of confRows.rows) {
            if (r.avg_confidence) confidenceMap[r.agent] = parseFloat(r.avg_confidence);
          }
        } catch { /* agent_activities table may not exist yet */ }

        agentBreakdown = agentTokenRows.rows.map((r) => ({
          agent: r.agent,
          calls: Number(r.calls),
          inputTokens: Number(r.input_tokens),
          outputTokens: Number(r.output_tokens),
          avgConfidence: confidenceMap[r.agent] ?? null,
        }));
      } catch { /* graceful degradation */ }

      // ── Purpose breakdown ─────────────────────────────────────────
      const purposeRows = await db.execute<{
        purpose: string;
        calls: string;
        tokens: string;
        cost: string;
      }>(
        sql`SELECT COALESCE(c.purpose, 'unknown') AS purpose,
                   COUNT(*)::text AS calls,
                   COALESCE(SUM(COALESCE(c.total_tokens, 0)), 0)::text AS tokens,
                   COALESCE(SUM(COALESCE(c.estimated_cost_usd::numeric, 0)), 0)::numeric(12,6)::text AS cost
            FROM job_ai_calls c
            JOIN pipelines p ON c.pipeline_id = p.id
            WHERE p.user_id = ${user.id} AND p.created_at >= ${since}
            GROUP BY COALESCE(c.purpose, 'unknown')
            ORDER BY SUM(COALESCE(c.total_tokens, 0)) DESC`,
      );

      const purposeBreakdown = purposeRows.rows.map((r) => ({
        purpose: r.purpose,
        calls: Number(r.calls),
        tokens: Number(r.tokens),
        cost: parseFloat(r.cost),
      }));

      // ── Pipeline performance ──────────────────────────────────────
      const [perfRow] = await db
        .select({
          avgScribeMs: sql<number | null>`AVG(
            CASE WHEN ${pipelines.metrics}->>'scribeCompletedAt' IS NOT NULL
                  AND ${pipelines.metrics}->>'startedAt' IS NOT NULL
            THEN EXTRACT(EPOCH FROM (
              (${pipelines.metrics}->>'scribeCompletedAt')::timestamptz
              - (${pipelines.metrics}->>'startedAt')::timestamptz
            )) * 1000
            END
          )::int`,
          avgProtoMs: sql<number | null>`AVG(
            CASE WHEN ${pipelines.metrics}->>'protoCompletedAt' IS NOT NULL
                  AND ${pipelines.metrics}->>'approvedAt' IS NOT NULL
            THEN EXTRACT(EPOCH FROM (
              (${pipelines.metrics}->>'protoCompletedAt')::timestamptz
              - (${pipelines.metrics}->>'approvedAt')::timestamptz
            )) * 1000
            END
          )::int`,
          avgTraceMs: sql<number | null>`AVG(
            CASE WHEN ${pipelines.metrics}->>'traceCompletedAt' IS NOT NULL
                  AND ${pipelines.metrics}->>'protoCompletedAt' IS NOT NULL
            THEN EXTRACT(EPOCH FROM (
              (${pipelines.metrics}->>'traceCompletedAt')::timestamptz
              - (${pipelines.metrics}->>'protoCompletedAt')::timestamptz
            )) * 1000
            END
          )::int`,
          avgTotalMs: sql<number | null>`AVG((${pipelines.metrics}->>'totalDurationMs')::numeric)::int`,
        })
        .from(pipelines)
        .where(and(eq(pipelines.userId, user.id), gte(pipelines.createdAt, since)));

      // Top errors
      let topErrors: Array<{ code: string; count: number }> = [];
      try {
        const errorRows = await db.execute<{ code: string; count: string }>(
          sql`SELECT error->>'code' AS code, COUNT(*)::text AS count
              FROM pipelines
              WHERE error IS NOT NULL AND user_id = ${user.id} AND created_at >= ${since}
              GROUP BY error->>'code'
              ORDER BY COUNT(*) DESC
              LIMIT 10`,
        );
        topErrors = errorRows.rows
          .filter((r) => r.code)
          .map((r) => ({ code: r.code, count: Number(r.count) }));
      } catch { /* error column format may differ */ }

      // Retries by stage
      const retrysByStage: Record<string, number> = {};
      try {
        const retryRows = await db.execute<{ stage: string; retries: string }>(
          sql`SELECT stage::text,
                     COUNT(*) FILTER (WHERE (metrics->>'retryCount')::int > 0)::text AS retries
              FROM pipelines
              WHERE user_id = ${user.id} AND created_at >= ${since}
              GROUP BY stage`,
        );
        for (const r of retryRows.rows) {
          if (Number(r.retries) > 0) retrysByStage[r.stage] = Number(r.retries);
        }
      } catch { /* metrics column format may differ */ }

      // ── Critic stats ──────────────────────────────────────────────
      let criticStats = {
        totalReviews: 0,
        approvalRate: 0,
        avgScore: 0,
        fixLoopTriggerRate: 0,
        iterateLoopCount: 0,
      };
      try {
        const criticRows = await db.execute<{
          total: string;
          approved: string;
          avg_score: string | null;
          fix_loops: string;
          iterate_loops: string;
        }>(
          sql`SELECT
                COUNT(*) FILTER (WHERE stage::text IN ('critic_reviewing_spec', 'critic_reviewing_code', 'awaiting_critic_resolution') OR stage::text LIKE 'completed%')::text AS total,
                COUNT(*) FILTER (WHERE stage::text IN ('completed', 'completed_partial'))::text AS approved,
                ROUND(AVG((metrics->>'criticScore')::numeric), 1)::text AS avg_score,
                COUNT(*) FILTER (WHERE stage::text = 'fix_loop_iteration')::text AS fix_loops,
                COALESCE(SUM(GREATEST((metrics->>'iterationCount')::int - 1, 0)), 0)::text AS iterate_loops
              FROM pipelines
              WHERE user_id = ${user.id} AND created_at >= ${since}`,
        );
        if (criticRows.rows[0]) {
          const cr = criticRows.rows[0];
          const totalReviews = Number(cr.total);
          const approved = Number(cr.approved);
          criticStats = {
            totalReviews,
            approvalRate: totalReviews > 0 ? Math.round((approved / totalReviews) * 100) : 0,
            avgScore: cr.avg_score ? parseFloat(cr.avg_score) : 0,
            fixLoopTriggerRate: totalPipelines > 0
              ? Math.round((Number(cr.fix_loops) / totalPipelines) * 100)
              : 0,
            iterateLoopCount: Number(cr.iterate_loops),
          };
        }
      } catch { /* critic metrics may not be available */ }

      return reply.code(200).send({
        period,
        summary: {
          totalPipelines,
          totalTokens,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          cacheSavingsPercent,
          successRate,
          avgDurationMs,
          estimatedCostUsd: parseFloat(estimatedCostUsdDisplay.toFixed(6)),
        },
        timeSeries,
        providerBreakdown,
        modelBreakdown,
        agentBreakdown,
        purposeBreakdown,
        pipelinePerformance: {
          avgScribeDurationMs: perfRow?.avgScribeMs ?? 0,
          avgProtoDurationMs: perfRow?.avgProtoMs ?? 0,
          avgTraceDurationMs: perfRow?.avgTraceMs ?? 0,
          avgTotalDurationMs: perfRow?.avgTotalMs ?? 0,
          topErrors,
          retrysByStage,
        },
        criticStats,
      });
    },
  );
}
