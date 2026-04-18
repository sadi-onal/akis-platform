/**
 * Pipeline-level test: user-uploaded image blocks survive from startPipeline
 * into intermediateState so downstream Proto/Trace calls can read them.
 *
 * Issue #464 BUG-C acceptance criterion: "tek mesajda 3 fotoğraf, 3 agent
 * 3 fotoğrafa da atıfla cevap" — i.e. no truncation. This test focuses on
 * the wire-level persistence + agent-input contract. The actual Proto/Trace
 * dispatch behavior lives in proto-multimodal-iteration.test.ts and
 * trace-multimodal-dispatch.test.ts.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  PipelineOrchestrator,
  type PipelineStore,
  type PipelineStateUpdate,
} from '../../src/pipeline/core/orchestrator/PipelineOrchestrator.js';
import type { PipelineState } from '../../src/pipeline/core/contracts/PipelineTypes.js';
import type { ScribeAgent } from '../../src/pipeline/agents/scribe/ScribeAgent.js';
import type { ProtoAgent } from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type { TraceAgent } from '../../src/pipeline/agents/trace/TraceAgent.js';
import type { GitHubServiceLike } from '../../src/pipeline/core/pipeline-factory.js';
import type { AnthropicImageBlock } from '../../src/services/ai/multimodalClient.js';
import {
  TraceAgent as RealTraceAgent,
  type TraceAIDeps,
  type TraceGitHubDeps,
} from '../../src/pipeline/agents/trace/TraceAgent.js';
import {
  ProtoAgent as RealProtoAgent,
  type ProtoAIDeps,
  type ProtoGitHubDeps,
} from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type { StructuredSpec, TraceInput, ProtoInput } from '../../src/pipeline/core/contracts/PipelineTypes.js';

function imageBlock(tag: string): AnthropicImageBlock {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: tag },
  };
}

const spec: StructuredSpec = {
  title: 'Todo',
  problemStatement: 'Track tasks',
  userStories: [{ persona: 'user', action: 'add task', benefit: 'track' }],
  acceptanceCriteria: [{ id: 'ac-1', given: 'open', when: 'click add', then: 'new task' }],
  technicalConstraints: { stack: 'React + Vite' },
  outOfScope: [],
};

function basePipelineState(overrides?: Partial<PipelineState>): PipelineState {
  return {
    id: 'pl-1',
    userId: 'user-1',
    stage: 'scribe_generating',
    title: 'Test',
    traceEnabled: false,
    scribeConversation: [],
    metrics: { startedAt: new Date(), clarificationRounds: 0, retryCount: 0 },
    attemptCount: 0,
    stageVersion: 0,
    intermediateState: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createStore(initial?: PipelineState): PipelineStore & { state: PipelineState; updates: Partial<PipelineStateUpdate>[] } {
  const state = initial ?? basePipelineState();
  const store: PipelineStore & { state: PipelineState; updates: Partial<PipelineStateUpdate>[] } = {
    state,
    updates: [],
    async create(userId: string) {
      store.state = basePipelineState({ userId });
      return store.state;
    },
    async getById() {
      return store.state;
    },
    async listByUser() {
      return [store.state];
    },
    async update(_id, data) {
      store.updates.push(data);
      store.state = { ...store.state, ...data } as PipelineState;
      return store.state;
    },
  };
  return store;
}

describe('Pipeline image-block forwarding — issue #464 BUG-C', () => {
  it('startPipeline persists all 3 imageBlocks into intermediateState (multi-image preservation)', async () => {
    const store = createStore();
    const scribe = {
      createInitialState: mock.fn(() => ({ pipelineId: '' })),
      analyzIdea: mock.fn(async () => ({ type: 'spec' })),
      handleUserAnswer: mock.fn(),
    };
    const proto = { execute: mock.fn() };
    const trace = { execute: mock.fn() };
    const orch = new PipelineOrchestrator(
      store,
      scribe as unknown as ScribeAgent,
      proto as unknown as ProtoAgent,
      trace as unknown as TraceAgent,
      async () => 'owner',
      async () => 'ghp_mock_token',
      () => ({}) as unknown as GitHubServiceLike,
    );

    const images = [imageBlock('img-1'), imageBlock('img-2'), imageBlock('img-3')];
    await orch.startPipeline('user-1', {
      idea: 'use this mockup',
      imageBlocks: images,
    });

    const persisted = store.updates.find((u) => {
      const ims = (u.intermediateState as Record<string, unknown> | undefined)?.imageBlocks;
      return Array.isArray(ims) && ims.length === 3;
    });
    assert.ok(persisted, 'startPipeline should persist imageBlocks into intermediateState');
    const persistedImages = (persisted!.intermediateState as Record<string, unknown>).imageBlocks as AnthropicImageBlock[];
    assert.equal(persistedImages.length, 3);
    assert.equal(persistedImages[0].source.data, 'img-1');
    assert.equal(persistedImages[1].source.data, 'img-2');
    assert.equal(persistedImages[2].source.data, 'img-3');
  });

  it('startPipeline omits intermediateState.imageBlocks when no images were uploaded', async () => {
    const store = createStore();
    const scribe = {
      createInitialState: mock.fn(() => ({ pipelineId: '' })),
      analyzIdea: mock.fn(async () => ({ type: 'spec' })),
      handleUserAnswer: mock.fn(),
    };
    const proto = { execute: mock.fn() };
    const trace = { execute: mock.fn() };
    const orch = new PipelineOrchestrator(
      store,
      scribe as unknown as ScribeAgent,
      proto as unknown as ProtoAgent,
      trace as unknown as TraceAgent,
      async () => 'owner',
      async () => 'ghp_mock_token',
      () => ({}) as unknown as GitHubServiceLike,
    );

    await orch.startPipeline('user-1', { idea: 'no image' });

    const withImageBlocks = store.updates.find((u) => {
      const im = (u.intermediateState as Record<string, unknown> | undefined)?.imageBlocks;
      return Array.isArray(im);
    });
    assert.equal(withImageBlocks, undefined, 'no image uploads should not persist imageBlocks');
  });
});

describe('Agent contracts still accept 3-image imageBlocks end-to-end', () => {
  it('ProtoAgent iteration accepts 3 images and forwards all to multimodal dep', async () => {
    const captured: Array<readonly AnthropicImageBlock[]> = [];
    const ai: ProtoAIDeps = {
      generateText: async () => JSON.stringify({
        files: [{ filePath: 'App.jsx', content: 'x', linesOfCode: 1 }],
        setupCommands: ['npm install'],
        metadata: { filesCreated: 1, totalLinesOfCode: 1, stackUsed: 't' },
      }),
      generateTextWithImages: async (_s, _u, imgs) => {
        captured.push(imgs);
        return JSON.stringify({
          files: [{ filePath: 'App.jsx', content: 'x', linesOfCode: 1 }],
          setupCommands: ['npm install'],
          metadata: { filesCreated: 1, totalLinesOfCode: 1, stackUsed: 'iter' },
        });
      },
    };
    const github: ProtoGitHubDeps = {
      createRepository: async () => ({ url: 'x' }),
      createBranch: async () => {},
      commitFile: async () => {},
      pushFiles: async () => {},
      createPR: async () => ({ url: 'x' }),
    };
    const agent = new RealProtoAgent(ai, github);
    const input: ProtoInput = {
      spec,
      repoName: 'r',
      repoVisibility: 'private',
      owner: 'o',
      iterationRequest: 'make it green',
      existingFiles: [{ path: 'App.jsx', content: 'existing' }],
      imageBlocks: [imageBlock('1'), imageBlock('2'), imageBlock('3')],
    };
    const res = await agent.execute(input);
    assert.equal(res.type, 'output');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].length, 3);
    assert.equal(captured[0][0].source.data, '1');
    assert.equal(captured[0][2].source.data, '3');
  });

  it('TraceAgent legacy path accepts 3 images and forwards all to multimodal dep', async () => {
    const captured: Array<readonly AnthropicImageBlock[]> = [];
    const ai: TraceAIDeps = {
      generateText: async () => JSON.stringify({
        testFiles: [{ filePath: 't.spec.ts', content: 'test', testCount: 1 }],
        coverageMatrix: { 'ac-1': ['t.spec.ts'] },
        testSummary: { totalTests: 1, coveragePercentage: 100, coveredCriteria: ['ac-1'], uncoveredCriteria: [] },
      }),
      generateTextWithImages: async (_s, _u, imgs) => {
        captured.push(imgs);
        return JSON.stringify({
          testFiles: [{ filePath: 't.spec.ts', content: 'test', testCount: 1 }],
          coverageMatrix: { 'ac-1': ['t.spec.ts'] },
          testSummary: { totalTests: 1, coveragePercentage: 100, coveredCriteria: ['ac-1'], uncoveredCriteria: [] },
        });
      },
    };
    const github: TraceGitHubDeps = {
      listFiles: async () => ['src/App.jsx'],
      getFileContent: async () => 'hello',
      commitFile: async () => {},
      pushFiles: async () => {},
      createBranch: async () => {},
      createPR: async () => ({ url: 'x' }),
    };
    const agent = new RealTraceAgent(ai, github);
    const input: TraceInput = {
      repoOwner: 'o',
      repo: 'r',
      branch: 'main',
      spec,
      dryRun: true,
      imageBlocks: [imageBlock('1'), imageBlock('2'), imageBlock('3')],
    };
    const res = await agent.execute(input);
    assert.equal(res.type, 'output');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].length, 3);
    assert.equal(captured[0][0].source.data, '1');
    assert.equal(captured[0][2].source.data, '3');
  });
});
