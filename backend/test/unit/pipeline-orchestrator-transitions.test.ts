import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  PipelineOrchestrator,
  type PipelineStore,
  type PipelineStateUpdate,
  type PipelineEvent,
} from '../../src/pipeline/core/orchestrator/PipelineOrchestrator.js';
import type {
  PipelineState,
  PipelineStage,
  ScribeOutput,
  ScribeClarification,
  StructuredSpec,
  ProtoOutput,
  TraceOutput,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';
import type { ScribeAgent, ScribeState, ScribeResult } from '../../src/pipeline/agents/scribe/ScribeAgent.js';
import type { ProtoAgent, ProtoResult } from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type { TraceAgent, TraceResult } from '../../src/pipeline/agents/trace/TraceAgent.js';

// ─── Fixtures ────────────────────────────────────

const validSpec: StructuredSpec = {
  title: 'Todo App',
  problemStatement: 'Kullanıcıların görevlerini takip edebilecekleri bir uygulama.',
  userStories: [{ persona: 'Kullanıcı', action: 'Görev oluşturma', benefit: 'Takip' }],
  acceptanceCriteria: [{ id: 'ac-1', given: 'Giriş yapmış', when: 'Görev ekle', then: 'Oluşur' }],
  technicalConstraints: { stack: 'React + Vite' },
  outOfScope: [],
};

const mockScribeOutput: ScribeOutput = {
  spec: validSpec,
  rawMarkdown: '# Todo App',
  confidence: 0.85,
  clarificationsAsked: 0,
};

const mockClarification: ScribeClarification = {
  questions: [
    { id: 'q1', question: 'Auth yöntemi?', reason: 'Detay', suggestions: ['Google'] },
  ],
};

const mockProtoOutput: ProtoOutput = {
  ok: true,
  branch: 'proto/scaffold-123',
  repo: 'testuser/todo-app',
  repoUrl: 'https://github.com/testuser/todo-app',
  files: [{ filePath: 'src/App.tsx', content: 'export default function App() {}', linesOfCode: 1 }],
  setupCommands: ['npm install'],
  metadata: { filesCreated: 1, totalLinesOfCode: 1, stackUsed: 'React + Vite', committed: true },
};

const mockTraceOutput: TraceOutput = {
  ok: true,
  testFiles: [{ filePath: 'tests/e2e/todo.spec.ts', content: 'test()', testCount: 2 }],
  coverageMatrix: { 'ac-1': ['tests/e2e/todo.spec.ts'] },
  testSummary: { totalTests: 2, coveragePercentage: 100, coveredCriteria: ['ac-1'], uncoveredCriteria: [] },
  branch: 'trace/tests-456',
};

// ─── In-Memory Store ─────────────────────────────

class InMemoryStore implements PipelineStore {
  private pipelines = new Map<string, PipelineState>();

  async create(userId: string): Promise<PipelineState> {
    const id = crypto.randomUUID();
    const pipeline: PipelineState = {
      id,
      userId,
      stage: 'scribe_generating',
      scribeConversation: [],
      metrics: { startedAt: new Date(), clarificationRounds: 0, retryCount: 0 },
      createdAt: new Date(),
      updatedAt: new Date(),
      attemptCount: 0,
      stageVersion: 0,
    };
    this.pipelines.set(id, pipeline);
    return { ...pipeline };
  }

  async getById(id: string): Promise<PipelineState | null> {
    const p = this.pipelines.get(id);
    return p ? { ...p } : null;
  }

  async listByUser(userId: string): Promise<PipelineState[]> {
    return [...this.pipelines.values()].filter((p) => p.userId === userId).map((p) => ({ ...p }));
  }

  async update(id: string, data: Partial<PipelineStateUpdate>): Promise<PipelineState> {
    const existing = this.pipelines.get(id);
    if (!existing) throw new Error(`Pipeline not found: ${id}`);
    const updated: PipelineState = {
      ...existing,
      ...data,
      metrics: data.metrics ? { ...existing.metrics, ...data.metrics } : existing.metrics,
      updatedAt: new Date(),
    } as PipelineState;
    if (data.error === null) updated.error = undefined;
    this.pipelines.set(id, updated);
    return { ...updated };
  }
}

// ─── Helpers ────────────────────────────────────

async function waitForStage(
  store: PipelineStore,
  id: string,
  targetStages: PipelineStage[],
  timeoutMs = 5000,
): Promise<PipelineState> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = await store.getById(id);
    if (p && targetStages.includes(p.stage)) return p;
    await new Promise((r) => setTimeout(r, 10));
  }
  const p = await store.getById(id);
  throw new Error(`Timeout: expected ${targetStages.join('|')}, got ${p?.stage}`);
}

// ─── Mock Factories ─────────────────────────────

function createMockScribe(overrides?: {
  analyzIdea?: (state: ScribeState) => Promise<ScribeResult>;
  continueAfterAnswer?: (state: ScribeState) => Promise<ScribeResult>;
  regenerateSpec?: (state: ScribeState, feedback: string) => Promise<ScribeResult>;
}): ScribeAgent {
  return {
    createInitialState(input: { idea: string }) {
      return {
        idea: input.idea,
        conversation: [],
        clarificationRound: 0,
        phase: 'clarifying' as const,
        pendingQuestionIds: [],
        answeredQuestionIds: [],
      };
    },
    analyzIdea: overrides?.analyzIdea ?? (async () => ({ type: 'spec' as const, data: mockScribeOutput })),
    processUserAnswer(state: ScribeState, answer: string) {
      state.conversation.push({ type: 'user_answer', content: answer });
    },
    continueAfterAnswer: overrides?.continueAfterAnswer ?? (async () => ({ type: 'spec' as const, data: mockScribeOutput })),
    regenerateSpec: overrides?.regenerateSpec ?? (async () => ({ type: 'spec' as const, data: mockScribeOutput })),
    generateSpec: async () => ({ type: 'spec' as const, data: mockScribeOutput }),
  } as unknown as ScribeAgent;
}

function createMockProto(overrides?: {
  execute?: (input: unknown) => Promise<ProtoResult>;
}): ProtoAgent {
  return {
    execute: overrides?.execute ?? (async () => ({ type: 'output' as const, data: mockProtoOutput })),
  } as unknown as ProtoAgent;
}

function createMockTrace(overrides?: {
  execute?: (input: unknown) => Promise<TraceResult>;
}): TraceAgent {
  return {
    execute: overrides?.execute ?? (async () => ({ type: 'output' as const, data: mockTraceOutput })),
  } as unknown as TraceAgent;
}

function createOrchestrator(overrides?: {
  store?: PipelineStore;
  scribe?: ScribeAgent;
  proto?: ProtoAgent;
  trace?: TraceAgent;
  emit?: (event: PipelineEvent) => void;
}) {
  const store = overrides?.store ?? new InMemoryStore();
  return {
    store,
    orchestrator: new PipelineOrchestrator(
      store,
      overrides?.scribe ?? createMockScribe(),
      overrides?.proto ?? createMockProto(),
      overrides?.trace ?? createMockTrace(),
      async () => 'testuser',
      async () => 'ghp_mock_token',
      () => ({
        createRepository: async (_o: string, name: string) => ({ url: `https://github.com/test/${name}` }),
        createBranch: async () => {},
        commitFile: async () => {},
        pushFiles: async () => {},
        createPR: async () => ({ url: '' }),
        listFiles: async () => [] as string[],
        getFileContent: async () => '',
      }),
      overrides?.emit,
    ),
  };
}

// ─── Full Happy Path Transition Chain ────────────

describe('Orchestrator Transitions — Full pipeline chain', () => {
  it('scribe_generating → awaiting_approval → proto_building → trace_testing → completed', async () => {
    const events: PipelineEvent[] = [];
    const { orchestrator, store } = createOrchestrator({
      emit: (event) => events.push(event),
    });

    // Start → Scribe runs → awaiting_approval
    const started = await orchestrator.startPipeline('user-1', { idea: 'React todo app with auth' });
    const specReady = await waitForStage(store, started.id, ['awaiting_approval']);
    assert.equal(specReady.stage, 'awaiting_approval');

    // Approve → Proto runs → Trace runs → completed
    await orchestrator.approveSpec(specReady.id, 'my-app', 'private');
    const completed = await waitForStage(store, started.id, ['completed']);
    assert.equal(completed.stage, 'completed');

    // Verify stage transitions occurred via events
    const stageChanges = events
      .filter((e) => e.type === 'stage_change')
      .map((e) => e.stage);
    assert.ok(stageChanges.includes('awaiting_approval'));
    assert.ok(stageChanges.includes('proto_building'));
  });
});

// ─── Clarification Flow ─────────────────────────

describe('Orchestrator Transitions — Clarification loop', () => {
  it('scribe_generating → scribe_clarifying → scribe_generating → awaiting_approval', async () => {
    const scribe = createMockScribe({
      analyzIdea: async () => ({ type: 'clarification', data: mockClarification }),
      continueAfterAnswer: async () => ({ type: 'spec', data: mockScribeOutput }),
    });
    const { orchestrator, store } = createOrchestrator({ scribe });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Bir uygulama istiyorum' });
    const clarifying = await waitForStage(store, started.id, ['scribe_clarifying']);
    assert.equal(clarifying.stage, 'scribe_clarifying');

    await orchestrator.sendMessage(started.id, 'Google Auth istiyorum');
    const specReady = await waitForStage(store, started.id, ['awaiting_approval']);
    assert.equal(specReady.stage, 'awaiting_approval');
  });
});

// ─── Invalid Transition Rejections ───────────────

describe('Orchestrator Transitions — Invalid transitions', () => {
  it('accepts sendMessage as user_note when not in scribe_clarifying', async () => {
    const { orchestrator, store } = createOrchestrator();

    const started = await orchestrator.startPipeline('user-1', { idea: 'Todo app' });
    await waitForStage(store, started.id, ['awaiting_approval']);

    // sendMessage now saves user_note in non-scribe states without changing pipeline stage
    const result = await orchestrator.sendMessage(started.id, 'hello');
    assert.strictEqual(result.stage, 'awaiting_approval');
    const lastMsg = result.scribeConversation[result.scribeConversation.length - 1];
    assert.strictEqual(lastMsg.type, 'user_note');
  });

  it('rejects approveSpec when in scribe_clarifying', async () => {
    const scribe = createMockScribe({
      analyzIdea: async () => ({ type: 'clarification', data: mockClarification }),
    });
    const { orchestrator, store } = createOrchestrator({ scribe });

    const started = await orchestrator.startPipeline('user-1', { idea: 'App idea' });
    await waitForStage(store, started.id, ['scribe_clarifying']);

    await assert.rejects(
      () => orchestrator.approveSpec(started.id, 'repo', 'private'),
      { message: /Invalid stage/ },
    );
  });

  it('rejects retryStage when not in failed', async () => {
    const { orchestrator, store } = createOrchestrator();

    const started = await orchestrator.startPipeline('user-1', { idea: 'Todo app' });
    await waitForStage(store, started.id, ['awaiting_approval']);

    await assert.rejects(
      () => orchestrator.retryStage(started.id),
      { message: /Invalid stage/ },
    );
  });
});

// ─── Any State → cancelled ──────────────────────

describe('Orchestrator Transitions — Cancel from any state', () => {
  it('cancels from scribe_clarifying', async () => {
    const scribe = createMockScribe({
      analyzIdea: async () => ({ type: 'clarification', data: mockClarification }),
    });
    const { orchestrator, store } = createOrchestrator({ scribe });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Some app idea' });
    await waitForStage(store, started.id, ['scribe_clarifying']);

    const cancelled = await orchestrator.cancelPipeline(started.id);
    assert.equal(cancelled.stage, 'cancelled');
  });

  it('cancels from awaiting_approval', async () => {
    const { orchestrator, store } = createOrchestrator();

    const started = await orchestrator.startPipeline('user-1', { idea: 'Todo app' });
    await waitForStage(store, started.id, ['awaiting_approval']);

    const cancelled = await orchestrator.cancelPipeline(started.id);
    assert.equal(cancelled.stage, 'cancelled');
  });

  it('cancels from completed', async () => {
    const { orchestrator, store } = createOrchestrator();

    const started = await orchestrator.startPipeline('user-1', { idea: 'Todo app' });
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-app', 'private');
    await waitForStage(store, started.id, ['completed']);

    const cancelled = await orchestrator.cancelPipeline(started.id);
    assert.equal(cancelled.stage, 'cancelled');
  });

  it('cancelling an already-cancelled pipeline is idempotent', async () => {
    const { orchestrator, store } = createOrchestrator();

    const started = await orchestrator.startPipeline('user-1', { idea: 'Todo app' });
    await waitForStage(store, started.id, ['awaiting_approval']);

    const first = await orchestrator.cancelPipeline(started.id);
    assert.equal(first.stage, 'cancelled');

    const second = await orchestrator.cancelPipeline(started.id);
    assert.equal(second.stage, 'cancelled');
  });
});

// ─── Any State → failed ─────────────────────────

describe('Orchestrator Transitions — Failure transitions', () => {
  it('Scribe error → failed', async () => {
    const scribe = createMockScribe({
      analyzIdea: async () => ({
        type: 'error' as const,
        error: { code: 'AI_PROVIDER_ERROR', message: 'AI down', retryable: true },
      }),
    });
    const { orchestrator, store } = createOrchestrator({ scribe });

    const started = await orchestrator.startPipeline('user-1', { idea: 'App idea' });
    const failed = await waitForStage(store, started.id, ['failed']);
    assert.equal(failed.stage, 'failed');
    assert.ok(failed.error);
    assert.equal(failed.error?.code, 'AI_PROVIDER_ERROR');
  });

  it('Proto error → failed', async () => {
    const proto = createMockProto({
      execute: async () => ({
        type: 'error' as const,
        error: { code: 'GITHUB_API_ERROR', message: 'Git fail', retryable: true },
      }),
    });
    const { orchestrator, store } = createOrchestrator({ proto });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Todo app' });
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-app', 'private');

    const failed = await waitForStage(store, started.id, ['failed']);
    assert.equal(failed.stage, 'failed');
    assert.equal(failed.error?.code, 'GITHUB_API_ERROR');
  });

  it('failed → retry → recovers', async () => {
    let protoCallCount = 0;
    const proto = createMockProto({
      execute: async () => {
        protoCallCount++;
        if (protoCallCount === 1) {
          return { type: 'error' as const, error: { code: 'GITHUB_API_ERROR', message: 'Temp', retryable: true } };
        }
        return { type: 'output' as const, data: mockProtoOutput };
      },
    });
    const { orchestrator, store } = createOrchestrator({ proto });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Todo app' });
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-app', 'private');
    await waitForStage(store, started.id, ['failed']);

    await orchestrator.retryStage(started.id);
    const completed = await waitForStage(store, started.id, ['completed']);
    assert.equal(completed.stage, 'completed');
  });
});
