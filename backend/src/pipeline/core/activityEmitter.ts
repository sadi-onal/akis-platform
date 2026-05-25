// PDP-2 Wave 2 (F-03 + F-11 / NFR-1): activity events are now persisted to
// `pipeline_activities`. The in-memory ring buffer + EventEmitter remain in
// place so the live SSE replay path stays sub-ms; the DB insert runs
// asynchronously alongside.

import { EventEmitter } from 'events';

import { and, desc, eq } from 'drizzle-orm';

import { db as defaultDb } from '../../db/client.js';
import { pipelineActivities } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';

// Pipeline-level in-memory event bus for real-time activity tracking
export const pipelineBus = new EventEmitter();
// Each concurrent SSE connection adds a listener; 200 handles ~100 concurrent users
pipelineBus.setMaxListeners(200);

export interface PipelineActivity {
  pipelineId: string;
  /**
   * Originating stage. `critic` and `fix-loop` were added when the pipeline
   * grew explicit adversarial review and self-repair phases — older clients
   * that only know `scribe|proto|trace` should treat unknown values as
   * pass-through cosmetic events rather than crashing.
   */
  stage: 'scribe' | 'proto' | 'trace' | 'critic' | 'fix-loop';
  step: string;
  message: string;
  detail?: string;
  progress?: number; // 0-100
  /**
   * PR-V5: explicit lifecycle signal for a stage. When set to `'completed'`
   * (with progress 100), it marks the stage as fully done so the frontend
   * does NOT have to infer completion from "this stage is no longer the
   * latest activity" — a heuristic that caused premature checkmarks at
   * Scribe→Proto / Proto→Trace transitions. `undefined` for older or
   * intermediate events; new code emits exactly one `'completed'` per
   * stage success (before the stage transition is recorded).
   */
  status?: 'completed';
  retryCount?: number; // >0 when agent is retrying a transient failure
  /**
   * Stable i18n key for the activity message (e.g. `pipeline.activity.proto.writing_files`).
   * Frontend prefers this over `message` when present so the same backend event
   * renders in the user's chosen locale. `message` stays as the Turkish fallback.
   */
  activityKey?: string;
  /**
   * PR-A Fix 4: distinguishes Critic spec review from Critic code review on
   * the SSE bus. The stage stays `'critic'` (single agent) but the cinema
   * view needs two columns — one before Proto, one after — so the frontend
   * can route the event to the correct column. `undefined` for non-critic
   * stages.
   */
  criticPhase?: 'spec' | 'code';
  /**
   * Optional reasoning snippet attached for "cinema" / explainability
   * surfaces. Compact subset of AgentReasoning so the SSE payload stays
   * small; the full reasoning record is still queryable via
   * GET /pipelines/:id/explanation.
   */
  reasoning?: {
    decision: string;
    snippet?: string;
    confidence?: number; // 0-100
  };
  timestamp: string;
}

// Ring buffer of recent activities per pipeline — used by the replay endpoint
// so a client reconnecting mid-pipeline can reconstruct progress state without
// waiting for the next live emit.
const ACTIVITY_BUFFER_LIMIT = 50;
/** DB read fan-out limit when the cache is cold. Bigger than the ring buffer
 * so a "fresh page reload" can show more than the last 50 events. */
const DB_RECENT_LIMIT = 100;
const activityBuffers = new Map<string, PipelineActivity[]>();

// ── Persistence wiring ────────────────────────────────────────────────────
//
// Default uses the global Drizzle client in normal operation, BUT defaults to
// `null` under test environments. Without this guard, `emitActivity` callers
// in unit tests fire fire-and-forget DB writes against the real default
// client, which either fails noisy (FK violation when the pipeline row
// doesn't exist) or piles connection attempts into the pg pool when
// DATABASE_URL is unreachable. Integration tests opt back in by calling
// `resetActivityDb()` (or by setActivityDb(realDb)).
type ActivityDb = Pick<typeof defaultDb, 'insert' | 'select'>;
const IS_TEST_ENV = process.env.NODE_ENV === 'test' || process.env.SKIP_DB_TESTS === 'true';
let _db: ActivityDb | null = IS_TEST_ENV ? null : defaultDb;

/** Override the DB used for activity persistence. `null` = cache-only (tests). */
export function setActivityDb(db: ActivityDb | null): void {
  _db = db;
}

/**
 * Reset to the global default Drizzle client. Integration tests that DO want
 * to exercise the persistence path call this in `before(...)` to opt back in
 * after the test-env auto-null default. Production code never needs this.
 */
export function resetActivityDb(): void {
  _db = defaultDb;
}

export function emitActivity(activity: PipelineActivity): void {
  // 1) Update in-memory cache + push to live SSE listeners synchronously.
  const buf = activityBuffers.get(activity.pipelineId) ?? [];
  buf.push(activity);
  if (buf.length > ACTIVITY_BUFFER_LIMIT) buf.shift();
  activityBuffers.set(activity.pipelineId, buf);
  pipelineBus.emit(`pipeline:${activity.pipelineId}`, activity);

  // 2) Persist to pipeline_activities. Fire-and-forget — keeping emit() sync
  //    avoids forcing every orchestrator/agent callsite to become async.
  if (!_db) return;
  _db
    .insert(pipelineActivities)
    .values({
      pipelineId: activity.pipelineId,
      stage: activity.stage,
      step: activity.step,
      message: activity.message ?? null,
      progress: activity.progress ?? null,
      retryCount: activity.retryCount ?? 0,
      reasoningSnippet: activity.reasoning ?? null,
      criticPhase: activity.criticPhase ?? null,
      emittedAt: new Date(activity.timestamp),
    })
    .catch((err) => {
      logger.warn(
        { err, pipelineId: activity.pipelineId, step: activity.step },
        '[ActivityEmitter] Failed to persist activity (cache still hot)'
      );
    });
}

/** Synchronous accessor — returns whatever is currently in the cache. */
export function getActivities(pipelineId: string): PipelineActivity[] {
  return activityBuffers.get(pipelineId) ?? [];
}

/**
 * Cache-aware activity replay (NFR-1). Returns the live ring buffer when warm
 * (no extra latency for active pipelines) and falls back to the DB for cold
 * pipelines — i.e. ones whose buffer has been evicted or that completed
 * before this backend process started.
 *
 * Callers SHOULD await this when a "fresh load" is needed (page reload after
 * backend restart, page reload long after pipeline finished). For SSE replay
 * during an active stream the sync `getActivities` is enough.
 */
export async function getRecentActivities(
  pipelineId: string,
  limit = DB_RECENT_LIMIT
): Promise<PipelineActivity[]> {
  const cached = activityBuffers.get(pipelineId);
  // Short-circuit on cache only when the cache can actually satisfy the
  // requested limit. The ring buffer is hard-capped at ACTIVITY_BUFFER_LIMIT
  // (50) — for callers asking for more (e.g. fresh page reload wanting up to
  // 100), the cache is necessarily incomplete on a long-running pipeline, so
  // we must fall through to the DB read.
  if (cached !== undefined && cached.length > 0 && cached.length >= limit) {
    return cached.slice(-limit);
  }
  if (!_db) {
    // No persistence configured — best-effort: return whatever cache holds.
    return cached ? cached.slice(-limit) : [];
  }
  const rows = await _db
    .select({
      pipelineId: pipelineActivities.pipelineId,
      stage: pipelineActivities.stage,
      step: pipelineActivities.step,
      message: pipelineActivities.message,
      progress: pipelineActivities.progress,
      retryCount: pipelineActivities.retryCount,
      reasoningSnippet: pipelineActivities.reasoningSnippet,
      criticPhase: pipelineActivities.criticPhase,
      emittedAt: pipelineActivities.emittedAt,
    })
    .from(pipelineActivities)
    .where(and(eq(pipelineActivities.pipelineId, pipelineId)))
    .orderBy(desc(pipelineActivities.emittedAt))
    .limit(limit);

  // Rows came back newest-first — reverse so the caller sees chronological order.
  const ordered = [...rows].reverse();
  const reconstructed = ordered.map((r) => rowToActivity(r));

  // Warm the cache for subsequent calls within this process.
  activityBuffers.set(pipelineId, reconstructed.slice(-ACTIVITY_BUFFER_LIMIT));
  return reconstructed;
}

interface ActivityRow {
  pipelineId: string;
  stage: string;
  step: string;
  message: string | null;
  progress: number | null;
  retryCount: number | null;
  reasoningSnippet: PipelineActivity['reasoning'] | null;
  criticPhase: string | null;
  emittedAt: Date;
}

function rowToActivity(r: ActivityRow): PipelineActivity {
  const stage = r.stage as PipelineActivity['stage'];
  const activity: PipelineActivity = {
    pipelineId: r.pipelineId,
    stage,
    step: r.step,
    message: r.message ?? '',
    timestamp: r.emittedAt.toISOString(),
  };
  if (r.progress !== null) activity.progress = r.progress;
  if (r.retryCount !== null && r.retryCount > 0) activity.retryCount = r.retryCount;
  if (r.reasoningSnippet) activity.reasoning = r.reasoningSnippet;
  if (r.criticPhase === 'spec' || r.criticPhase === 'code') activity.criticPhase = r.criticPhase;
  // PR-V5: rehydrate the explicit stage-completed lifecycle signal on
  // replay. We piggyback on `step === 'stage_completed'` because the DB
  // schema has no dedicated status column — keeping the contract
  // backwards-compatible and migration-free.
  if (r.step === 'stage_completed') activity.status = 'completed';
  return activity;
}

/** Remove all listeners and drop buffered activities for a terminal pipeline. */
export function cleanupPipelineListeners(pipelineId: string): void {
  pipelineBus.removeAllListeners(`pipeline:${pipelineId}`);
  // Defer buffer cleanup so a client returning right after completion can
  // still fetch the final state; 5 min is enough to cover typical reloads.
  // NOTE: cache eviction is intentional — the data is safe in pipeline_activities.
  setTimeout(() => activityBuffers.delete(pipelineId), 5 * 60 * 1000).unref();
}

export function createActivityEmitter(
  pipelineId: string,
  stage: PipelineActivity['stage'],
  options: { criticPhase?: 'spec' | 'code' } = {}
) {
  return (
    step: string,
    message: string,
    progress?: number,
    detail?: string,
    retryCount?: number,
    activityKey?: string,
    reasoning?: PipelineActivity['reasoning']
  ) => {
    emitActivity({
      pipelineId,
      stage,
      step,
      message,
      progress,
      detail,
      retryCount,
      ...(activityKey ? { activityKey } : {}),
      ...(options.criticPhase ? { criticPhase: options.criticPhase } : {}),
      ...(reasoning ? { reasoning } : {}),
      timestamp: new Date().toISOString(),
    });
  };
}

// ── Test-only helpers ─────────────────────────────────────────────────────
// Expose buffer reset so unit tests don't bleed state across cases without
// having to expose the buffer Map directly.
export function __resetActivityBufferForTests(pipelineId?: string): void {
  if (pipelineId) {
    activityBuffers.delete(pipelineId);
    return;
  }
  activityBuffers.clear();
}

export const __ACTIVITY_BUFFER_LIMIT = ACTIVITY_BUFFER_LIMIT;
