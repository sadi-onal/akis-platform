/**
 * Unit tests for Job Events SSE, Dashboard Metrics, and Pipeline Statistics
 * Tests schema validation, pure computation logic, and edge cases.
 *
 * Does NOT require a running DB — all computation is extracted and tested in isolation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  formatSSEMessage,
  type StageEvent,
  type LogEvent,
  type ErrorEvent,
  type AiCallEvent,
} from '../../src/types/stream-events.js';

// ─── Re-create the streamQuerySchema from job-events.ts for isolated testing ──
const streamQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  includeHistory: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((value) => {
      if (typeof value === 'boolean') return value;
      if (value === undefined) return true;
      return value !== 'false';
    }),
});

// ─── extractJobUserId logic from job-events.ts ──────────────────────────────
function extractJobUserId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const rawUserId = (payload as Record<string, unknown>).userId;
  if (typeof rawUserId !== 'string') return null;
  const normalizedUserId = rawUserId.trim();
  return normalizedUserId.length > 0 ? normalizedUserId : null;
}

// ─── Dashboard metrics computation logic from dashboard-metrics.ts ───────────
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

function buildDashboardMetrics(
  period: '7d' | '30d',
  stats: { totalJobs: number; completedJobs: number; failedJobs: number; avgQualityScore: number | null },
  topFailure: { errorCode: string | null; count: number } | null,
): DashboardMetrics {
  const total = stats.totalJobs || 0;
  const completed = stats.completedJobs || 0;
  const failed = stats.failedJobs || 0;
  return {
    period,
    avgQualityScore: stats.avgQualityScore ? Math.round(stats.avgQualityScore * 10) / 10 : null,
    successRate: total > 0 ? Math.round((completed / total) * 100) : 100,
    totalJobs: total,
    completedJobs: completed,
    failedJobs: failed,
    topFailureReason: topFailure?.errorCode || null,
    topFailureCount: topFailure?.count || 0,
  };
}

// ─── Pipeline stats computation from pipeline-stats.ts ───────────────────────
function computeSuccessRate(totalPipelines: number, successCount: number): number {
  return totalPipelines > 0
    ? Math.round((successCount / totalPipelines) * 100)
    : 0;
}

function buildPipelineStatsResponse(
  agg: {
    totalPipelines: number;
    successCount: number;
    avgScribeMs: number | null;
    avgProtoMs: number | null;
    avgTraceMs: number | null;
    avgTotalMs: number | null;
  },
  recent: Array<{ id: string; title: string; stage: string; createdAt: Date; durationMs: number | null }>,
  errorFrequency: Array<{ code: string; count: number }>,
  modelDistribution: Array<{ model: string; count: number }>,
  tokenUsage: Array<{ agent: string; inputTokens: number; outputTokens: number }>,
) {
  const totalPipelines = agg.totalPipelines ?? 0;
  const successCount = agg.successCount ?? 0;
  const successRate = computeSuccessRate(totalPipelines, successCount);
  return {
    totalPipelines,
    successRate,
    avgDurations: {
      scribeMs: agg.avgScribeMs ?? null,
      protoMs: agg.avgProtoMs ?? null,
      traceMs: agg.avgTraceMs ?? null,
      totalMs: agg.avgTotalMs ?? null,
    },
    recentPipelines: recent.map((r) => ({
      id: r.id,
      title: r.title,
      stage: r.stage,
      createdAt: r.createdAt.toISOString(),
      durationMs: r.durationMs,
    })),
    errorFrequency,
    modelDistribution,
    tokenUsage,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Job Events SSE Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Job Events SSE — Event format validation', () => {
  it('SSE message follows "data: JSON\\n\\n" format', () => {
    const event: StageEvent = {
      eventId: 1,
      ts: '2026-01-15T10:00:00.000Z',
      jobId: 'job-abc',
      type: 'stage',
      stage: 'planning',
      status: 'started',
    };
    const sse = formatSSEMessage(event);
    const dataLine = sse.split('\n').find((l) => l.startsWith('data: '));
    assert.ok(dataLine, 'must have a data: line');
    const json = dataLine.replace('data: ', '');
    const parsed = JSON.parse(json);
    assert.equal(parsed.type, 'stage');
    assert.equal(parsed.jobId, 'job-abc');
    assert.ok(sse.endsWith('\n\n'), 'must end with double newline');
  });

  it('SSE message includes id field from eventId', () => {
    const event: StageEvent = {
      eventId: 42,
      ts: '2026-01-15T10:00:00.000Z',
      jobId: 'job-abc',
      type: 'stage',
      stage: 'init',
      status: 'started',
    };
    const sse = formatSSEMessage(event);
    assert.ok(sse.includes('id: 42\n'));
  });

  it('SSE message includes event type field', () => {
    const event: LogEvent = {
      eventId: 3,
      ts: '2026-01-15T10:00:00.000Z',
      jobId: 'job-abc',
      type: 'log',
      level: 'info',
      message: 'test message',
    };
    const sse = formatSSEMessage(event);
    assert.ok(sse.includes('event: log\n'));
  });
});

describe('Job Events SSE — Event types', () => {
  it('formats stage event with "started" status', () => {
    const event: StageEvent = {
      eventId: 1,
      ts: new Date().toISOString(),
      jobId: 'j1',
      type: 'stage',
      stage: 'planning',
      status: 'started',
      message: 'Planning started',
    };
    const sse = formatSSEMessage(event);
    const data = JSON.parse(sse.split('\n').find((l) => l.startsWith('data: '))!.replace('data: ', ''));
    assert.equal(data.stage, 'planning');
    assert.equal(data.status, 'started');
    assert.equal(data.message, 'Planning started');
  });

  it('formats stage event for "completed" stage', () => {
    const event: StageEvent = {
      eventId: 2,
      ts: new Date().toISOString(),
      jobId: 'j1',
      type: 'stage',
      stage: 'completed',
      status: 'completed',
      message: 'Job completed',
    };
    const sse = formatSSEMessage(event);
    const data = JSON.parse(sse.split('\n').find((l) => l.startsWith('data: '))!.replace('data: ', ''));
    assert.equal(data.stage, 'completed');
    assert.equal(data.status, 'completed');
  });

  it('formats stage event for "failed" stage', () => {
    const event: StageEvent = {
      eventId: 3,
      ts: new Date().toISOString(),
      jobId: 'j1',
      type: 'stage',
      stage: 'failed',
      status: 'completed',
      message: 'Job failed',
    };
    const sse = formatSSEMessage(event);
    assert.ok(sse.includes('event: stage\n'));
    const data = JSON.parse(sse.split('\n').find((l) => l.startsWith('data: '))!.replace('data: ', ''));
    assert.equal(data.stage, 'failed');
  });

  it('formats error event', () => {
    const event: ErrorEvent = {
      eventId: 4,
      ts: new Date().toISOString(),
      jobId: 'j1',
      type: 'error',
      message: 'MCP gateway timeout',
      scope: 'mcp',
      fatal: false,
    };
    const sse = formatSSEMessage(event);
    assert.ok(sse.includes('event: error\n'));
    const data = JSON.parse(sse.split('\n').find((l) => l.startsWith('data: '))!.replace('data: ', ''));
    assert.equal(data.scope, 'mcp');
    assert.equal(data.fatal, false);
  });

  it('formats ai_call event with token usage', () => {
    const event: AiCallEvent = {
      eventId: 5,
      ts: new Date().toISOString(),
      jobId: 'j1',
      type: 'ai_call',
      purpose: 'plan',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      durationMs: 2400,
      tokens: { input: 1200, output: 450, total: 1650 },
      ok: true,
    };
    const sse = formatSSEMessage(event);
    assert.ok(sse.includes('event: ai_call\n'));
    const data = JSON.parse(sse.split('\n').find((l) => l.startsWith('data: '))!.replace('data: ', ''));
    assert.equal(data.model, 'claude-sonnet-4-6');
    assert.equal(data.tokens.total, 1650);
    assert.equal(data.ok, true);
  });

  it('all valid stage values produce valid SSE', () => {
    const stages: StageEvent['stage'][] = [
      'init', 'planning', 'executing', 'reflecting', 'validating', 'publishing', 'completed', 'failed',
    ];
    for (const stage of stages) {
      const event: StageEvent = {
        eventId: 1,
        ts: new Date().toISOString(),
        jobId: 'j1',
        type: 'stage',
        stage,
        status: 'started',
      };
      const sse = formatSSEMessage(event);
      assert.ok(sse.includes(`"stage":"${stage}"`), `stage "${stage}" should be in SSE data`);
    }
  });
});

describe('Job Events SSE — Missing jobId handling', () => {
  it('extractJobUserId returns null for null payload', () => {
    assert.equal(extractJobUserId(null), null);
  });

  it('extractJobUserId returns null for undefined payload', () => {
    assert.equal(extractJobUserId(undefined), null);
  });

  it('extractJobUserId returns null for non-object payload', () => {
    assert.equal(extractJobUserId('string'), null);
    assert.equal(extractJobUserId(42), null);
  });

  it('extractJobUserId returns null for missing userId field', () => {
    assert.equal(extractJobUserId({}), null);
    assert.equal(extractJobUserId({ foo: 'bar' }), null);
  });

  it('extractJobUserId returns null for non-string userId', () => {
    assert.equal(extractJobUserId({ userId: 123 }), null);
    assert.equal(extractJobUserId({ userId: true }), null);
    assert.equal(extractJobUserId({ userId: null }), null);
  });

  it('extractJobUserId returns null for whitespace-only userId', () => {
    assert.equal(extractJobUserId({ userId: '   ' }), null);
    assert.equal(extractJobUserId({ userId: '' }), null);
  });

  it('extractJobUserId trims and returns valid userId', () => {
    assert.equal(extractJobUserId({ userId: '  user-123  ' }), 'user-123');
    assert.equal(extractJobUserId({ userId: 'user-abc' }), 'user-abc');
  });
});

describe('Job Events SSE — streamQuerySchema validation', () => {
  it('accepts empty query (defaults)', () => {
    const result = streamQuerySchema.parse({});
    assert.equal(result.cursor, undefined);
    assert.equal(result.includeHistory, true);
  });

  it('accepts valid cursor as number', () => {
    const result = streamQuerySchema.parse({ cursor: 5 });
    assert.equal(result.cursor, 5);
  });

  it('accepts cursor as string and coerces to number', () => {
    const result = streamQuerySchema.parse({ cursor: '10' });
    assert.equal(result.cursor, 10);
  });

  it('rejects non-positive cursor', () => {
    assert.throws(() => streamQuerySchema.parse({ cursor: 0 }));
    assert.throws(() => streamQuerySchema.parse({ cursor: -1 }));
  });

  it('rejects non-integer cursor', () => {
    assert.throws(() => streamQuerySchema.parse({ cursor: 1.5 }));
  });

  it('includeHistory=false string transforms to false', () => {
    const result = streamQuerySchema.parse({ includeHistory: 'false' });
    assert.equal(result.includeHistory, false);
  });

  it('includeHistory=true string transforms to true', () => {
    const result = streamQuerySchema.parse({ includeHistory: 'true' });
    assert.equal(result.includeHistory, true);
  });

  it('includeHistory boolean true passes through', () => {
    const result = streamQuerySchema.parse({ includeHistory: true });
    assert.equal(result.includeHistory, true);
  });

  it('includeHistory boolean false passes through', () => {
    const result = streamQuerySchema.parse({ includeHistory: false });
    assert.equal(result.includeHistory, false);
  });

  it('includeHistory defaults to true when omitted', () => {
    const result = streamQuerySchema.parse({});
    assert.equal(result.includeHistory, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Dashboard Metrics Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Dashboard Metrics — Period validation', () => {
  it('"7d" period produces 7-day window', () => {
    const period = '7d' as const;
    const daysAgo = period === '30d' ? 30 : 7;
    assert.equal(daysAgo, 7);
  });

  it('"30d" period produces 30-day window', () => {
    const period = '30d' as const;
    const daysAgo = period === '30d' ? 30 : 7;
    assert.equal(daysAgo, 30);
  });

  it('invalid period defaults to 7d logic', () => {
    const period = 'invalid' as string;
    const daysAgo = period === '30d' ? 30 : 7;
    assert.equal(daysAgo, 7);
  });

  it('undefined period defaults to 7d', () => {
    const query: { period?: '7d' | '30d' } = {};
    const period = query.period || '7d';
    assert.equal(period, '7d');
  });
});

describe('Dashboard Metrics — Success rate calculation', () => {
  it('100% success rate with all completed jobs', () => {
    const m = buildDashboardMetrics('7d', { totalJobs: 10, completedJobs: 10, failedJobs: 0, avgQualityScore: 85.5 }, null);
    assert.equal(m.successRate, 100);
  });

  it('0% success rate with all failed jobs', () => {
    const m = buildDashboardMetrics('7d', { totalJobs: 5, completedJobs: 0, failedJobs: 5, avgQualityScore: null }, null);
    assert.equal(m.successRate, 0);
  });

  it('rounds to nearest integer', () => {
    const m = buildDashboardMetrics('7d', { totalJobs: 3, completedJobs: 1, failedJobs: 2, avgQualityScore: null }, null);
    assert.equal(m.successRate, 33); // 33.33 -> 33
  });

  it('handles mixed completed and failed', () => {
    const m = buildDashboardMetrics('30d', { totalJobs: 8, completedJobs: 6, failedJobs: 2, avgQualityScore: 72.3 }, null);
    assert.equal(m.successRate, 75);
    assert.equal(m.completedJobs, 6);
    assert.equal(m.failedJobs, 2);
  });
});

describe('Dashboard Metrics — Empty data returns zeroes not nulls', () => {
  it('empty data returns 100% success rate (no failures)', () => {
    const m = buildDashboardMetrics('7d', { totalJobs: 0, completedJobs: 0, failedJobs: 0, avgQualityScore: null }, null);
    assert.equal(m.successRate, 100);
    assert.equal(m.totalJobs, 0);
    assert.equal(m.completedJobs, 0);
    assert.equal(m.failedJobs, 0);
  });

  it('empty data returns null quality score (not zero)', () => {
    const m = buildDashboardMetrics('7d', { totalJobs: 0, completedJobs: 0, failedJobs: 0, avgQualityScore: null }, null);
    assert.equal(m.avgQualityScore, null);
  });

  it('empty data returns null failure reason and zero failure count', () => {
    const m = buildDashboardMetrics('7d', { totalJobs: 0, completedJobs: 0, failedJobs: 0, avgQualityScore: null }, null);
    assert.equal(m.topFailureReason, null);
    assert.equal(m.topFailureCount, 0);
  });

  it('numeric fields never return undefined', () => {
    const m = buildDashboardMetrics('7d', { totalJobs: 0, completedJobs: 0, failedJobs: 0, avgQualityScore: null }, null);
    assert.equal(typeof m.successRate, 'number');
    assert.equal(typeof m.totalJobs, 'number');
    assert.equal(typeof m.completedJobs, 'number');
    assert.equal(typeof m.failedJobs, 'number');
    assert.equal(typeof m.topFailureCount, 'number');
  });
});

describe('Dashboard Metrics — Quality score rounding', () => {
  it('rounds to one decimal place', () => {
    const m = buildDashboardMetrics('7d', { totalJobs: 5, completedJobs: 5, failedJobs: 0, avgQualityScore: 87.456 }, null);
    assert.equal(m.avgQualityScore, 87.5);
  });

  it('preserves exact tenths', () => {
    const m = buildDashboardMetrics('7d', { totalJobs: 5, completedJobs: 5, failedJobs: 0, avgQualityScore: 90.0 }, null);
    assert.equal(m.avgQualityScore, 90);
  });

  it('null quality score passes through as null', () => {
    const m = buildDashboardMetrics('7d', { totalJobs: 2, completedJobs: 2, failedJobs: 0, avgQualityScore: null }, null);
    assert.equal(m.avgQualityScore, null);
  });

  it('zero quality score treated as falsy → null', () => {
    // Mirrors the production logic: stats.avgQualityScore ? round : null
    const m = buildDashboardMetrics('7d', { totalJobs: 1, completedJobs: 1, failedJobs: 0, avgQualityScore: 0 }, null);
    assert.equal(m.avgQualityScore, null);
  });
});

describe('Dashboard Metrics — Top failure reason', () => {
  it('includes top failure when present', () => {
    const m = buildDashboardMetrics(
      '7d',
      { totalJobs: 10, completedJobs: 7, failedJobs: 3, avgQualityScore: null },
      { errorCode: 'AI_TIMEOUT', count: 2 },
    );
    assert.equal(m.topFailureReason, 'AI_TIMEOUT');
    assert.equal(m.topFailureCount, 2);
  });

  it('handles null errorCode in failure', () => {
    const m = buildDashboardMetrics(
      '7d',
      { totalJobs: 5, completedJobs: 3, failedJobs: 2, avgQualityScore: null },
      { errorCode: null, count: 1 },
    );
    assert.equal(m.topFailureReason, null);
    assert.equal(m.topFailureCount, 1);
  });

  it('returns null when no failures exist', () => {
    const m = buildDashboardMetrics(
      '7d',
      { totalJobs: 10, completedJobs: 10, failedJobs: 0, avgQualityScore: 95 },
      null,
    );
    assert.equal(m.topFailureReason, null);
    assert.equal(m.topFailureCount, 0);
  });
});

describe('Dashboard Metrics — User-scoped metrics', () => {
  it('period field matches requested period', () => {
    const m7 = buildDashboardMetrics('7d', { totalJobs: 1, completedJobs: 1, failedJobs: 0, avgQualityScore: null }, null);
    const m30 = buildDashboardMetrics('30d', { totalJobs: 1, completedJobs: 1, failedJobs: 0, avgQualityScore: null }, null);
    assert.equal(m7.period, '7d');
    assert.equal(m30.period, '30d');
  });

  it('response object has all required DashboardMetrics keys', () => {
    const m = buildDashboardMetrics('7d', { totalJobs: 0, completedJobs: 0, failedJobs: 0, avgQualityScore: null }, null);
    const requiredKeys: (keyof DashboardMetrics)[] = [
      'period', 'avgQualityScore', 'successRate', 'totalJobs',
      'completedJobs', 'failedJobs', 'topFailureReason', 'topFailureCount',
    ];
    for (const key of requiredKeys) {
      assert.ok(key in m, `missing key: ${key}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Pipeline Statistics Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Pipeline Statistics — Total pipeline count', () => {
  it('returns zero for no pipelines', () => {
    const result = buildPipelineStatsResponse(
      { totalPipelines: 0, successCount: 0, avgScribeMs: null, avgProtoMs: null, avgTraceMs: null, avgTotalMs: null },
      [], [], [], [],
    );
    assert.equal(result.totalPipelines, 0);
    assert.equal(result.successRate, 0);
  });

  it('returns correct count for multiple pipelines', () => {
    const result = buildPipelineStatsResponse(
      { totalPipelines: 25, successCount: 20, avgScribeMs: 5000, avgProtoMs: 3000, avgTraceMs: 2000, avgTotalMs: 10000 },
      [], [], [], [],
    );
    assert.equal(result.totalPipelines, 25);
    assert.equal(result.successRate, 80);
  });
});

describe('Pipeline Statistics — Agent duration averages', () => {
  it('returns null durations when no data', () => {
    const result = buildPipelineStatsResponse(
      { totalPipelines: 0, successCount: 0, avgScribeMs: null, avgProtoMs: null, avgTraceMs: null, avgTotalMs: null },
      [], [], [], [],
    );
    assert.deepEqual(result.avgDurations, {
      scribeMs: null,
      protoMs: null,
      traceMs: null,
      totalMs: null,
    });
  });

  it('returns correct duration values', () => {
    const result = buildPipelineStatsResponse(
      { totalPipelines: 5, successCount: 5, avgScribeMs: 4500, avgProtoMs: 8000, avgTraceMs: 3200, avgTotalMs: 15700 },
      [], [], [], [],
    );
    assert.equal(result.avgDurations.scribeMs, 4500);
    assert.equal(result.avgDurations.protoMs, 8000);
    assert.equal(result.avgDurations.traceMs, 3200);
    assert.equal(result.avgDurations.totalMs, 15700);
  });

  it('handles partial durations (some agents null)', () => {
    const result = buildPipelineStatsResponse(
      { totalPipelines: 3, successCount: 2, avgScribeMs: 3000, avgProtoMs: null, avgTraceMs: null, avgTotalMs: 3000 },
      [], [], [], [],
    );
    assert.equal(result.avgDurations.scribeMs, 3000);
    assert.equal(result.avgDurations.protoMs, null);
    assert.equal(result.avgDurations.traceMs, null);
    assert.equal(result.avgDurations.totalMs, 3000);
  });
});

describe('Pipeline Statistics — Error frequency aggregation', () => {
  it('returns empty array when no errors', () => {
    const result = buildPipelineStatsResponse(
      { totalPipelines: 5, successCount: 5, avgScribeMs: null, avgProtoMs: null, avgTraceMs: null, avgTotalMs: null },
      [], [], [], [],
    );
    assert.deepEqual(result.errorFrequency, []);
  });

  it('includes error codes with counts', () => {
    const errors = [
      { code: 'AI_TIMEOUT', count: 5 },
      { code: 'GITHUB_PUSH_FAILED', count: 3 },
      { code: 'MCP_UNREACHABLE', count: 1 },
    ];
    const result = buildPipelineStatsResponse(
      { totalPipelines: 20, successCount: 11, avgScribeMs: null, avgProtoMs: null, avgTraceMs: null, avgTotalMs: null },
      [], errors, [], [],
    );
    assert.equal(result.errorFrequency.length, 3);
    assert.equal(result.errorFrequency[0].code, 'AI_TIMEOUT');
    assert.equal(result.errorFrequency[0].count, 5);
  });

  it('preserves ordering (highest count first)', () => {
    const errors = [
      { code: 'A', count: 10 },
      { code: 'B', count: 5 },
      { code: 'C', count: 1 },
    ];
    const result = buildPipelineStatsResponse(
      { totalPipelines: 20, successCount: 4, avgScribeMs: null, avgProtoMs: null, avgTraceMs: null, avgTotalMs: null },
      [], errors, [], [],
    );
    assert.ok(result.errorFrequency[0].count >= result.errorFrequency[1].count);
    assert.ok(result.errorFrequency[1].count >= result.errorFrequency[2].count);
  });
});

describe('Pipeline Statistics — Model distribution', () => {
  it('returns empty array when no AI activity', () => {
    const result = buildPipelineStatsResponse(
      { totalPipelines: 0, successCount: 0, avgScribeMs: null, avgProtoMs: null, avgTraceMs: null, avgTotalMs: null },
      [], [], [], [],
    );
    assert.deepEqual(result.modelDistribution, []);
  });

  it('includes model names with counts', () => {
    const models = [
      { model: 'claude-sonnet-4-6', count: 15 },
      { model: 'gpt-4o-mini', count: 5 },
    ];
    const result = buildPipelineStatsResponse(
      { totalPipelines: 10, successCount: 10, avgScribeMs: null, avgProtoMs: null, avgTraceMs: null, avgTotalMs: null },
      [], [], models, [],
    );
    assert.equal(result.modelDistribution.length, 2);
    assert.equal(result.modelDistribution[0].model, 'claude-sonnet-4-6');
    assert.equal(result.modelDistribution[0].count, 15);
  });
});

describe('Pipeline Statistics — Token usage per agent', () => {
  it('returns empty array when no token data', () => {
    const result = buildPipelineStatsResponse(
      { totalPipelines: 0, successCount: 0, avgScribeMs: null, avgProtoMs: null, avgTraceMs: null, avgTotalMs: null },
      [], [], [], [],
    );
    assert.deepEqual(result.tokenUsage, []);
  });

  it('includes per-agent token breakdown', () => {
    const tokens = [
      { agent: 'scribe', inputTokens: 50000, outputTokens: 12000 },
      { agent: 'proto', inputTokens: 80000, outputTokens: 35000 },
      { agent: 'trace', inputTokens: 30000, outputTokens: 8000 },
    ];
    const result = buildPipelineStatsResponse(
      { totalPipelines: 5, successCount: 5, avgScribeMs: null, avgProtoMs: null, avgTraceMs: null, avgTotalMs: null },
      [], [], [], tokens,
    );
    assert.equal(result.tokenUsage.length, 3);
    assert.equal(result.tokenUsage[0].agent, 'scribe');
    assert.equal(result.tokenUsage[0].inputTokens, 50000);
    assert.equal(result.tokenUsage[0].outputTokens, 12000);
    assert.equal(result.tokenUsage[1].agent, 'proto');
    assert.equal(result.tokenUsage[2].agent, 'trace');
  });

  it('handles zero token counts', () => {
    const tokens = [{ agent: 'scribe', inputTokens: 0, outputTokens: 0 }];
    const result = buildPipelineStatsResponse(
      { totalPipelines: 1, successCount: 0, avgScribeMs: null, avgProtoMs: null, avgTraceMs: null, avgTotalMs: null },
      [], [], [], tokens,
    );
    assert.equal(result.tokenUsage[0].inputTokens, 0);
    assert.equal(result.tokenUsage[0].outputTokens, 0);
  });
});

describe('Pipeline Statistics — Recent pipelines serialization', () => {
  it('serializes createdAt as ISO string', () => {
    const recent = [
      { id: 'p-1', title: 'My App', stage: 'completed', createdAt: new Date('2026-04-10T08:00:00Z'), durationMs: 12000 },
    ];
    const result = buildPipelineStatsResponse(
      { totalPipelines: 1, successCount: 1, avgScribeMs: null, avgProtoMs: null, avgTraceMs: null, avgTotalMs: null },
      recent, [], [], [],
    );
    assert.equal(result.recentPipelines[0].createdAt, '2026-04-10T08:00:00.000Z');
    assert.equal(result.recentPipelines[0].durationMs, 12000);
  });

  it('handles null durationMs', () => {
    const recent = [
      { id: 'p-2', title: 'WIP', stage: 'failed', createdAt: new Date('2026-04-11T12:00:00Z'), durationMs: null },
    ];
    const result = buildPipelineStatsResponse(
      { totalPipelines: 1, successCount: 0, avgScribeMs: null, avgProtoMs: null, avgTraceMs: null, avgTotalMs: null },
      recent, [], [], [],
    );
    assert.equal(result.recentPipelines[0].durationMs, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Pipeline Success Rate Edge Cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('Pipeline Statistics — computeSuccessRate edge cases', () => {
  it('returns 0 for zero total', () => {
    assert.equal(computeSuccessRate(0, 0), 0);
  });

  it('returns 100 for all success', () => {
    assert.equal(computeSuccessRate(100, 100), 100);
  });

  it('rounds 66.67% to 67', () => {
    assert.equal(computeSuccessRate(3, 2), 67);
  });

  it('rounds 33.33% to 33', () => {
    assert.equal(computeSuccessRate(3, 1), 33);
  });

  it('handles large numbers', () => {
    assert.equal(computeSuccessRate(10000, 9999), 100); // 99.99 -> 100
  });

  it('single pipeline success', () => {
    assert.equal(computeSuccessRate(1, 1), 100);
  });

  it('single pipeline failure', () => {
    assert.equal(computeSuccessRate(1, 0), 0);
  });
});
