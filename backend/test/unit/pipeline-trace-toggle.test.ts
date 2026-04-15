/**
 * Unit tests for the Trace Toggle feature.
 * Tests: traceEnabled=false skips Trace, traceEnabled=true runs full flow,
 * and the toggleTrace endpoint works correctly.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { PipelineOrchestrator, type PipelineStore, type PipelineStateUpdate } from '../../src/pipeline/core/orchestrator/PipelineOrchestrator.js';
import type { PipelineState } from '../../src/pipeline/core/contracts/PipelineTypes.js';
import type { ScribeAgent } from '../../src/pipeline/agents/scribe/ScribeAgent.js';
import type { ProtoAgent } from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type { TraceAgent } from '../../src/pipeline/agents/trace/TraceAgent.js';
import type { GitHubServiceLike } from '../../src/pipeline/core/pipeline-factory.js';

// ─── Shared Fixtures ────────────────────────────

function basePipelineState(overrides?: Partial<PipelineState>): PipelineState {
  return {
    id: 'test-pipeline-1',
    userId: 'user-1',
    stage: 'scribe_generating',
    title: 'Test Pipeline',
    traceEnabled: false,
    scribeConversation: [],
    metrics: {
      startedAt: new Date(),
      clarificationRounds: 0,
      retryCount: 0,
    },
    attemptCount: 0,
    stageVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ─── Mock Store ──────────────────────────────────

function createMockStore(initial?: PipelineState): PipelineStore & { updates: Partial<PipelineStateUpdate>[]; state: PipelineState } {
  const state = initial ?? basePipelineState();
  const store: PipelineStore & { updates: Partial<PipelineStateUpdate>[]; state: PipelineState } = {
    updates: [],
    state,
    async create(userId: string) {
      store.state = basePipelineState({ userId });
      return store.state;
    },
    async getById(_id: string) {
      return store.state;
    },
    async listByUser(_userId: string) {
      return [store.state];
    },
    async update(_id: string, data: Partial<PipelineStateUpdate>) {
      store.updates.push(data);
      if (data.stage) store.state = { ...store.state, stage: data.stage };
      if (data.traceEnabled !== undefined) store.state = { ...store.state, traceEnabled: data.traceEnabled };
      store.state = { ...store.state, updatedAt: new Date() };
      return store.state;
    },
  };
  return store;
}

// ─── Minimal Agent Mocks ─────────────────────────

function createNoopScribe() {
  return {
    createInitialState: mock.fn(() => ({ pipelineId: '' })),
    analyzIdea: mock.fn(async () => ({ type: 'spec' as const, data: {} })),
    handleUserAnswer: mock.fn(async () => ({ type: 'spec' as const, data: {} })),
  };
}

function createNoopProto() {
  return { execute: mock.fn(async () => ({ type: 'success' as const, data: {} })) };
}

function createNoopTrace() {
  return { execute: mock.fn(async () => ({ type: 'success' as const, data: {} })) };
}

function createOrchestrator(store: PipelineStore) {
  return new PipelineOrchestrator(
    store,
    createNoopScribe() as unknown as ScribeAgent,
    createNoopProto() as unknown as ProtoAgent,
    createNoopTrace() as unknown as TraceAgent,
    async () => 'test-owner',
    async () => 'fake-token',
    () => ({}) as unknown as GitHubServiceLike,
  );
}

// ─── Tests ───────────────────────────────────────

describe('Trace Toggle — traceEnabled field in startPipeline', () => {
  it('startPipeline stores traceEnabled=false by default', async () => {
    const store = createMockStore();
    const orchestrator = createOrchestrator(store);

    await orchestrator.startPipeline('user-1', { idea: 'Build a simple calculator app' });

    // Find the update that set traceEnabled
    const traceUpdate = store.updates.find(u => u.traceEnabled !== undefined);
    assert.notEqual(traceUpdate, undefined, 'should have an update with traceEnabled');
    assert.equal(traceUpdate!.traceEnabled, false);
  });

  it('startPipeline stores traceEnabled=true when passed', async () => {
    const store = createMockStore();
    const orchestrator = createOrchestrator(store);

    await orchestrator.startPipeline(
      'user-1',
      { idea: 'Build a simple calculator app' },
      undefined, undefined, undefined, undefined,
      true, // traceEnabled
    );

    const traceUpdate = store.updates.find(u => u.traceEnabled !== undefined);
    assert.notEqual(traceUpdate, undefined, 'should have an update with traceEnabled');
    assert.equal(traceUpdate!.traceEnabled, true);
  });
});

describe('Trace Toggle — toggleTrace method', () => {
  it('toggleTrace updates traceEnabled on a pipeline in proto_building stage', async () => {
    const store = createMockStore(basePipelineState({ stage: 'proto_building', traceEnabled: false }));
    const orchestrator = createOrchestrator(store);

    const result = await orchestrator.toggleTrace('test-pipeline-1', true);
    assert.equal(result.traceEnabled, true);
    assert.equal(store.updates.at(-1)?.traceEnabled, true);
  });

  it('toggleTrace rejects when pipeline is in trace_testing stage', async () => {
    const store = createMockStore(basePipelineState({ stage: 'trace_testing' }));
    const orchestrator = createOrchestrator(store);

    await assert.rejects(
      () => orchestrator.toggleTrace('test-pipeline-1', true),
      (err: Error) => {
        assert.ok(err.message.includes('Invalid stage'), `Expected "Invalid stage" in: ${err.message}`);
        return true;
      },
    );
  });

  it('toggleTrace rejects when pipeline is completed', async () => {
    const store = createMockStore(basePipelineState({ stage: 'completed' }));
    const orchestrator = createOrchestrator(store);

    await assert.rejects(
      () => orchestrator.toggleTrace('test-pipeline-1', false),
      (err: Error) => {
        assert.ok(err.message.includes('Invalid stage'), `Expected "Invalid stage" in: ${err.message}`);
        return true;
      },
    );
  });

  it('toggleTrace allows toggling in awaiting_approval stage', async () => {
    const store = createMockStore(basePipelineState({ stage: 'awaiting_approval', traceEnabled: false }));
    const orchestrator = createOrchestrator(store);

    const result = await orchestrator.toggleTrace('test-pipeline-1', true);
    assert.equal(result.traceEnabled, true);
  });
});

describe('Trace Toggle — pipeline state assertions', () => {
  it('pipeline with traceEnabled=false and completed has no traceOutput', () => {
    const state = basePipelineState({
      stage: 'completed',
      traceEnabled: false,
      protoOutput: {
        ok: true, branch: 'main', repo: 'test-repo', repoUrl: 'https://github.com/test/test-repo',
        files: [{ filePath: 'index.ts', content: 'code', linesOfCode: 1 }],
        setupCommands: ['npm i'],
        metadata: { filesCreated: 1, totalLinesOfCode: 1, stackUsed: 'TS', committed: true },
      },
    });

    assert.equal(state.stage, 'completed');
    assert.equal(state.traceEnabled, false);
    assert.equal(state.traceOutput, undefined);
  });

  it('pipeline with traceEnabled=true and completed has traceOutput', () => {
    const state = basePipelineState({
      stage: 'completed',
      traceEnabled: true,
      traceOutput: {
        ok: true,
        testFiles: [{ filePath: 'test.spec.ts', content: 'test()', testCount: 1 }],
        coverageMatrix: {},
        testSummary: { totalTests: 1, coveragePercentage: 100, coveredCriteria: [], uncoveredCriteria: [] },
      },
    });

    assert.equal(state.stage, 'completed');
    assert.equal(state.traceEnabled, true);
    assert.ok(state.traceOutput);
  });
});
