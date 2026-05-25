/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the Kademe-2 orchestrator stage modules.
 *
 * Covers retryHandlers and iterateDispatchers -- the two stage modules
 * that coordinate retry/iterate logic via injected dependency objects.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  retryTrace,
  retryScribe,
} from '../../src/pipeline/core/orchestrator/stages/retryHandlers.js';
import type {
  RetryTraceDeps,
  RetryScribeDeps,
} from '../../src/pipeline/core/orchestrator/stages/retryHandlers.js';

import {
  dispatchTraceIterate,
  dispatchCriticIterate,
} from '../../src/pipeline/core/orchestrator/stages/iterateDispatchers.js';
import type {
  DispatchTraceIterateDeps,
  DispatchCriticIterateDeps,
} from '../../src/pipeline/core/orchestrator/stages/iterateDispatchers.js';

import type {
  PipelineState,
  PipelineStage,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';

// ── Shared fixture helpers ───────────────────────────────────

function makePipelineState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    id: 'pipe-1',
    userId: 'user-1',
    stage: 'proto_building' as PipelineStage,
    scribeConversation: [],
    traceEnabled: true,
    metrics: {
      startedAt: new Date(),
      clarificationRounds: 0,
      retryCount: 0,
    },
    attemptCount: 0,
    stageVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMockStore(pipeline?: PipelineState | null) {
  let stored = pipeline ?? null;
  const updates: Array<{ id: string; data: any; opts?: any }> = [];
  return {
    getById: async (_id: string) => stored,
    update: async (_id: string, data: any, opts?: any) => {
      updates.push({ id: _id, data, opts });
      if (stored) {
        stored = { ...stored, ...data } as PipelineState;
      }
      return stored as PipelineState;
    },
    create: async () => stored as PipelineState,
    listByUser: async () => (stored ? [stored] : []),
    /** Expose recorded updates for assertion */
    _updates: updates,
  };
}

// ================================================================
// retryHandlers
// ================================================================

describe('retryHandlers', () => {
  describe('retryTrace', () => {
    it('transitions to trace_testing and calls runTrace', async () => {
      const pipeline = makePipelineState({
        stage: 'failed',
        protoOutput: {
          ok: true,
          branch: 'feat/test',
          repo: 'owner/my-repo',
          repoUrl: 'https://github.com/owner/my-repo',
          files: [],
          setupCommands: [],
          metadata: { filesCreated: 0, totalLinesOfCode: 0, stackUsed: 'node', committed: true },
        },
        approvedSpec: {
          title: 'Test',
          problemStatement: 'test',
          userStories: [],
          acceptanceCriteria: [],
          technicalConstraints: {},
          outOfScope: [],
        },
      });
      const store = makeMockStore(pipeline);
      let runTraceCalled = false;
      const emittedStages: string[] = [];

      const deps: RetryTraceDeps = {
        store: store as any,
        validateGitHubAccess: async () => ({ token: 'ghp_mock_test', owner: 'test-owner' }),
        getPipeline: async () => store.getById('pipe-1') as Promise<PipelineState>,
        emitEvent: (_id, _type, stage) => {
          if (stage) emittedStages.push(stage);
        },
        runTrace: async (_id, _metrics, owner, repo, branch) => {
          runTraceCalled = true;
          assert.equal(owner, 'test-owner');
          assert.equal(repo, 'my-repo');
          assert.equal(branch, 'feat/test');
          return makePipelineState({ stage: 'completed' });
        },
      };

      const result = await retryTrace('pipe-1', pipeline, deps);
      assert.equal(runTraceCalled, true);
      assert.ok(emittedStages.includes('trace_testing'));
      assert.equal(result.stage, 'completed');
    });

    it('fails when GitHub access fails', async () => {
      const pipeline = makePipelineState({ stage: 'failed' });
      const store = makeMockStore(pipeline);
      let emittedError = false;

      const deps: RetryTraceDeps = {
        store: store as any,
        validateGitHubAccess: async () => {
          throw new Error('Token expired');
        },
        getPipeline: async () => pipeline,
        emitEvent: (_id, type) => {
          if (type === 'error') emittedError = true;
        },
        runTrace: async () => pipeline,
      };

      await retryTrace('pipe-1', pipeline, deps);
      assert.equal(emittedError, true);
      // store.update should have been called with stage: 'failed'
      assert.ok(store._updates.some((u) => u.data.stage === 'failed'));
    });

    it('throws when protoOutput is missing', async () => {
      const pipeline = makePipelineState({
        stage: 'failed',
        protoOutput: undefined,
      });
      const store = makeMockStore(pipeline);

      const deps: RetryTraceDeps = {
        store: store as any,
        validateGitHubAccess: async () => ({ token: 'ghp_mock', owner: 'owner' }),
        getPipeline: async () => pipeline,
        emitEvent: () => {},
        runTrace: async () => pipeline,
      };

      await assert.rejects(() => retryTrace('pipe-1', pipeline, deps), {
        message: /Cannot retry Trace: protoOutput is missing/,
      });
    });

    it('clears stale traceDryRun intermediate state', async () => {
      const pipeline = makePipelineState({
        stage: 'failed',
        protoOutput: {
          ok: true,
          branch: 'feat/x',
          repo: 'owner/repo',
          repoUrl: 'https://github.com/owner/repo',
          files: [],
          setupCommands: [],
          metadata: { filesCreated: 0, totalLinesOfCode: 0, stackUsed: 'node', committed: true },
        },
        intermediateState: {
          traceDryRunStatus: 'failed',
          traceDryRunErrorCode: 'TIMEOUT',
          traceDryRunErrorAt: '2026-01-01',
          keepThis: 'yes',
        },
      });
      const store = makeMockStore(pipeline);

      const deps: RetryTraceDeps = {
        store: store as any,
        validateGitHubAccess: async () => ({ token: 'ghp_mock', owner: 'owner' }),
        getPipeline: async () => store.getById('pipe-1') as Promise<PipelineState>,
        emitEvent: () => {},
        runTrace: async () => makePipelineState({ stage: 'completed' }),
      };

      await retryTrace('pipe-1', pipeline, deps);

      // Should have updated intermediateState without stale keys
      const cleanUpdate = store._updates.find((u) => u.data.intermediateState);
      assert.ok(cleanUpdate);
      assert.equal(cleanUpdate.data.intermediateState.traceDryRunStatus, undefined);
      assert.equal(cleanUpdate.data.intermediateState.keepThis, 'yes');
    });
  });

  describe('retryScribe', () => {
    it('transitions to scribe_clarifying and calls scribe agent', async () => {
      const pipeline = makePipelineState({
        stage: 'failed',
        scribeConversation: [{ type: 'user_idea', content: 'Build a todo app' }],
      });
      const store = makeMockStore(pipeline);
      const emittedStages: string[] = [];
      let handleScribeResultCalled = false;

      const mockScribeResult = { type: 'spec' as const, data: {} };
      const deps: RetryScribeDeps = {
        store: store as any,
        getPipeline: async () => store.getById('pipe-1') as Promise<PipelineState>,
        emitEvent: (_id, _type, stage) => {
          if (stage) emittedStages.push(stage);
        },
        getAgents: () =>
          ({
            scribe: {
              analyzIdea: async (state: any) => {
                assert.equal(state.idea, 'Build a todo app');
                assert.equal(state.pipelineId, 'pipe-1');
                return mockScribeResult;
              },
            },
          }) as any,
        reconstructScribeState: (p: PipelineState) => ({
          idea: 'Build a todo app',
          conversation: [...p.scribeConversation],
          clarificationRound: 0,
          phase: 'clarifying' as const,
          pendingQuestionIds: [],
          answeredQuestionIds: [],
        }),
        handleScribeResult: async () => {
          handleScribeResultCalled = true;
          return makePipelineState({ stage: 'awaiting_approval' });
        },
      };

      await retryScribe('pipe-1', pipeline, deps);
      assert.ok(emittedStages.includes('scribe_clarifying'));
      assert.equal(handleScribeResultCalled, true);
    });
  });
});

// ================================================================
// iterateDispatchers
// ================================================================

describe('iterateDispatchers', () => {
  describe('dispatchTraceIterate', () => {
    it('skips dispatch when pipeline not found', async () => {
      const store = makeMockStore(null);
      let runProtoAndTraceCalled = false;

      const deps: DispatchTraceIterateDeps = {
        store: store as any,
        validateGitHubAccess: async () => ({ token: 'ghp_mock', owner: 'owner' }),
        emitEvent: () => {},
        runProtoAndTrace: async () => {
          runProtoAndTraceCalled = true;
        },
      };

      await dispatchTraceIterate('pipe-1', 'feedback text', deps);
      assert.equal(runProtoAndTraceCalled, false);
    });

    it('skips dispatch when approvedSpec is missing', async () => {
      const pipeline = makePipelineState({
        approvedSpec: undefined,
        protoConfig: { repoName: 'repo', repoVisibility: 'private' },
      });
      const store = makeMockStore(pipeline);
      let runProtoAndTraceCalled = false;

      const deps: DispatchTraceIterateDeps = {
        store: store as any,
        validateGitHubAccess: async () => ({ token: 'ghp_mock', owner: 'owner' }),
        emitEvent: () => {},
        runProtoAndTrace: async () => {
          runProtoAndTraceCalled = true;
        },
      };

      await dispatchTraceIterate('pipe-1', 'feedback', deps);
      assert.equal(runProtoAndTraceCalled, false);
    });

    it('skips dispatch when protoConfig is missing', async () => {
      const pipeline = makePipelineState({
        approvedSpec: {
          title: 'T',
          problemStatement: 'p',
          userStories: [],
          acceptanceCriteria: [],
          technicalConstraints: {},
          outOfScope: [],
        },
        protoConfig: undefined,
      });
      const store = makeMockStore(pipeline);
      let runProtoAndTraceCalled = false;

      const deps: DispatchTraceIterateDeps = {
        store: store as any,
        validateGitHubAccess: async () => ({ token: 'ghp_mock', owner: 'owner' }),
        emitEvent: () => {},
        runProtoAndTrace: async () => {
          runProtoAndTraceCalled = true;
        },
      };

      await dispatchTraceIterate('pipe-1', 'feedback', deps);
      assert.equal(runProtoAndTraceCalled, false);
    });

    it('skips dispatch when GitHub access fails', async () => {
      const pipeline = makePipelineState({
        approvedSpec: {
          title: 'T',
          problemStatement: 'p',
          userStories: [],
          acceptanceCriteria: [],
          technicalConstraints: {},
          outOfScope: [],
        },
        protoConfig: { repoName: 'repo', repoVisibility: 'private' },
      });
      const store = makeMockStore(pipeline);
      let runProtoAndTraceCalled = false;

      const deps: DispatchTraceIterateDeps = {
        store: store as any,
        validateGitHubAccess: async () => {
          throw new Error('GitHub token invalid');
        },
        emitEvent: () => {},
        runProtoAndTrace: async () => {
          runProtoAndTraceCalled = true;
        },
      };

      await dispatchTraceIterate('pipe-1', 'feedback', deps);
      assert.equal(runProtoAndTraceCalled, false);
    });

    it('skips dispatch when pipeline reached terminal state mid-flight', async () => {
      let callCount = 0;
      const store = {
        getById: async () => {
          callCount++;
          // First call: normal pipeline
          if (callCount === 1) {
            return makePipelineState({
              approvedSpec: {
                title: 'T',
                problemStatement: 'p',
                userStories: [],
                acceptanceCriteria: [],
                technicalConstraints: {},
                outOfScope: [],
              },
              protoConfig: { repoName: 'repo', repoVisibility: 'private' as const },
            });
          }
          // Second call (cancel race guard): cancelled
          return makePipelineState({ stage: 'cancelled' });
        },
        update: async (_id: string, data: any) => makePipelineState({ ...data }),
      };
      let runProtoAndTraceCalled = false;

      const deps: DispatchTraceIterateDeps = {
        store: store as any,
        validateGitHubAccess: async () => ({ token: 'ghp_mock', owner: 'owner' }),
        emitEvent: () => {},
        runProtoAndTrace: async () => {
          runProtoAndTraceCalled = true;
        },
      };

      await dispatchTraceIterate('pipe-1', 'feedback', deps);
      assert.equal(runProtoAndTraceCalled, false);
    });

    it('transitions to proto_building and calls runProtoAndTrace on success', async () => {
      const pipeline = makePipelineState({
        stage: 'trace_testing',
        approvedSpec: {
          title: 'T',
          problemStatement: 'p',
          userStories: [],
          acceptanceCriteria: [],
          technicalConstraints: {},
          outOfScope: [],
        },
        protoConfig: { repoName: 'my-repo', repoVisibility: 'private' },
        intermediateState: { traceIterateRetryCount: 1 },
      });
      const store = makeMockStore(pipeline);
      let runProtoAndTraceArgs: any = null;
      const emittedStages: string[] = [];

      const deps: DispatchTraceIterateDeps = {
        store: store as any,
        validateGitHubAccess: async () => ({ token: 'ghp_mock', owner: 'test-owner' }),
        emitEvent: (_id, _type, stage) => {
          if (stage) emittedStages.push(stage);
        },
        runProtoAndTrace: async (...args) => {
          runProtoAndTraceArgs = args;
        },
      };

      await dispatchTraceIterate('pipe-1', 'fix these tests', deps);

      assert.ok(emittedStages.includes('proto_building'));
      assert.ok(runProtoAndTraceArgs);
      // Verify store updated with incremented retry count
      const stateUpdate = store._updates.find((u) => u.data.intermediateState);
      assert.ok(stateUpdate);
      assert.equal(stateUpdate.data.intermediateState.traceIterateRetryCount, 2);
      assert.equal(stateUpdate.data.intermediateState.traceIterateLastFeedback, 'fix these tests');
    });
  });

  describe('dispatchCriticIterate', () => {
    it('skips dispatch when pipeline not found', async () => {
      const store = makeMockStore(null);
      let runProtoAndTraceCalled = false;

      const deps: DispatchCriticIterateDeps = {
        store: store as any,
        validateGitHubAccess: async () => ({ token: 'ghp_mock', owner: 'owner' }),
        emitEvent: () => {},
        runProtoAndTrace: async () => {
          runProtoAndTraceCalled = true;
        },
      };

      await dispatchCriticIterate('pipe-1', 'feedback', deps);
      assert.equal(runProtoAndTraceCalled, false);
    });

    it('skips dispatch when approvedSpec missing', async () => {
      const pipeline = makePipelineState({
        approvedSpec: undefined,
        protoConfig: { repoName: 'repo', repoVisibility: 'private' },
      });
      const store = makeMockStore(pipeline);
      let runProtoAndTraceCalled = false;

      const deps: DispatchCriticIterateDeps = {
        store: store as any,
        validateGitHubAccess: async () => ({ token: 'ghp_mock', owner: 'owner' }),
        emitEvent: () => {},
        runProtoAndTrace: async () => {
          runProtoAndTraceCalled = true;
        },
      };

      await dispatchCriticIterate('pipe-1', 'feedback', deps);
      assert.equal(runProtoAndTraceCalled, false);
    });

    it('skips dispatch when pipeline reached terminal state mid-flight', async () => {
      let callCount = 0;
      const store = {
        getById: async () => {
          callCount++;
          if (callCount === 1) {
            return makePipelineState({
              approvedSpec: {
                title: 'T',
                problemStatement: 'p',
                userStories: [],
                acceptanceCriteria: [],
                technicalConstraints: {},
                outOfScope: [],
              },
              protoConfig: { repoName: 'repo', repoVisibility: 'private' as const },
            });
          }
          // Second call: failed
          return makePipelineState({ stage: 'failed' });
        },
        update: async (_id: string, data: any) => makePipelineState({ ...data }),
      };
      let runProtoAndTraceCalled = false;

      const deps: DispatchCriticIterateDeps = {
        store: store as any,
        validateGitHubAccess: async () => ({ token: 'ghp_mock', owner: 'owner' }),
        emitEvent: () => {},
        runProtoAndTrace: async () => {
          runProtoAndTraceCalled = true;
        },
      };

      await dispatchCriticIterate('pipe-1', 'feedback', deps);
      assert.equal(runProtoAndTraceCalled, false);
    });

    it('transitions to proto_building and calls runProtoAndTrace on success', async () => {
      const pipeline = makePipelineState({
        stage: 'awaiting_critic_resolution',
        approvedSpec: {
          title: 'T',
          problemStatement: 'p',
          userStories: [],
          acceptanceCriteria: [],
          technicalConstraints: {},
          outOfScope: [],
        },
        protoConfig: { repoName: 'my-repo', repoVisibility: 'public' },
        intermediateState: { criticIterateRetryCount: 0 },
      });
      const store = makeMockStore(pipeline);
      let runProtoAndTraceArgs: any = null;
      const emittedStages: string[] = [];

      const deps: DispatchCriticIterateDeps = {
        store: store as any,
        validateGitHubAccess: async () => ({ token: 'ghp_mock', owner: 'critic-owner' }),
        emitEvent: (_id, _type, stage) => {
          if (stage) emittedStages.push(stage);
        },
        runProtoAndTrace: async (...args) => {
          runProtoAndTraceArgs = args;
        },
      };

      await dispatchCriticIterate('pipe-1', 'fix critical issues', deps);

      assert.ok(emittedStages.includes('proto_building'));
      assert.ok(runProtoAndTraceArgs);
      // Verify store updated with incremented retry count
      const stateUpdate = store._updates.find((u) => u.data.intermediateState);
      assert.ok(stateUpdate);
      assert.equal(stateUpdate.data.intermediateState.criticIterateRetryCount, 1);
      assert.equal(
        stateUpdate.data.intermediateState.criticIterateLastFeedback,
        'fix critical issues'
      );
    });

    it('skips dispatch when GitHub access fails', async () => {
      const pipeline = makePipelineState({
        approvedSpec: {
          title: 'T',
          problemStatement: 'p',
          userStories: [],
          acceptanceCriteria: [],
          technicalConstraints: {},
          outOfScope: [],
        },
        protoConfig: { repoName: 'repo', repoVisibility: 'private' },
      });
      const store = makeMockStore(pipeline);
      let runProtoAndTraceCalled = false;

      const deps: DispatchCriticIterateDeps = {
        store: store as any,
        validateGitHubAccess: async () => {
          throw new Error('Token revoked');
        },
        emitEvent: () => {},
        runProtoAndTrace: async () => {
          runProtoAndTraceCalled = true;
        },
      };

      await dispatchCriticIterate('pipe-1', 'feedback', deps);
      assert.equal(runProtoAndTraceCalled, false);
    });
  });
});
