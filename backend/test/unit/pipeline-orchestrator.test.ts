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

// ─── Test Fixtures ────────────────────────────────

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
  rawMarkdown: '# Todo App\n...',
  confidence: 0.85,
  clarificationsAsked: 1,
};

const mockClarification: ScribeClarification = {
  questions: [
    { id: 'q1', question: 'Hangi auth yöntemi?', reason: 'Auth detayı gerekli', suggestions: ['Google', 'Email'] },
  ],
};

const mockProtoOutput: ProtoOutput = {
  ok: true,
  branch: 'proto/scaffold-123',
  repo: 'testuser/todo-app',
  repoUrl: 'https://github.com/testuser/todo-app',
  files: [{ filePath: 'src/App.tsx', content: 'export default function App() {}', linesOfCode: 1 }],
  setupCommands: ['git clone ...', 'cd todo-app', 'npm install'],
  metadata: { filesCreated: 1, totalLinesOfCode: 1, stackUsed: 'React + Vite', committed: true },
};

const mockTraceOutput: TraceOutput = {
  ok: true,
  testFiles: [{ filePath: 'tests/e2e/todo.spec.ts', content: 'test()', testCount: 2 }],
  coverageMatrix: { 'ac-1': ['tests/e2e/todo.spec.ts'] },
  testSummary: { totalTests: 2, coveragePercentage: 100, coveredCriteria: ['ac-1'], uncoveredCriteria: [] },
  branch: 'trace/tests-456',
};

// ─── In-Memory Store ──────────────────────────────

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

// ─── Helpers ─────────────────────────────────────

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

// ─── Mock Factories ───────────────────────────────

function createMockScribe(overrides?: {
  analyzIdea?: (state: ScribeState) => Promise<ScribeResult>;
  continueAfterAnswer?: (state: ScribeState) => Promise<ScribeResult>;
  regenerateSpec?: (state: ScribeState, feedback: string) => Promise<ScribeResult>;
}): ScribeAgent {
  return {
    createInitialState(input: { idea: string; context?: string; targetStack?: string }) {
      return {
        idea: input.idea,
        context: input.context,
        targetStack: input.targetStack,
        conversation: [],
        clarificationRound: 0,
        phase: 'clarifying' as const,
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
  getGitHubOwner?: (userId: string) => Promise<string>;
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
      overrides?.getGitHubOwner ?? (async () => 'testuser'),
      async () => 'ghp_mock_token_for_tests',
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

// ─── Happy Path ───────────────────────────────────

describe('Orchestrator — Happy path', () => {
  it('clear idea → spec → approve → completed', async () => {
    const { orchestrator, store } = createOrchestrator();

    const started = await orchestrator.startPipeline('user-1', { idea: 'React todo app with Google Auth' });

    // Background: Scribe runs async — wait for it
    const specReady = await waitForStage(store, started.id, ['awaiting_approval']);
    assert.equal(specReady.stage, 'awaiting_approval');
    assert.ok(specReady.scribeOutput);
    assert.equal(specReady.title, 'Todo App');

    // Approve spec → background Proto+Trace
    await orchestrator.approveSpec(specReady.id, 'my-todo-app', 'private');
    const completed = await waitForStage(store, started.id, ['completed']);
    assert.equal(completed.stage, 'completed');
    assert.ok(completed.protoOutput);
    assert.ok(completed.traceOutput);
    assert.ok(completed.metrics.protoCompletedAt);
    assert.ok(completed.metrics.traceCompletedAt);
  });

  it('vague idea → clarification → answer → spec → approve → completed', async () => {
    const scribe = createMockScribe({
      analyzIdea: async () => {
        return { type: 'clarification', data: mockClarification };
      },
      continueAfterAnswer: async () => {
        return { type: 'spec', data: mockScribeOutput };
      },
    });
    const { orchestrator, store } = createOrchestrator({ scribe });

    // Step 1: Start → wait for clarification
    const started = await orchestrator.startPipeline('user-1', { idea: 'Bir uygulama istiyorum' });
    const clarifying = await waitForStage(store, started.id, ['scribe_clarifying']);
    assert.equal(clarifying.stage, 'scribe_clarifying');
    assert.equal(clarifying.scribeConversation.length, 2); // user_idea + clarification

    // Step 2: Send answer → wait for spec
    await orchestrator.sendMessage(started.id, 'Google Auth istiyorum');
    const specReady = await waitForStage(store, started.id, ['awaiting_approval']);
    assert.equal(specReady.stage, 'awaiting_approval');

    // Step 3: Approve → wait for completed
    await orchestrator.approveSpec(started.id, 'my-app', 'private');
    const completed = await waitForStage(store, started.id, ['completed']);
    assert.equal(completed.stage, 'completed');
  });
});

// ─── Error and Retry ──────────────────────────────

describe('Orchestrator — Error and retry', () => {
  it('Proto fails → failed → retry → completed', async () => {
    let protoCallCount = 0;
    const proto = createMockProto({
      execute: async () => {
        protoCallCount++;
        if (protoCallCount === 1) {
          return {
            type: 'error' as const,
            error: { code: 'GITHUB_API_ERROR', message: 'Temporary failure', retryable: true },
          };
        }
        return { type: 'output' as const, data: mockProtoOutput };
      },
    });
    const { orchestrator, store } = createOrchestrator({ proto });

    // Start → wait for spec
    const started = await orchestrator.startPipeline('user-1', { idea: 'React todo app' });
    await waitForStage(store, started.id, ['awaiting_approval']);

    // Approve → Proto fails
    await orchestrator.approveSpec(started.id, 'my-app', 'private');
    const failed = await waitForStage(store, started.id, ['failed']);
    assert.equal(failed.stage, 'failed');
    assert.equal(failed.error?.code, 'GITHUB_API_ERROR');

    // Retry → Proto succeeds → Trace → completed
    await orchestrator.retryStage(failed.id);
    const retried = await waitForStage(store, started.id, ['completed']);
    assert.equal(retried.stage, 'completed');
    assert.equal(protoCallCount, 2);
  });

  it('Scribe fails → failed → retry → clarification', async () => {
    let analyzCount = 0;
    const scribe = createMockScribe({
      analyzIdea: async () => {
        analyzCount++;
        if (analyzCount === 1) {
          return {
            type: 'error' as const,
            error: { code: 'AI_PROVIDER_ERROR', message: 'AI down', retryable: true },
          };
        }
        return { type: 'clarification', data: mockClarification };
      },
    });
    const { orchestrator, store } = createOrchestrator({ scribe });

    // Start → wait for error
    const started = await orchestrator.startPipeline('user-1', { idea: 'Bir uygulama istiyorum' });
    const errored = await waitForStage(store, started.id, ['failed']);
    assert.equal(errored.stage, 'failed');

    // Retry → clarification
    const retried = await orchestrator.retryStage(started.id);
    assert.equal(retried.stage, 'scribe_clarifying');
  });
});

// ─── Graceful Degradation ─────────────────────────

describe('Orchestrator — Graceful degradation', () => {
  it('Trace failure → completed_partial', async () => {
    const trace = createMockTrace({
      execute: async () => ({
        type: 'error' as const,
        error: { code: 'TRACE_TEST_GENERATION_FAILED', message: 'AI failed', retryable: true },
      }),
    });
    const { orchestrator, store } = createOrchestrator({ trace });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Todo app' });
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-app', 'private');
    const final = await waitForStage(store, started.id, ['completed_partial']);
    assert.equal(final.stage, 'completed_partial');
    assert.ok(final.protoOutput);
    assert.equal(final.traceOutput, undefined);
  });
});

// ─── Cancel ───────────────────────────────────────

describe('Orchestrator — Cancel', () => {
  it('cancels pipeline mid-flow', async () => {
    const scribe = createMockScribe({
      analyzIdea: async () => ({ type: 'clarification', data: mockClarification }),
    });
    const { orchestrator, store } = createOrchestrator({ scribe });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Some app idea here' });
    await waitForStage(store, started.id, ['scribe_clarifying']);

    const cancelled = await orchestrator.cancelPipeline(started.id);
    assert.equal(cancelled.stage, 'cancelled');
  });

  it('allows cancelling completed pipeline (soft delete)', async () => {
    const { orchestrator, store } = createOrchestrator();

    const started = await orchestrator.startPipeline('user-1', { idea: 'Todo app' });
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-app', 'private');
    await waitForStage(store, started.id, ['completed']);

    const cancelled = await orchestrator.cancelPipeline(started.id);
    assert.equal(cancelled.stage, 'cancelled');
  });
});

// ─── Skip Trace ───────────────────────────────────

describe('Orchestrator — Skip trace', () => {
  it('skips trace → completed_partial', async () => {
    const store = new InMemoryStore();
    const trace = createMockTrace({
      execute: async () => {
        return { type: 'output' as const, data: mockTraceOutput };
      },
    });
    const { orchestrator } = createOrchestrator({ store, trace });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Todo app' });
    await store.update(started.id, {
      stage: 'trace_testing' as PipelineStage,
      protoOutput: mockProtoOutput,
      approvedSpec: validSpec,
    });

    const skipped = await orchestrator.skipTrace(started.id);
    assert.equal(skipped.stage, 'completed_partial');
  });
});

// ─── Reject Spec ──────────────────────────────────

describe('Orchestrator — Reject spec', () => {
  it('rejects spec → regenerates → awaiting_approval', async () => {
    const { orchestrator, store } = createOrchestrator();

    const started = await orchestrator.startPipeline('user-1', { idea: 'Todo app' });
    await waitForStage(store, started.id, ['awaiting_approval']);

    const rejected = await orchestrator.rejectSpec(started.id, 'User story eksik');
    assert.equal(rejected.stage, 'awaiting_approval');
    const hasRejection = rejected.scribeConversation.some((m) => m.type === 'spec_rejected');
    assert.ok(hasRejection);
  });
});

// ─── Stage Validation ─────────────────────────────

describe('Orchestrator — Stage validation', () => {
  it('accepts sendMessage as user_note in non-scribe stage', async () => {
    const { orchestrator, store } = createOrchestrator();

    const started = await orchestrator.startPipeline('user-1', { idea: 'Todo app' });
    await waitForStage(store, started.id, ['awaiting_approval']);

    // sendMessage now saves user_note without changing pipeline stage
    const result = await orchestrator.sendMessage(started.id, 'hello');
    assert.strictEqual(result.stage, 'awaiting_approval');
    const lastMsg = result.scribeConversation[result.scribeConversation.length - 1];
    assert.strictEqual(lastMsg.type, 'user_note');
  });

  it('rejects approveSpec in wrong stage', async () => {
    const scribe = createMockScribe({
      analyzIdea: async () => ({ type: 'clarification', data: mockClarification }),
    });
    const { orchestrator, store } = createOrchestrator({ scribe });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Some idea for an app' });
    await waitForStage(store, started.id, ['scribe_clarifying']);

    await assert.rejects(
      () => orchestrator.approveSpec(started.id, 'repo', 'private'),
      { message: /Invalid stage/ },
    );
  });
});

// ─── Concurrent Pipelines ─────────────────────────

describe('Orchestrator — Concurrent pipelines', () => {
  it('handles multiple pipelines for same user independently', async () => {
    const { orchestrator, store } = createOrchestrator();

    const p1 = await orchestrator.startPipeline('user-1', { idea: 'Todo app one' });
    const p2 = await orchestrator.startPipeline('user-1', { idea: 'Todo app two' });

    assert.notEqual(p1.id, p2.id);

    // Both should reach awaiting_approval async
    await waitForStage(store, p1.id, ['awaiting_approval']);
    await waitForStage(store, p2.id, ['awaiting_approval']);

    // Complete p1
    await orchestrator.approveSpec(p1.id, 'app-one', 'private');
    await waitForStage(store, p1.id, ['completed']);

    // p2 still awaiting
    const s2 = await store.getById(p2.id);
    assert.equal(s2?.stage, 'awaiting_approval');

    // List shows both
    const list = await orchestrator.listPipelines('user-1');
    assert.equal(list.length, 2);
  });
});

// ─── Events ───────────────────────────────────────

describe('Orchestrator — Events', () => {
  it('emits events during pipeline lifecycle', async () => {
    const events: PipelineEvent[] = [];
    const { orchestrator, store } = createOrchestrator({
      emit: (event) => events.push(event),
    });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Todo app' });
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-app', 'private');
    await waitForStage(store, started.id, ['completed']);

    assert.ok(events.length >= 3);
    assert.ok(events.some((e) => e.type === 'stage_change' && e.stage === 'awaiting_approval'));
    assert.ok(events.some((e) => e.type === 'stage_change' && e.stage === 'proto_building'));
    assert.ok(events.some((e) => e.type === 'completed'));
  });
});
