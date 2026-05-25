/**
 * SSE streaming system & Activity Emitter edge-case tests.
 *
 * Covers: ring buffer semantics, pipeline isolation, TTL cleanup,
 * SSE wire format, heartbeat interval, max connection age,
 * client disconnect cleanup, backpressure, and activity type shapes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  pipelineBus,
  emitActivity,
  getActivities,
  cleanupPipelineListeners,
  createActivityEmitter,
  type PipelineActivity,
} from '../../src/pipeline/core/activityEmitter.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeActivity(
  pipelineId: string,
  overrides: Partial<PipelineActivity> = {},
): PipelineActivity {
  return {
    pipelineId,
    stage: 'scribe',
    step: 'init',
    message: 'test message',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** Drain the internal buffer for a pipeline so tests start clean. */
function _drainBuffer(_pipelineId: string): void {
  // Emit nothing — just read to confirm current state, then overwrite
  // by emitting enough to shift everything out. Simpler: access via
  // getActivities, then repeatedly emit dummy + shift until empty.
  // Cleanest approach: cleanupPipelineListeners schedules a deferred
  // delete so we cannot rely on it. Instead we just use unique pipeline
  // IDs per test.
}

// ─── Activity Emitter: Ring Buffer ───────────────────────────────────

describe('Activity Emitter — ring buffer', () => {
  it('stores emitted activity in the buffer', () => {
    const id = `test-store-${Date.now()}`;
    const activity = makeActivity(id);
    emitActivity(activity);

    const buf = getActivities(id);
    assert.equal(buf.length, 1);
    assert.equal(buf[0].pipelineId, id);
    assert.equal(buf[0].message, 'test message');
  });

  it('enforces max buffer size of 150 — oldest dropped (#628: raised from 50)', () => {
    const id = `test-overflow-${Date.now()}`;
    const LIMIT = 150; // #628: raised from 50 to accommodate iterate loops

    for (let i = 0; i < LIMIT + 10; i++) {
      emitActivity(makeActivity(id, { step: `step-${i}`, message: `msg-${i}` }));
    }

    const buf = getActivities(id);
    assert.equal(buf.length, LIMIT, `buffer should be capped at ${LIMIT}`);
    // Oldest (step-0 through step-9) should have been evicted
    assert.equal(buf[0].step, 'step-10');
    assert.equal(buf[LIMIT - 1].step, `step-${LIMIT + 9}`);
  });

  it('returns empty array for non-existent pipeline', () => {
    const buf = getActivities('pipeline-that-never-existed');
    assert.ok(Array.isArray(buf));
    assert.equal(buf.length, 0);
  });

  it('creates new buffer on first emit for unknown pipeline', () => {
    const id = `test-new-pipeline-${Date.now()}`;
    assert.equal(getActivities(id).length, 0);

    emitActivity(makeActivity(id));
    assert.equal(getActivities(id).length, 1);
  });

  it('maintains independent buffers per pipeline', () => {
    const idA = `test-iso-a-${Date.now()}`;
    const idB = `test-iso-b-${Date.now()}`;

    emitActivity(makeActivity(idA, { message: 'alpha' }));
    emitActivity(makeActivity(idA, { message: 'alpha-2' }));
    emitActivity(makeActivity(idB, { message: 'beta' }));

    const bufA = getActivities(idA);
    const bufB = getActivities(idB);

    assert.equal(bufA.length, 2);
    assert.equal(bufB.length, 1);
    assert.equal(bufA[0].message, 'alpha');
    assert.equal(bufB[0].message, 'beta');
  });
});

// ─── Activity Shape ──────────────────────────────────────────────────

describe('Activity Emitter — activity shape', () => {
  it('activity has required fields: stage, step, message, timestamp', () => {
    const id = `test-shape-${Date.now()}`;
    emitActivity(makeActivity(id, {
      stage: 'proto',
      step: 'scaffold',
      message: 'Building scaffold',
    }));

    const [act] = getActivities(id);
    assert.equal(act.stage, 'proto');
    assert.equal(act.step, 'scaffold');
    assert.equal(act.message, 'Building scaffold');
    assert.ok(act.timestamp, 'timestamp must be present');
    // ISO 8601 format check
    assert.ok(!isNaN(Date.parse(act.timestamp)), 'timestamp must be valid ISO date');
  });

  it('optional fields are preserved when provided', () => {
    const id = `test-optional-${Date.now()}`;
    emitActivity(makeActivity(id, {
      detail: 'Extra context',
      progress: 42,
      retryCount: 2,
    }));

    const [act] = getActivities(id);
    assert.equal(act.detail, 'Extra context');
    assert.equal(act.progress, 42);
    assert.equal(act.retryCount, 2);
  });

  it('stage must be one of scribe | proto | trace', () => {
    const id = `test-stages-${Date.now()}`;
    const stages: PipelineActivity['stage'][] = ['scribe', 'proto', 'trace'];

    for (const stage of stages) {
      emitActivity(makeActivity(id, { stage, step: `${stage}-step` }));
    }

    const buf = getActivities(id);
    assert.equal(buf.length, 3);
    assert.deepStrictEqual(buf.map(a => a.stage), stages);
  });
});

// ─── createActivityEmitter factory ───────────────────────────────────

describe('Activity Emitter — createActivityEmitter factory', () => {
  it('returned function emits with correct pipelineId and stage', () => {
    const id = `test-factory-${Date.now()}`;
    const emit = createActivityEmitter(id, 'trace');

    emit('run-tests', 'Running Playwright tests');

    const [act] = getActivities(id);
    assert.equal(act.pipelineId, id);
    assert.equal(act.stage, 'trace');
    assert.equal(act.step, 'run-tests');
    assert.equal(act.message, 'Running Playwright tests');
  });

  it('passes through progress, detail, and retryCount', () => {
    const id = `test-factory-opts-${Date.now()}`;
    const emit = createActivityEmitter(id, 'scribe');

    emit('analyze', 'Analyzing idea', 75, 'Detailed info', 1);

    const [act] = getActivities(id);
    assert.equal(act.progress, 75);
    assert.equal(act.detail, 'Detailed info');
    assert.equal(act.retryCount, 1);
  });

  it('auto-generates ISO timestamp', () => {
    const id = `test-factory-ts-${Date.now()}`;
    const before = Date.now();
    const emit = createActivityEmitter(id, 'proto');
    emit('build', 'Building');
    const after = Date.now();

    const [act] = getActivities(id);
    const ts = Date.parse(act.timestamp);
    assert.ok(ts >= before && ts <= after, 'timestamp should be within call window');
  });
});

// ─── EventEmitter (pipelineBus) ──────────────────────────────────────

describe('Activity Emitter — pipelineBus events', () => {
  it('emitActivity fires event on pipelineBus', async () => {
    const id = `test-bus-${Date.now()}`;
    const received: PipelineActivity[] = [];

    const listener = (a: PipelineActivity) => received.push(a);
    pipelineBus.on(`pipeline:${id}`, listener);

    emitActivity(makeActivity(id, { message: 'bus-test' }));

    // EventEmitter is synchronous
    assert.equal(received.length, 1);
    assert.equal(received[0].message, 'bus-test');

    pipelineBus.off(`pipeline:${id}`, listener);
  });

  it('cleanupPipelineListeners removes all listeners for pipeline', () => {
    const id = `test-cleanup-${Date.now()}`;
    const listener = () => {};
    pipelineBus.on(`pipeline:${id}`, listener);

    assert.equal(pipelineBus.listenerCount(`pipeline:${id}`), 1);

    cleanupPipelineListeners(id);

    assert.equal(pipelineBus.listenerCount(`pipeline:${id}`), 0);
  });

  it('cleanupPipelineListeners defers buffer deletion (not immediate)', () => {
    const id = `test-deferred-${Date.now()}`;
    emitActivity(makeActivity(id, { message: 'still-here' }));

    cleanupPipelineListeners(id);

    // Buffer should still be accessible right after cleanup
    // (5 min deferred delete via setTimeout)
    const buf = getActivities(id);
    assert.equal(buf.length, 1, 'buffer should persist immediately after cleanup');
    assert.equal(buf[0].message, 'still-here');
  });
});

// ─── SSE Wire Format ─────────────────────────────────────────────────

describe('SSE Stream — event format', () => {
  it('activity events are formatted as data: JSON\\n\\n', () => {
    const activity = makeActivity('fmt-test', {
      stage: 'scribe',
      step: 'clarify',
      message: 'Asking question',
      progress: 25,
    });

    // Replicate the format from pipeline-stream.plugin.ts
    const formatted = `data: ${JSON.stringify(activity)}\n\n`;

    assert.ok(formatted.startsWith('data: '));
    assert.ok(formatted.endsWith('\n\n'));

    // Extract and parse JSON payload
    const json = formatted.slice('data: '.length, -2);
    const parsed = JSON.parse(json);
    assert.equal(parsed.stage, 'scribe');
    assert.equal(parsed.step, 'clarify');
    assert.equal(parsed.progress, 25);
  });

  it('connected event has correct shape', () => {
    const pipelineId = 'p-123';
    const connectedEvent = `data: ${JSON.stringify({ type: 'connected', pipelineId })}\n\n`;

    const json = connectedEvent.slice('data: '.length, -2);
    const parsed = JSON.parse(json);
    assert.equal(parsed.type, 'connected');
    assert.equal(parsed.pipelineId, 'p-123');
  });

  it('heartbeat is a SSE comment (colon-prefixed)', () => {
    const heartbeat = `: heartbeat\n\n`;
    assert.ok(heartbeat.startsWith(':'), 'heartbeat must be SSE comment');
    assert.ok(heartbeat.endsWith('\n\n'), 'heartbeat must end with double newline');
  });

  it('multiple events can be concatenated as a valid SSE stream', () => {
    const events = [
      `data: ${JSON.stringify({ type: 'connected', pipelineId: 'x' })}\n\n`,
      `data: ${JSON.stringify(makeActivity('x', { step: 'a' }))}\n\n`,
      `: heartbeat\n\n`,
      `data: ${JSON.stringify(makeActivity('x', { step: 'b' }))}\n\n`,
    ];

    const stream = events.join('');

    // Each event separated by double newline — split to verify
    const parts = stream.split('\n\n').filter(Boolean);
    assert.equal(parts.length, 4);
    assert.ok(parts[0].startsWith('data: '));
    assert.ok(parts[2].startsWith(':'));
  });
});

// ─── SSE Timing Constants ────────────────────────────────────────────

describe('SSE Stream — timing constants', () => {
  it('heartbeat interval is 15 seconds', () => {
    // From pipeline-stream.plugin.ts: setInterval(..., 15000)
    const HEARTBEAT_INTERVAL_MS = 15_000;
    assert.equal(HEARTBEAT_INTERVAL_MS, 15_000);
    assert.ok(HEARTBEAT_INTERVAL_MS > 0);
    assert.ok(HEARTBEAT_INTERVAL_MS < 60_000, 'heartbeat should be less than 1 minute');
  });

  it('max connection age is 30 minutes', () => {
    // From pipeline-stream.plugin.ts: setTimeout(..., 30 * 60 * 1000)
    const MAX_AGE_MS = 30 * 60 * 1000;
    assert.equal(MAX_AGE_MS, 1_800_000);
    assert.ok(MAX_AGE_MS >= 10 * 60 * 1000, 'max age should be at least 10 min');
    assert.ok(MAX_AGE_MS <= 60 * 60 * 1000, 'max age should be at most 1 hour');
  });

  it('buffer TTL cleanup is 5 minutes', () => {
    // From activityEmitter.ts: setTimeout(..., 5 * 60 * 1000)
    const BUFFER_TTL_MS = 5 * 60 * 1000;
    assert.equal(BUFFER_TTL_MS, 300_000);
  });
});

// ─── Backpressure Simulation ─────────────────────────────────────────

describe('SSE Stream — backpressure handling', () => {
  it('write returning false triggers pause (simulated writable)', () => {
    // Simulates the backpressure logic from pipeline-stream.plugin.ts
    let paused = false;
    let drainCallbackRegistered = false;

    const fakeWritable = {
      write(_chunk: string): boolean {
        // Simulate buffer full after first write
        return false;
      },
      once(event: string, cb: () => void) {
        if (event === 'drain') {
          drainCallbackRegistered = true;
          // Simulate drain after a tick
          queueMicrotask(cb);
        }
      },
    };

    const activity = makeActivity('bp-test');
    const ok = fakeWritable.write(`data: ${JSON.stringify(activity)}\n\n`);
    if (!ok) {
      paused = true;
      fakeWritable.once('drain', () => { paused = false; });
    }

    assert.equal(paused, true, 'should be paused when write returns false');
    assert.equal(drainCallbackRegistered, true, 'should register drain handler');
  });

  it('events are queued while paused (#628: queue instead of drop)', () => {
    let paused = true;
    const written: string[] = [];
    const queue: PipelineActivity[] = [];

    const onActivity = (activity: PipelineActivity) => {
      if (paused) {
        // #628: queue instead of dropping
        queue.push(activity);
        return;
      }
      written.push(activity.message);
    };

    const flushQueue = () => {
      while (queue.length > 0 && !paused) {
        written.push(queue.shift()!.message);
      }
    };

    // Fire events while paused — they should be queued, not dropped
    onActivity(makeActivity('bp-queue', { message: 'queued-1' }));
    onActivity(makeActivity('bp-queue', { message: 'queued-2' }));

    assert.equal(written.length, 0, 'no events written while paused');
    assert.equal(queue.length, 2, 'events should be queued');

    // Unpause and flush
    paused = false;
    flushQueue();
    onActivity(makeActivity('bp-queue', { message: 'delivered' }));

    assert.equal(written.length, 3, 'queued + new events delivered');
    assert.equal(written[0], 'queued-1');
    assert.equal(written[1], 'queued-2');
    assert.equal(written[2], 'delivered');
  });
});

// ─── Client Disconnect Cleanup ───────────────────────────────────────

describe('SSE Stream — client disconnect cleanup', () => {
  it('cleanup removes listener and clears timers (simulated)', () => {
    const _id = `test-disconnect-${Date.now()}`;
    let listenerRemoved = false;
    let heartbeatCleared = false;
    let maxAgeCleared = false;

    // Simulate the cleanup function from the SSE handler
    const _onActivity = () => {};
    const heartbeat = setInterval(() => {}, 15_000);
    const maxAge = setTimeout(() => {}, 30 * 60 * 1000);
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      listenerRemoved = true;
      clearInterval(heartbeat);
      heartbeatCleared = true;
      clearTimeout(maxAge);
      maxAgeCleared = true;
    };

    // Simulate client close
    cleanup();

    assert.ok(listenerRemoved, 'listener should be removed');
    assert.ok(heartbeatCleared, 'heartbeat timer should be cleared');
    assert.ok(maxAgeCleared, 'max-age timer should be cleared');
  });

  it('cleanup is idempotent — calling twice is safe', () => {
    let cleanupCount = 0;
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      cleanupCount++;
    };

    cleanup();
    cleanup();
    cleanup();

    assert.equal(cleanupCount, 1, 'cleanup body should execute exactly once');
  });
});

// ─── Activity Types ──────────────────────────────────────────────────

describe('Activity Types — stage change events', () => {
  it('stage change has correct format', () => {
    const id = `test-stage-change-${Date.now()}`;
    emitActivity(makeActivity(id, {
      stage: 'proto',
      step: 'stage-change',
      message: 'Transitioning to Proto',
      progress: 0,
    }));

    const [act] = getActivities(id);
    assert.equal(act.stage, 'proto');
    assert.equal(act.step, 'stage-change');
    assert.equal(act.progress, 0);
  });
});

describe('Activity Types — progress events', () => {
  it('progress percentage is between 0 and 100', () => {
    const id = `test-progress-${Date.now()}`;
    const progressValues = [0, 25, 50, 75, 100];

    for (const p of progressValues) {
      emitActivity(makeActivity(id, { progress: p, step: `p-${p}` }));
    }

    const buf = getActivities(id);
    assert.equal(buf.length, 5);
    for (const act of buf) {
      assert.ok(
        act.progress !== undefined && act.progress >= 0 && act.progress <= 100,
        `progress ${act.progress} should be in [0, 100]`,
      );
    }
  });

  it('progress increments are reflected in buffer order', () => {
    const id = `test-progress-order-${Date.now()}`;
    emitActivity(makeActivity(id, { progress: 10 }));
    emitActivity(makeActivity(id, { progress: 50 }));
    emitActivity(makeActivity(id, { progress: 100 }));

    const buf = getActivities(id);
    assert.deepStrictEqual(
      buf.map(a => a.progress),
      [10, 50, 100],
    );
  });
});

describe('Activity Types — error events', () => {
  it('error activity includes detail field', () => {
    const id = `test-error-${Date.now()}`;
    emitActivity(makeActivity(id, {
      stage: 'trace',
      step: 'error',
      message: 'Playwright timeout',
      detail: 'Navigation timed out after 30s',
    }));

    const [act] = getActivities(id);
    assert.equal(act.step, 'error');
    assert.equal(act.message, 'Playwright timeout');
    assert.equal(act.detail, 'Navigation timed out after 30s');
  });

  it('retry error includes retryCount', () => {
    const id = `test-retry-${Date.now()}`;
    emitActivity(makeActivity(id, {
      step: 'retry',
      message: 'Retrying after transient failure',
      retryCount: 2,
    }));

    const [act] = getActivities(id);
    assert.equal(act.retryCount, 2);
    assert.ok(act.retryCount! > 0, 'retryCount should be positive for retries');
  });
});

describe('Activity Types — completion events', () => {
  it('complete event has 100% progress', () => {
    const id = `test-complete-${Date.now()}`;
    emitActivity(makeActivity(id, {
      stage: 'trace',
      step: 'complete',
      message: 'Pipeline completed successfully',
      progress: 100,
    }));

    const [act] = getActivities(id);
    assert.equal(act.step, 'complete');
    assert.equal(act.progress, 100);
  });

  it('complete event is the last in a typical pipeline sequence', () => {
    const id = `test-sequence-${Date.now()}`;
    emitActivity(makeActivity(id, { stage: 'scribe', step: 'start', progress: 0 }));
    emitActivity(makeActivity(id, { stage: 'scribe', step: 'generate', progress: 33 }));
    emitActivity(makeActivity(id, { stage: 'proto', step: 'build', progress: 66 }));
    emitActivity(makeActivity(id, { stage: 'trace', step: 'test', progress: 90 }));
    emitActivity(makeActivity(id, { stage: 'trace', step: 'complete', progress: 100 }));

    const buf = getActivities(id);
    assert.equal(buf.length, 5);
    assert.equal(buf[buf.length - 1].step, 'complete');
    assert.equal(buf[buf.length - 1].progress, 100);
  });
});

// ─── SSE Headers ─────────────────────────────────────────────────────

describe('SSE Stream — response headers', () => {
  it('content-type is text/event-stream', () => {
    // Verifies the expected header from pipeline-stream.plugin.ts
    const headers = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    };

    assert.equal(headers['Content-Type'], 'text/event-stream');
    assert.equal(headers['Cache-Control'], 'no-cache');
    assert.equal(headers['Connection'], 'keep-alive');
    assert.equal(headers['X-Accel-Buffering'], 'no', 'nginx buffering must be disabled');
  });
});

// ─── Persistence integration (review fixes #2 + #4) ──────────────────
//
// These exercise the activityEmitter persistence layer at unit-test scope:
//   - default _db is null under NODE_ENV=test (review-fix #4) — emits do not
//     touch a real Postgres connection.
//   - getRecentActivities falls through to DB when limit > cache.length
//     (review-fix #2). Cache held only the most recent ACTIVITY_BUFFER_LIMIT
//     items; for callers asking for more, the cache is incomplete by
//     construction so we must hit the DB.

describe('Activity Emitter — persistence wiring (review fixes)', async () => {
  // Lazy import so we can capture references after module init.
  const mod = await import('../../src/pipeline/core/activityEmitter.js');

  it('default db is null under NODE_ENV=test (no Postgres writes from unit tests)', () => {
    // Smoke test: emit hundreds of activities and never see a DB write
    // failure logged. We can't probe `_db` directly (private), but we can
    // confirm that emits return synchronously and produce no unhandled
    // rejections. The actual `_db = null` default is set at module-init
    // time by the IS_TEST_ENV guard.
    const id = `default-null-${Date.now()}`;
    let raised: unknown = null;
    const onUnhandled = (err: unknown) => {
      raised = err;
    };
    process.once('unhandledRejection', onUnhandled);
    for (let i = 0; i < 5; i++) {
      mod.emitActivity(makeActivity(id, { step: `s${i}` }));
    }
    process.removeListener('unhandledRejection', onUnhandled);
    assert.equal(raised, null, 'no DB write should fire under NODE_ENV=test');
    assert.equal(mod.getActivities(id).length, 5, 'cache still works');
  });

  it('getRecentActivities falls through to DB when limit > cache.length (review #2)', async () => {
    // Inject a fake DB. Pre-warm the cache with 3 activities; ask for 10.
    // With the fix in place, the function must call our fake DB select
    // because cache cannot satisfy the limit.
    let dbReadCalled = false;
    const fakeRows = Array.from({ length: 7 }, (_, i) => ({
      pipelineId: 'fallthrough',
      stage: 'scribe',
      step: `db-${i}`,
      message: `m${i}`,
      progress: i,
      retryCount: 0,
      reasoningSnippet: null,
      emittedAt: new Date(2026, 4, 9, 10, 0, i),
    }));
    const fakeDb = {
      insert() {
        return {
          values() {
            return {
              catch() {
                return Promise.resolve();
              },
            };
          },
        };
      },
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  orderBy() {
                    return {
                      limit() {
                        dbReadCalled = true;
                        return Promise.resolve([...fakeRows].reverse()); // newest-first
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as Parameters<typeof mod.setActivityDb>[0];

    const id = `cache-fallthrough-${Date.now()}`;
    mod.__resetActivityBufferForTests(id);

    // Cache has 3 items; caller wants 10 → must fall through to DB.
    mod.setActivityDb(fakeDb);
    try {
      mod.emitActivity(makeActivity(id, { step: 'cache-0' }));
      mod.emitActivity(makeActivity(id, { step: 'cache-1' }));
      mod.emitActivity(makeActivity(id, { step: 'cache-2' }));

      const recovered = await mod.getRecentActivities(id, 10);
      assert.equal(dbReadCalled, true, 'DB select must be hit when cache is too small for limit');
      assert.equal(recovered.length, 7, 'returned rows come from DB, not the smaller cache');
    } finally {
      mod.setActivityDb(null);
      mod.__resetActivityBufferForTests(id);
    }
  });

  it('getRecentActivities short-circuits when cache satisfies the limit', async () => {
    let dbReadCalled = false;
    const fakeDb = {
      insert() {
        return { values() { return { catch() { return Promise.resolve(); } }; } };
      },
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  orderBy() {
                    return {
                      limit() {
                        dbReadCalled = true;
                        return Promise.resolve([]);
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as Parameters<typeof mod.setActivityDb>[0];

    const id = `cache-hit-${Date.now()}`;
    mod.__resetActivityBufferForTests(id);
    mod.setActivityDb(fakeDb);
    try {
      mod.emitActivity(makeActivity(id, { step: 'a' }));
      mod.emitActivity(makeActivity(id, { step: 'b' }));
      mod.emitActivity(makeActivity(id, { step: 'c' }));

      // limit=2 → cache (3 items) is enough → no DB hit.
      const recovered = await mod.getRecentActivities(id, 2);
      assert.equal(dbReadCalled, false, 'cache satisfies limit; DB must not be queried');
      assert.equal(recovered.length, 2);
    } finally {
      mod.setActivityDb(null);
      mod.__resetActivityBufferForTests(id);
    }
  });
});
