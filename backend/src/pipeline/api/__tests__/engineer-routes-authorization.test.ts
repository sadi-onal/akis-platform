/**
 * Engineer routes — per-session authorization.
 *
 * Session-ID-bound endpoints must reject requests whose authenticated
 * user is not the session owner. Without that, any user who learns or
 * guesses a session id can pause, resume, cancel, or read another
 * user's engineer session.
 *
 * We test against createEngineerRoutes directly (no Fastify) — the
 * HTTP layer is just a thin wrapper and node:test runs fast.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineerRoutes } from '../engineer.routes.js';
import { SessionManager } from '../../core/session/index.js';
import type { DiscoveredTask } from '../../core/task-discovery/index.js';

// ─── Stubs ──────────────────────────────────────────

function makeGithubStub() {
  return {
    listFiles: async () => [],
    getFileContent: async () => '',
    createRepository: async () => ({ url: '' }),
    createBranch: async () => {},
    commitFile: async () => {},
    createPR: async () => ({ url: '' }),
  };
}

function makeTaskDiscoveryStub() {
  return {
    discoverTasks: async () => ({
      tasks: [] as DiscoveredTask[],
      repoHealth: {
        hasTests: false,
        hasCI: false,
        hasDocs: false,
        hasLinting: false,
        codeQualityScore: 0,
      },
      suggestedPlan: '',
      analysisTime: 0,
    }),
  };
}

function makeAliceSession(sessionManager: SessionManager) {
  const session = sessionManager.createSession({
    userId: 'alice',
    owner: 'acme',
    repo: 'webapp',
    tasks: [
      {
        taskId: 't1',
        title: 'Fix login',
        category: 'bug',
        estimatedMinutes: 30,
        status: 'queued',
      },
    ],
    timeBudgetMinutes: 60,
  });
  return session;
}

function makeRoutesAs(userId: string, sessionManager: SessionManager) {
  return createEngineerRoutes({
    getUserId: () => userId,
    taskDiscovery: makeTaskDiscoveryStub() as never,
    sessionManager,
    githubService: makeGithubStub() as never,
  });
}

async function expect404(op: () => Promise<unknown>, label: string) {
  await assert.rejects(
    op,
    (err: unknown) => {
      const e = err as { statusCode?: number; message?: string };
      assert.equal(e.statusCode, 404, `${label}: expected 404 (info-leak-safe)`);
      return true;
    },
    label,
  );
}

// ─── Tests ──────────────────────────────────────────

describe('engineer routes — session ownership enforcement', () => {
  it('rejects pauseSession from a non-owner with 404 and leaves state intact', async () => {
    const sessionManager = new SessionManager();
    const session = makeAliceSession(sessionManager);
    sessionManager.startSession(session.id);

    const bobRoutes = makeRoutesAs('bob', sessionManager);
    await expect404(
      () => bobRoutes.pauseSession({ params: { id: session.id } }),
      'bob pauses alice.session',
    );
    const unchanged = sessionManager.getSession(session.id);
    assert.equal(unchanged?.status, 'running', 'alice session still running');
  });

  it('rejects startSession / resumeSession / cancelSession from a non-owner', async () => {
    const sessionManager = new SessionManager();
    const session = makeAliceSession(sessionManager);

    const bobRoutes = makeRoutesAs('bob', sessionManager);
    await expect404(() => bobRoutes.startSession({ params: { id: session.id } }), 'start');
    await expect404(() => bobRoutes.resumeSession({ params: { id: session.id } }), 'resume');
    await expect404(() => bobRoutes.cancelSession({ params: { id: session.id } }), 'cancel');
  });

  it('rejects getSession / getProgress / getReport from a non-owner (no info leak)', async () => {
    const sessionManager = new SessionManager();
    const session = makeAliceSession(sessionManager);
    sessionManager.startSession(session.id);

    const bobRoutes = makeRoutesAs('bob', sessionManager);
    await expect404(() => bobRoutes.getSession({ params: { id: session.id } }), 'get');
    await expect404(() => bobRoutes.getProgress({ params: { id: session.id } }), 'progress');
    await expect404(() => bobRoutes.getReport({ params: { id: session.id } }), 'report');
  });

  it('allows the owner to access their own session', async () => {
    const sessionManager = new SessionManager();
    const session = makeAliceSession(sessionManager);

    const aliceRoutes = makeRoutesAs('alice', sessionManager);
    const started = await aliceRoutes.startSession({ params: { id: session.id } });
    assert.equal((started as { session: { status: string } }).session.status, 'running');
    const paused = await aliceRoutes.pauseSession({ params: { id: session.id } });
    assert.equal((paused as { session: { status: string } }).session.status, 'paused');
  });

  it('returns 404 for a fully unknown session id regardless of caller', async () => {
    const sessionManager = new SessionManager();
    const routes = makeRoutesAs('alice', sessionManager);
    await expect404(
      () => routes.getSession({ params: { id: 'nope-not-a-real-id' } }),
      'unknown id',
    );
  });
});
