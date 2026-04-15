/**
 * SessionManager — Engineer Rental Mode session lifecycle tests.
 *
 * Uses node:test runner (project standard).
 * Run: node --test --import tsx src/pipeline/core/session/__tests__/SessionManager.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../SessionManager.js';
import type { SelectedTask } from '../SessionTypes.js';

// ─── Test Helpers ────────────────────────────────

function makeTask(overrides?: Partial<SelectedTask>): SelectedTask {
  return {
    taskId: `task-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Implement login page',
    category: 'frontend',
    estimatedMinutes: 30,
    status: 'queued',
    ...overrides,
  };
}

function makeTasks(count: number): SelectedTask[] {
  return Array.from({ length: count }, (_, i) =>
    makeTask({ taskId: `task-${i + 1}`, title: `Task ${i + 1}` }),
  );
}

// ─── Tests ───────────────────────────────────────

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  // 1. creates session with valid params
  it('creates session with valid params', () => {
    const tasks = makeTasks(3);
    const session = manager.createSession({
      userId: 'user-1',
      owner: 'test-org',
      repo: 'test-repo',
      tasks,
      timeBudgetMinutes: 60,
    });

    assert.ok(session.id, 'session has an id');
    assert.equal(session.userId, 'user-1');
    assert.equal(session.owner, 'test-org');
    assert.equal(session.repo, 'test-repo');
    assert.equal(session.selectedTasks.length, 3);
    assert.equal(session.status, 'created');
    assert.equal(session.timeBudgetMinutes, 60);
    assert.equal(session.currentTaskIndex, 0);
    assert.equal(session.elapsedMinutes, 0);
    assert.equal(session.totalPausedMinutes, 0);
    // All tasks should be queued
    for (const t of session.selectedTasks) {
      assert.equal(t.status, 'queued');
    }
  });

  // 2. rejects session with >5 tasks
  it('rejects session with more than 5 tasks', () => {
    assert.throws(
      () =>
        manager.createSession({
          userId: 'user-1',
          owner: 'org',
          repo: 'repo',
          tasks: makeTasks(6),
          timeBudgetMinutes: 60,
        }),
      (err: Error) => {
        assert.match(err.message, /Maximum 5 tasks allowed/);
        return true;
      },
    );
  });

  // 3. rejects time budget outside min/max range
  it('rejects time budget below minimum', () => {
    assert.throws(
      () =>
        manager.createSession({
          userId: 'user-1',
          owner: 'org',
          repo: 'repo',
          tasks: makeTasks(1),
          timeBudgetMinutes: 10, // below 30 min default
        }),
      (err: Error) => {
        assert.match(err.message, /at least 30 minutes/);
        return true;
      },
    );
  });

  it('rejects time budget above maximum', () => {
    assert.throws(
      () =>
        manager.createSession({
          userId: 'user-1',
          owner: 'org',
          repo: 'repo',
          tasks: makeTasks(1),
          timeBudgetMinutes: 200, // above 180 min default
        }),
      (err: Error) => {
        assert.match(err.message, /at most 180 minutes/);
        return true;
      },
    );
  });

  // 4. starts session and sets timer
  it('starts session and sets timer fields', () => {
    const session = manager.createSession({
      userId: 'user-1',
      owner: 'org',
      repo: 'repo',
      tasks: makeTasks(2),
      timeBudgetMinutes: 60,
    });

    const started = manager.startSession(session.id);

    assert.equal(started.status, 'running');
    assert.ok(started.startedAt instanceof Date, 'startedAt is a Date');
    assert.ok(started.expiresAt instanceof Date, 'expiresAt is a Date');
    assert.equal(started.selectedTasks[0].status, 'running');
    assert.equal(started.selectedTasks[1].status, 'queued');

    // expiresAt should be ~60 min from startedAt
    const diffMs = started.expiresAt!.getTime() - started.startedAt!.getTime();
    assert.equal(diffMs, 60 * 60_000);
  });

  // 5. completes task and advances to next
  it('completes task and advances to next', () => {
    const session = manager.createSession({
      userId: 'user-1',
      owner: 'org',
      repo: 'repo',
      tasks: makeTasks(3),
      timeBudgetMinutes: 120,
    });
    manager.startSession(session.id);

    const updated = manager.completeTask(session.id, { criticScore: 85 });

    assert.equal(updated.selectedTasks[0].status, 'completed');
    assert.equal(updated.selectedTasks[1].status, 'running');
    assert.equal(updated.currentTaskIndex, 1);
    assert.equal(updated.completedTasks.length, 1);
    assert.equal(updated.completedTasks[0].criticScore, 85);
    assert.equal(updated.status, 'running');
  });

  // 6. completes all tasks and returns correct status
  it('completes all tasks and marks session completed', () => {
    const session = manager.createSession({
      userId: 'user-1',
      owner: 'org',
      repo: 'repo',
      tasks: makeTasks(2),
      timeBudgetMinutes: 120,
    });
    manager.startSession(session.id);

    manager.completeTask(session.id, { criticScore: 90 });
    const final = manager.completeTask(session.id, { criticScore: 95 });

    assert.equal(final.status, 'completed');
    assert.equal(final.completedTasks.length, 2);
    assert.equal(final.currentTaskIndex, 2);
  });

  // 7. calculates time remaining correctly
  it('calculates time remaining correctly', () => {
    const session = manager.createSession({
      userId: 'user-1',
      owner: 'org',
      repo: 'repo',
      tasks: makeTasks(1),
      timeBudgetMinutes: 60,
    });

    // Before start, full budget remains
    const beforeStart = manager.getTimeRemaining(session.id);
    assert.equal(beforeStart.minutes, 60);
    assert.equal(beforeStart.isWarning, false);
    assert.equal(beforeStart.isExpired, false);

    manager.startSession(session.id);

    // Just started, should have ~60 minutes (within a small tolerance)
    const afterStart = manager.getTimeRemaining(session.id);
    assert.ok(afterStart.minutes > 59, 'should have nearly 60 minutes remaining');
    assert.equal(afterStart.isWarning, false);
    assert.equal(afterStart.isExpired, false);
  });

  // 8. pauses and resumes session
  it('pauses and resumes session correctly', () => {
    const session = manager.createSession({
      userId: 'user-1',
      owner: 'org',
      repo: 'repo',
      tasks: makeTasks(1),
      timeBudgetMinutes: 60,
    });
    manager.startSession(session.id);

    const paused = manager.pauseSession(session.id);
    assert.equal(paused.status, 'paused');
    assert.ok(paused.pausedAt instanceof Date, 'pausedAt is set');

    const resumed = manager.resumeSession(session.id);
    assert.equal(resumed.status, 'running');
    assert.equal(resumed.pausedAt, undefined, 'pausedAt cleared after resume');
    // totalPausedMinutes should be >= 0
    assert.ok(resumed.totalPausedMinutes >= 0);
  });

  // 9. handles session expiry (skip remaining tasks)
  it('handles session expiry by skipping remaining tasks', () => {
    // Use a custom config with very short time to simulate expiry
    const shortManager = new SessionManager({ minTimeMinutes: 0, maxTimeMinutes: 1 });
    const session = shortManager.createSession({
      userId: 'user-1',
      owner: 'org',
      repo: 'repo',
      tasks: makeTasks(3),
      timeBudgetMinutes: 0, // expires immediately
    });

    // Manually set startedAt to the past to simulate expiry
    const s = shortManager.getSession(session.id)!;
    s.startedAt = new Date(Date.now() - 10 * 60_000); // 10 min ago
    s.expiresAt = new Date(Date.now() - 5 * 60_000);  // expired 5 min ago
    s.status = 'running';
    s.selectedTasks[0].status = 'running';

    // Complete current task — remaining should be skipped due to expiry
    const updated = shortManager.completeTask(session.id);

    assert.equal(updated.status, 'expired');
    assert.equal(updated.selectedTasks[1].status, 'skipped');
    assert.equal(updated.selectedTasks[2].status, 'skipped');
    assert.equal(updated.completedTasks.length, 1);
  });

  // 10. calculates costs correctly
  it('calculates costs correctly', () => {
    const session = manager.createSession({
      userId: 'user-1',
      owner: 'org',
      repo: 'repo',
      tasks: makeTasks(1),
      timeBudgetMinutes: 60,
    });

    // Estimated cost = 60 * 0.0167 = ~1.002
    assert.ok(
      Math.abs(session.costs.estimated - 60 * 0.0167) < 0.001,
      'estimated cost matches budget * rate',
    );
    assert.equal(session.costs.actual, 0, 'actual cost starts at 0');

    manager.startSession(session.id);

    const budget = manager.checkBudget(session.id);
    assert.ok(budget.estimatedCost > 0);
    assert.ok(budget.actualCost >= 0);
    assert.equal(budget.withinBudget, true);
  });

  // 11. throws on invalid session ID
  it('throws on invalid session ID', () => {
    assert.throws(
      () => manager.startSession('non-existent-id'),
      (err: Error) => {
        assert.match(err.message, /Session not found/);
        return true;
      },
    );

    assert.throws(
      () => manager.getTimeRemaining('non-existent-id'),
      (err: Error) => {
        assert.match(err.message, /Session not found/);
        return true;
      },
    );
  });

  // 12. getSession returns null for unknown ID
  it('getSession returns null for unknown ID', () => {
    const result = manager.getSession('unknown-id');
    assert.equal(result, null);
  });

  // 13. endSession marks remaining tasks as skipped and returns summary
  it('endSession skips remaining tasks and returns summary', () => {
    const session = manager.createSession({
      userId: 'user-1',
      owner: 'org',
      repo: 'repo',
      tasks: makeTasks(3),
      timeBudgetMinutes: 60,
    });
    manager.startSession(session.id);
    manager.completeTask(session.id, { criticScore: 80 });

    const summary = manager.endSession(session.id);

    assert.equal(summary.sessionId, session.id);
    assert.equal(summary.status, 'cancelled');
    assert.equal(summary.totalTasks, 3);
    assert.equal(summary.completedTasks, 1);
    assert.equal(summary.skippedTasks, 2);
    assert.ok(summary.totalCost >= 0);
    assert.equal(summary.taskResults.length, 1);
  });

  // 14. cannot start a session that is already running
  it('cannot start a session that is already running', () => {
    const session = manager.createSession({
      userId: 'user-1',
      owner: 'org',
      repo: 'repo',
      tasks: makeTasks(1),
      timeBudgetMinutes: 60,
    });
    manager.startSession(session.id);

    assert.throws(
      () => manager.startSession(session.id),
      (err: Error) => {
        assert.match(err.message, /Cannot start session/);
        return true;
      },
    );
  });

  // 15. rejects creating session with zero tasks
  it('rejects creating session with zero tasks', () => {
    assert.throws(
      () =>
        manager.createSession({
          userId: 'user-1',
          owner: 'org',
          repo: 'repo',
          tasks: [],
          timeBudgetMinutes: 60,
        }),
      (err: Error) => {
        assert.match(err.message, /At least one task is required/);
        return true;
      },
    );
  });

  // 16. getCurrentTask returns null when session not running
  it('getCurrentTask returns null for non-running session', () => {
    const session = manager.createSession({
      userId: 'user-1',
      owner: 'org',
      repo: 'repo',
      tasks: makeTasks(1),
      timeBudgetMinutes: 60,
    });

    // Not started yet
    const task = manager.getCurrentTask(session.id);
    assert.equal(task, null);
  });
});
