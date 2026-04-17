/**
 * EngineerSessionRunner — bridges SessionManager task queue to PipelineOrchestrator.
 * Uses node:test runner (project standard).
 * Run: node --test --import tsx src/pipeline/core/session/__tests__/EngineerSessionRunner.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EngineerSessionRunner,
  type EngineerSessionOrchestrator,
} from '../EngineerSessionRunner.js';
import { SessionManager } from '../SessionManager.js';
import type { SelectedTask } from '../SessionTypes.js';
import type {
  PipelineStage,
  PipelineState,
  ScribeInput,
} from '../../contracts/PipelineTypes.js';

// ─── Helpers ────────────────────────────────────────

function makePipelineState(
  id: string,
  userId: string,
  stage: PipelineStage,
): PipelineState {
  return {
    id,
    userId,
    stage,
    scribeConversation: [],
    traceEnabled: true,
    metrics: {
      startedAt: new Date(),
      clarificationRounds: 0,
      retryCount: 0,
    },
  } as unknown as PipelineState;
}

function makeTask(id: string, title: string): SelectedTask {
  return {
    taskId: id,
    title,
    category: 'feature',
    estimatedMinutes: 15,
    status: 'queued',
  };
}

/**
 * Stub orchestrator with deterministic progression:
 *   startPipeline → awaiting_approval
 *   approveSpec   → completed (with a fake prUrl)
 *
 * Tracks every call so tests can assert the runner issued the expected
 * sequence of commands.
 */
class StubOrchestrator implements EngineerSessionOrchestrator {
  readonly startCalls: Array<{ userId: string; input: ScribeInput }> = [];
  readonly approveCalls: string[] = [];
  private readonly pipelines = new Map<string, PipelineState>();
  private seq = 0;

  async startPipeline(userId: string, input: ScribeInput): Promise<PipelineState> {
    this.startCalls.push({ userId, input });
    const id = `pipe-${++this.seq}`;
    const state = makePipelineState(id, userId, 'awaiting_approval');
    this.pipelines.set(id, state);
    return state;
  }

  async getStatus(pipelineId: string): Promise<PipelineState> {
    const state = this.pipelines.get(pipelineId);
    if (!state) throw new Error(`pipeline not found: ${pipelineId}`);
    return state;
  }

  async approveSpec(
    pipelineId: string,
    repoName: string,
    _visibility: 'public' | 'private',
  ): Promise<PipelineState> {
    this.approveCalls.push(pipelineId);
    const state = this.pipelines.get(pipelineId);
    if (!state) throw new Error(`pipeline not found: ${pipelineId}`);
    state.stage = 'completed';
    // Attach a minimal protoOutput so the runner can extract prUrl.
    (state as unknown as { protoOutput: { prUrl: string } }).protoOutput = {
      prUrl: `https://github.com/acme/${repoName}/pull/1`,
    };
    return state;
  }
}

/**
 * Orchestrator stub whose pipelines never advance past the initial stage.
 * Lets us verify the runner's timeout/abort semantics without waiting minutes.
 */
class StallingOrchestrator implements EngineerSessionOrchestrator {
  readonly startCalls: Array<{ userId: string; input: ScribeInput }> = [];
  readonly approveCalls: string[] = [];
  private readonly pipelines = new Map<string, PipelineState>();
  private seq = 0;
  constructor(private readonly stuckStage: PipelineStage = 'scribe_generating') {}

  async startPipeline(userId: string, input: ScribeInput): Promise<PipelineState> {
    this.startCalls.push({ userId, input });
    const id = `pipe-${++this.seq}`;
    const state = makePipelineState(id, userId, this.stuckStage);
    this.pipelines.set(id, state);
    return state;
  }

  async getStatus(pipelineId: string): Promise<PipelineState> {
    const state = this.pipelines.get(pipelineId);
    if (!state) throw new Error(`pipeline not found: ${pipelineId}`);
    return state;
  }

  async approveSpec(): Promise<PipelineState> {
    throw new Error('StallingOrchestrator does not reach awaiting_approval');
  }
}

/**
 * Orchestrator stub that jumps straight to a failure stage so the runner
 * records a failed task and moves on without leaving the session hung.
 */
class FailingOrchestrator implements EngineerSessionOrchestrator {
  readonly startCalls: Array<{ userId: string; input: ScribeInput }> = [];
  private readonly pipelines = new Map<string, PipelineState>();
  private seq = 0;

  async startPipeline(userId: string, input: ScribeInput): Promise<PipelineState> {
    this.startCalls.push({ userId, input });
    const id = `pipe-${++this.seq}`;
    const state = makePipelineState(id, userId, 'failed');
    this.pipelines.set(id, state);
    return state;
  }

  async getStatus(pipelineId: string): Promise<PipelineState> {
    const state = this.pipelines.get(pipelineId);
    if (!state) throw new Error(`pipeline not found: ${pipelineId}`);
    return state;
  }

  async approveSpec(): Promise<PipelineState> {
    throw new Error('FailingOrchestrator should never approve');
  }
}

// ─── Tests ──────────────────────────────────────────

describe('EngineerSessionRunner', () => {
  it('runs a pipeline for each task sequentially and completes the session', async () => {
    const sessionManager = new SessionManager();
    const session = sessionManager.createSession({
      userId: 'user-1',
      owner: 'acme',
      repo: 'webapp',
      tasks: [makeTask('t1', 'Fix login bug'), makeTask('t2', 'Add dark mode')],
      timeBudgetMinutes: 60,
    });

    const orchestrator = new StubOrchestrator();
    const runner = new EngineerSessionRunner({
      sessionManager,
      orchestrator,
      taskToScribeInput: (task) => ({
        idea: task.title,
        targetStack: 'typescript',
      }),
      pollIntervalMs: 1,
    });

    await runner.run(session.id, 'user-1');

    const final = sessionManager.getSession(session.id);
    assert.ok(final, 'session should still exist');
    assert.equal(final.status, 'completed', 'session marked completed');
    assert.equal(orchestrator.startCalls.length, 2, 'one pipeline per task');
    assert.equal(orchestrator.approveCalls.length, 2, 'each pipeline auto-approved');
    assert.equal(final.completedTasks.length, 2, 'both tasks recorded as completed');
    // Tasks should have captured the pipeline PR URL.
    assert.ok(
      final.completedTasks.every((t) => t.prUrl?.includes('/pull/1')),
      'each completed task records prUrl from orchestrator',
    );
  });

  it('records a task as completed-without-output when the pipeline times out', async () => {
    const sessionManager = new SessionManager();
    const session = sessionManager.createSession({
      userId: 'user-1',
      owner: 'acme',
      repo: 'webapp',
      tasks: [makeTask('t1', 'Refactor routing')],
      timeBudgetMinutes: 60,
    });

    const orchestrator = new StallingOrchestrator('scribe_generating');
    const runner = new EngineerSessionRunner({
      sessionManager,
      orchestrator,
      taskToScribeInput: (task) => ({ idea: task.title, targetStack: 'typescript' }),
      pollIntervalMs: 1,
      pipelineTimeoutMs: 25, // short enough for the test; long enough for one poll
    });

    await runner.run(session.id, 'user-1');

    const final = sessionManager.getSession(session.id);
    assert.ok(final, 'session still exists');
    assert.equal(final.status, 'completed', 'session queue drained even when pipeline timed out');
    assert.equal(final.completedTasks.length, 1);
    assert.equal(
      final.completedTasks[0].prUrl,
      undefined,
      'timed-out task has no PR URL recorded',
    );
    assert.equal(orchestrator.startCalls.length, 1);
  });

  it('moves on after a pipeline that terminates with stage=failed', async () => {
    const sessionManager = new SessionManager();
    const session = sessionManager.createSession({
      userId: 'user-1',
      owner: 'acme',
      repo: 'webapp',
      tasks: [
        makeTask('t1', 'Fix auth bug'),
        makeTask('t2', 'Refactor router'),
      ],
      timeBudgetMinutes: 60,
    });

    const orchestrator = new FailingOrchestrator();
    const runner = new EngineerSessionRunner({
      sessionManager,
      orchestrator,
      taskToScribeInput: (task) => ({ idea: task.title, targetStack: 'typescript' }),
      pollIntervalMs: 1,
    });

    await runner.run(session.id, 'user-1');

    const final = sessionManager.getSession(session.id);
    assert.ok(final, 'session still exists');
    assert.equal(
      orchestrator.startCalls.length,
      2,
      'runner attempted both tasks despite failures',
    );
    assert.equal(final.status, 'completed');
    assert.ok(
      final.completedTasks.every((t) => t.prUrl === undefined),
      'failed pipelines leave prUrl unset',
    );
  });

  it('is a no-op when the session was already cancelled before run()', async () => {
    const sessionManager = new SessionManager();
    const session = sessionManager.createSession({
      userId: 'user-1',
      owner: 'acme',
      repo: 'webapp',
      tasks: [makeTask('t1', 'A'), makeTask('t2', 'B')],
      timeBudgetMinutes: 60,
    });
    // Start then cancel externally before the runner gets to it.
    // (endSession only transitions running/paused → cancelled, so we start first.)
    sessionManager.startSession(session.id);
    sessionManager.endSession(session.id);

    const orchestrator = new StubOrchestrator();
    const runner = new EngineerSessionRunner({
      sessionManager,
      orchestrator,
      taskToScribeInput: (task) => ({ idea: task.title, targetStack: 'typescript' }),
      pollIntervalMs: 1,
    });

    await runner.run(session.id, 'user-1');

    assert.equal(orchestrator.startCalls.length, 0, 'runner must not start any pipeline for a cancelled session');
    const final = sessionManager.getSession(session.id);
    assert.equal(final?.status, 'cancelled');
    assert.ok(
      final?.selectedTasks.every((t) => t.status === 'skipped' || t.status === 'queued'),
      'no task should have been marked running or completed',
    );
  });

  it('waits while a session is paused, then drives it once it resumes', async () => {
    const sessionManager = new SessionManager();
    const session = sessionManager.createSession({
      userId: 'user-1',
      owner: 'acme',
      repo: 'webapp',
      tasks: [makeTask('t1', 'Wire paused-aware runner')],
      timeBudgetMinutes: 60,
    });
    // Start then pause before the runner gets to it.
    sessionManager.startSession(session.id);
    sessionManager.pauseSession(session.id);
    assert.equal(sessionManager.getSession(session.id)?.status, 'paused');

    const orchestrator = new StubOrchestrator();
    const runner = new EngineerSessionRunner({
      sessionManager,
      orchestrator,
      taskToScribeInput: (task) => ({ idea: task.title, targetStack: 'typescript' }),
      pollIntervalMs: 5,
    });

    const runPromise = runner.run(session.id, 'user-1');

    // Give the runner a tick or two to observe the paused state — it must
    // not start any pipeline while the session is paused.
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      orchestrator.startCalls.length,
      0,
      'runner must not start a pipeline while paused',
    );

    // Resume; the runner should pick up the queued task and drive it to completion.
    sessionManager.resumeSession(session.id);
    await runPromise;

    const final = sessionManager.getSession(session.id);
    assert.equal(final?.status, 'completed');
    assert.equal(orchestrator.startCalls.length, 1, 'exactly one pipeline after resume');
    assert.equal(final?.completedTasks.length, 1);
  });

  it('throws when asked to run an unknown session id', async () => {
    const sessionManager = new SessionManager();
    const orchestrator = new StubOrchestrator();
    const runner = new EngineerSessionRunner({
      sessionManager,
      orchestrator,
      taskToScribeInput: (task) => ({ idea: task.title, targetStack: 'typescript' }),
    });

    await assert.rejects(
      () => runner.run('non-existent-session', 'user-1'),
      /session not found/,
    );
  });
});
