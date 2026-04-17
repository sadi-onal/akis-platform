/**
 * Engineer routes — discovered-tasks cache lifecycle.
 *
 * discover() populates an in-memory Map keyed by `${userId}:${owner}/${repo}`
 * so that createSession() can look up metadata (title, category, estimate)
 * without hitting the LLM again. Once createSession has copied that data
 * into the session, the entry is no longer useful and must be dropped —
 * otherwise the Map accumulates for any user who discovers but never
 * creates a session.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEngineerRoutes } from '../engineer.routes.js';
import { SessionManager } from '../../core/session/index.js';
import type { DiscoveredTask } from '../../core/task-discovery/index.js';

// ─── Stubs ──────────────────────────────────────────

function makeDiscoveredTask(id: string): DiscoveredTask {
  return {
    id,
    title: `Task ${id}`,
    description: `Do ${id}`,
    category: 'feature',
    priority: 'medium',
    estimatedMinutes: 15,
    affectedFiles: [],
    complexity: 'simple',
    rationale: 'unit test',
  };
}

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

function makeTaskDiscoveryStub(tasks: DiscoveredTask[]) {
  return {
    discoverTasks: async () => ({
      tasks,
      repoHealth: {
        hasTests: false,
        hasCI: false,
        hasDocs: false,
        hasLinting: false,
        codeQualityScore: 50,
      },
      suggestedPlan: '',
      analysisTime: 0,
    }),
  };
}

function makeRoutes(cache: Map<string, DiscoveredTask[]>, tasks: DiscoveredTask[]) {
  // Deliberately untyped stubs — we only feed the routes through the single
  // path exercised here. The runtime shape matches what engineer.routes.ts
  // actually dereferences.
  const routes = createEngineerRoutes({
    getUserId: () => 'user-1',
    taskDiscovery: makeTaskDiscoveryStub(tasks) as never,
    sessionManager: new SessionManager(),
    githubService: makeGithubStub() as never,
    taskCache: cache,
  });
  return routes;
}

// ─── Tests ──────────────────────────────────────────

describe('engineer routes — discovered task cache', () => {
  it('populates the cache on discover and drops the entry after createSession', async () => {
    const cache = new Map<string, DiscoveredTask[]>();
    const tasks = [makeDiscoveredTask('t1')];
    const routes = makeRoutes(cache, tasks);

    // discover — cache should hold the entry
    await routes.discover({ body: { owner: 'acme', repo: 'webapp' } });
    assert.equal(cache.size, 1, 'cache populated by discover');
    assert.ok(cache.has('user-1:acme/webapp'), 'key uses userId:owner/repo shape');

    // createSession — cache entry removed
    await routes.createSession({
      body: {
        owner: 'acme',
        repo: 'webapp',
        selectedTaskIds: ['t1'],
        timeBudgetMinutes: 60,
      },
    });
    assert.equal(cache.size, 0, 'cache cleared once tasks are frozen into the session');
  });

  it('discover writes different keys for different (user, repo) pairs', async () => {
    const cache = new Map<string, DiscoveredTask[]>();
    const routes = createEngineerRoutes({
      getUserId: (req: unknown) => (req as { body: { _user: string } }).body._user,
      taskDiscovery: makeTaskDiscoveryStub([makeDiscoveredTask('t1')]) as never,
      sessionManager: new SessionManager(),
      githubService: makeGithubStub() as never,
      taskCache: cache,
    });

    await routes.discover({ body: { _user: 'alice', owner: 'acme', repo: 'web' } });
    await routes.discover({ body: { _user: 'bob', owner: 'acme', repo: 'web' } });

    assert.equal(cache.size, 2, 'two distinct keys');
    assert.ok(cache.has('alice:acme/web'));
    assert.ok(cache.has('bob:acme/web'));
  });

  it('createSession is a no-op on the cache when no discover ran (no throw)', async () => {
    const cache = new Map<string, DiscoveredTask[]>();
    const routes = makeRoutes(cache, []);

    await routes.createSession({
      body: {
        owner: 'acme',
        repo: 'webapp',
        selectedTaskIds: ['t1'],
        timeBudgetMinutes: 60,
      },
    });
    assert.equal(cache.size, 0);
  });
});
