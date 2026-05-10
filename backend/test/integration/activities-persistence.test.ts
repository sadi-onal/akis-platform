/**
 * Activity persistence integration test (PDP-2 Wave 2 / NFR-1).
 *
 * Acceptance: emitted activities survive a "backend restart" (cache eviction)
 * — getRecentActivities falls back to pipeline_activities and returns the
 * full tail of events. Covers F-03 (state lost on restart) and F-11
 * (persistence layer didn't exist).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { db } from '../../src/db/client.js';
import { pipelines, users } from '../../src/db/schema.js';
import {
  emitActivity,
  getRecentActivities,
  getActivities,
  resetActivityDb,
  setActivityDb,
  __resetActivityBufferForTests,
  type PipelineActivity,
} from '../../src/pipeline/core/activityEmitter.js';

const SKIP = process.env.SKIP_DB_TESTS === 'true' || !process.env.DATABASE_URL;

function activityFor(pipelineId: string, i: number): PipelineActivity {
  return {
    pipelineId,
    stage: 'scribe',
    step: `step-${i}`,
    message: `mesaj-${i}`,
    progress: i,
    timestamp: new Date(Date.UTC(2026, 4, 9, 10, 0, i)).toISOString(),
  };
}

describe('Activity persistence (F-03 + F-11 / NFR-1)', () => {
  let userId: string;
  let pipelineId: string;

  before(async () => {
    if (SKIP) return;
    // Integration tests opt back into the real Drizzle client. The module
    // defaults to `_db = null` under NODE_ENV=test (review-fix #4) so unit
    // tests don't accidentally hit Postgres.
    resetActivityDb();
    userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      name: 'activity-test',
      email: `activity-test-${userId}@example.com`,
      passwordHash: 'x',
    });
    pipelineId = randomUUID();
    await db.insert(pipelines).values({
      id: pipelineId,
      userId,
      stage: 'completed',
      title: 'activity test',
    });
  });

  after(async () => {
    if (SKIP) return;
    // Cascade from pipelines covers pipeline_activities rows.
    await db.delete(pipelines).where(eq(pipelines.id, pipelineId));
    await db.delete(users).where(eq(users.id, userId));
    // Restore test-default to keep unit tests run after this isolated.
    setActivityDb(null);
  });

  it('emit 10 activities → cache evicted → DB recovers all 10 in order', async (t) => {
    if (SKIP) {
      t.skip('SKIP_DB_TESTS or DATABASE_URL not set');
      return;
    }

    for (let i = 0; i < 10; i++) {
      emitActivity(activityFor(pipelineId, i));
    }

    // Wait for fire-and-forget DB writes to settle. The inserts are
    // independent so we yield the event loop a few times.
    await new Promise((r) => setTimeout(r, 200));

    // Simulate a backend restart: drop the in-memory ring buffer entirely.
    __resetActivityBufferForTests(pipelineId);
    assert.equal(getActivities(pipelineId).length, 0);

    const recovered = await getRecentActivities(pipelineId);
    assert.equal(recovered.length, 10, 'all 10 activities must be recovered from DB');
    // Returned in chronological order.
    const steps = recovered.map((a) => a.step);
    assert.deepEqual(steps, [
      'step-0', 'step-1', 'step-2', 'step-3', 'step-4',
      'step-5', 'step-6', 'step-7', 'step-8', 'step-9',
    ]);
    // Persistence preserves payload fields beyond just the step name.
    assert.equal(recovered[0]!.message, 'mesaj-0');
    assert.equal(recovered[9]!.progress, 9);
  });

  it('emit 200 → only the 100 newest are returned (DB LIMIT)', async (t) => {
    if (SKIP) {
      t.skip('SKIP_DB_TESTS or DATABASE_URL not set');
      return;
    }
    const localUserId = randomUUID();
    const localPipelineId = randomUUID();
    await db.insert(users).values({
      id: localUserId,
      name: 'overflow-test',
      email: `overflow-test-${localUserId}@example.com`,
      passwordHash: 'x',
    });
    await db.insert(pipelines).values({
      id: localPipelineId,
      userId: localUserId,
      stage: 'completed',
      title: 'overflow test',
    });

    try {
      for (let i = 0; i < 200; i++) {
        emitActivity(activityFor(localPipelineId, i));
      }
      await new Promise((r) => setTimeout(r, 400));

      __resetActivityBufferForTests(localPipelineId);

      const recovered = await getRecentActivities(localPipelineId);
      assert.equal(recovered.length, 100, 'DB read should be capped at 100 newest');
      // Newest-first → reversed → returned chronologically; oldest is step-100,
      // newest is step-199.
      assert.equal(recovered[0]!.step, 'step-100');
      assert.equal(recovered[recovered.length - 1]!.step, 'step-199');
    } finally {
      await db.delete(pipelines).where(eq(pipelines.id, localPipelineId));
      await db.delete(users).where(eq(users.id, localUserId));
    }
  });

  it('warm cache short-circuits the DB read when cache satisfies the limit', async (t) => {
    if (SKIP) {
      t.skip('SKIP_DB_TESTS or DATABASE_URL not set');
      return;
    }
    const localUserId = randomUUID();
    const localPipelineId = randomUUID();
    await db.insert(users).values({
      id: localUserId,
      name: 'cache-test',
      email: `cache-test-${localUserId}@example.com`,
      passwordHash: 'x',
    });
    await db.insert(pipelines).values({
      id: localPipelineId,
      userId: localUserId,
      stage: 'completed',
      title: 'cache hot test',
    });

    try {
      emitActivity(activityFor(localPipelineId, 0));
      emitActivity(activityFor(localPipelineId, 1));

      // Limit = 2 ⇒ cache has enough → short-circuit returns immediately.
      const recovered = await getRecentActivities(localPipelineId, 2);
      assert.equal(recovered.length, 2);
      assert.deepEqual(
        recovered.map((a) => a.step),
        ['step-0', 'step-1'],
      );
    } finally {
      await new Promise((r) => setTimeout(r, 100)); // let DB writes settle before delete
      await db.delete(pipelines).where(eq(pipelines.id, localPipelineId));
      await db.delete(users).where(eq(users.id, localUserId));
    }
  });

  // Review-fix #2: cache-cap boundary — caller asks for more rows than the
  // ring buffer can hold, so the cache MUST fall through to the DB.
  it('falls through to DB when limit exceeds cache size (review #2)', async (t) => {
    if (SKIP) {
      t.skip('SKIP_DB_TESTS or DATABASE_URL not set');
      return;
    }
    const localUserId = randomUUID();
    const localPipelineId = randomUUID();
    await db.insert(users).values({
      id: localUserId,
      name: 'fallthrough-test',
      email: `fallthrough-test-${localUserId}@example.com`,
      passwordHash: 'x',
    });
    await db.insert(pipelines).values({
      id: localPipelineId,
      userId: localUserId,
      stage: 'completed',
      title: 'cache fallthrough test',
    });

    try {
      // Emit 200 activities → ring buffer caps at 50, DB persists all 200.
      for (let i = 0; i < 200; i++) {
        emitActivity(activityFor(localPipelineId, i));
      }
      await new Promise((r) => setTimeout(r, 400));

      // Caller asks for 100. Cache only holds the most recent 50. Without
      // the fallthrough fix the function would return cached.slice(-100) =
      // the 50 cached items. With the fix it must hit the DB and return 100.
      const recovered = await getRecentActivities(localPipelineId, 100);
      assert.equal(
        recovered.length,
        100,
        'caller asking for 100 must get 100 from DB even when cache is hot but smaller',
      );
      // Spot-check chronological order.
      assert.equal(recovered[0]!.step, 'step-100');
      assert.equal(recovered[recovered.length - 1]!.step, 'step-199');
    } finally {
      await db.delete(pipelines).where(eq(pipelines.id, localPipelineId));
      await db.delete(users).where(eq(users.id, localUserId));
    }
  });
});
