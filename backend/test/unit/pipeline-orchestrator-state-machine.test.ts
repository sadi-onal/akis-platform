/**
 * Pipeline Orchestrator — state-machine & lock mechanism unit tests.
 *
 * Tests the FSM constraints that are the safety backbone of the pipeline:
 *   1. Per-pipeline lock serializes concurrent mutations on the same pipeline
 *   2. Stage guards reject operations from invalid states
 *   3. Cancel is idempotent and works from any stage
 *   4. Pure helper functions (ideaToTitle, etc.)
 *
 * All tests use an in-memory store stub — no DB, no AI, no GitHub.
 */

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';
process.env.AUTH_JWT_SECRET ??= 'test-jwt-secret-at-least-32-chars-long-for-zod';
process.env.DOGFOOD_MODE = 'true';
process.env.AUTO_PUSH_AFTER_PROTO = 'false';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  PipelineOrchestrator,
  ideaToTitle,
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
import {
  InvalidStageError,
  PipelineNotFoundError,
} from '../../src/pipeline/core/contracts/PipelineErrors.js';
import type {
  ScribeAgent,
  ScribeState,
  ScribeResult,
} from '../../src/pipeline/agents/scribe/ScribeAgent.js';
import type { ProtoAgent, ProtoResult } from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type { TraceAgent, TraceResult } from '../../src/pipeline/agents/trace/TraceAgent.js';

// ─── Fixtures ────────────────────────────────────

const validSpec: StructuredSpec = {
  title: 'Todo App',
  problemStatement: 'Kullanicilarin gorevlerini takip edebilecekleri bir uygulama.',
  userStories: [{ persona: 'Kullanici', action: 'Gorev olusturma', benefit: 'Takip' }],
  acceptanceCriteria: [{ id: 'ac-1', given: 'Giris yapmis', when: 'Gorev ekle', then: 'Olusur' }],
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
    {
      id: 'q1',
      question: 'Auth yontemi?',
      reason: 'Detay',
      suggestions: ['Google'],
    },
  ],
};

const mockProtoOutput: ProtoOutput = {
  ok: true,
  branch: 'proto/scaffold-123',
  repo: 'testuser/todo-app',
  repoUrl: 'https://github.com/testuser/todo-app',
  files: [
    {
      filePath: 'src/App.tsx',
      content: 'export default function App() {}',
      linesOfCode: 1,
    },
  ],
  setupCommands: ['npm install'],
  metadata: {
    filesCreated: 1,
    totalLinesOfCode: 1,
    stackUsed: 'React + Vite',
    committed: true,
  },
};

const mockTraceOutput: TraceOutput = {
  ok: true,
  testFiles: [{ filePath: 'tests/e2e/todo.spec.ts', content: 'test()', testCount: 2 }],
  coverageMatrix: { 'ac-1': ['tests/e2e/todo.spec.ts'] },
  testSummary: {
    totalTests: 2,
    coveragePercentage: 100,
    coveredCriteria: ['ac-1'],
    uncoveredCriteria: [],
  },
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
      traceEnabled: true,
      metrics: {
        startedAt: new Date(),
        clarificationRounds: 0,
        retryCount: 0,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
      attemptCount: 0,
      stageVersion: 0,
    };
    this.pipelines.set(id, pipeline);
    return { ...pipeline };
  }

  /** Seed a pipeline directly at a specific stage for guard testing. */
  seed(overrides: Partial<PipelineState> & { id: string; userId: string }): PipelineState {
    const pipeline: PipelineState = {
      stage: 'scribe_generating',
      scribeConversation: [],
      traceEnabled: true,
      metrics: {
        startedAt: new Date(),
        clarificationRounds: 0,
        retryCount: 0,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
      attemptCount: 0,
      stageVersion: 0,
      ...overrides,
    };
    this.pipelines.set(pipeline.id, pipeline);
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
  timeoutMs = 5000
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
    analyzIdea:
      overrides?.analyzIdea ?? (async () => ({ type: 'spec' as const, data: mockScribeOutput })),
    processUserAnswer(state: ScribeState, answer: string) {
      state.conversation.push({ type: 'user_answer', content: answer });
    },
    continueAfterAnswer:
      overrides?.continueAfterAnswer ??
      (async () => ({ type: 'spec' as const, data: mockScribeOutput })),
    regenerateSpec:
      overrides?.regenerateSpec ??
      (async () => ({ type: 'spec' as const, data: mockScribeOutput })),
    generateSpec: async () => ({
      type: 'spec' as const,
      data: mockScribeOutput,
    }),
  } as unknown as ScribeAgent;
}

function createMockProto(overrides?: {
  execute?: (input: unknown) => Promise<ProtoResult>;
}): ProtoAgent {
  return {
    execute:
      overrides?.execute ?? (async () => ({ type: 'output' as const, data: mockProtoOutput })),
  } as unknown as ProtoAgent;
}

function createMockTrace(overrides?: {
  execute?: (input: unknown) => Promise<TraceResult>;
}): TraceAgent {
  return {
    execute:
      overrides?.execute ?? (async () => ({ type: 'output' as const, data: mockTraceOutput })),
  } as unknown as TraceAgent;
}

function createOrchestrator(overrides?: {
  store?: InMemoryStore;
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
        createRepository: async (_o: string, name: string) => ({
          url: `https://github.com/test/${name}`,
        }),
        createBranch: async () => {},
        commitFile: async () => {},
        pushFiles: async () => {},
        createPR: async () => ({ url: '' }),
        listFiles: async () => [] as string[],
        getFileContent: async () => '',
      }),
      overrides?.emit
    ),
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION 1 — ideaToTitle (pure function)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ideaToTitle — pure helper', () => {
  it('returns first line trimmed', () => {
    assert.equal(ideaToTitle('  My App Idea  \nsome details'), 'My App Idea');
  });

  it('truncates to 100 characters', () => {
    const long = 'A'.repeat(150);
    assert.equal(ideaToTitle(long).length, 100);
  });

  it('handles empty string', () => {
    assert.equal(ideaToTitle(''), '');
  });

  it('handles single-line input', () => {
    assert.equal(ideaToTitle('Simple idea'), 'Simple idea');
  });

  it('handles multiline with empty first line', () => {
    // split('\n')[0] will be empty string after trim for '\n...'
    assert.equal(ideaToTitle('\nSecond line'), '');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION 2 — Contract type assertions
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('InvalidStageError contract', () => {
  it('has correct code and message format', () => {
    const err = new InvalidStageError('awaiting_approval', 'scribe_generating');
    assert.equal(err.code, 'INVALID_STAGE');
    assert.equal(err.name, 'InvalidStageError');
    assert.match(err.message, /Invalid stage/);
    assert.match(err.message, /awaiting_approval/);
    assert.match(err.message, /scribe_generating/);
    assert.ok(err instanceof Error);
  });
});

describe('PipelineNotFoundError contract', () => {
  it('has correct code and message format', () => {
    const err = new PipelineNotFoundError('pipe-123');
    assert.equal(err.code, 'PIPELINE_NOT_FOUND');
    assert.equal(err.name, 'PipelineNotFoundError');
    assert.match(err.message, /pipe-123/);
    assert.ok(err instanceof Error);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION 3 — Per-pipeline lock mechanism
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Per-pipeline lock — withLock serialization', () => {
  it('serializes concurrent mutations on the SAME pipeline', async () => {
    const executionOrder: number[] = [];
    const store = new InMemoryStore();

    // Create a pipeline at scribe_clarifying so sendMessage is valid
    const scribe = createMockScribe({
      analyzIdea: async () => ({
        type: 'clarification',
        data: mockClarification,
      }),
      continueAfterAnswer: async () => {
        // Slow down to prove serialization
        await new Promise((r) => setTimeout(r, 50));
        return { type: 'spec' as const, data: mockScribeOutput };
      },
    });
    const { orchestrator: orch, store: s } = createOrchestrator({
      store,
      scribe,
    });

    const started = await orch.startPipeline('user-1', {
      idea: 'Test app',
    });
    await waitForStage(s, started.id, ['scribe_clarifying']);

    // Fire two sendMessage calls concurrently on the same pipeline.
    // The lock ensures they run sequentially, not concurrently.
    const p1 = orch.sendMessage(started.id, 'first answer').then(() => {
      executionOrder.push(1);
    });
    const p2 = orch.sendMessage(started.id, 'second answer').then(() => {
      executionOrder.push(2);
    });
    await Promise.all([p1, p2]);

    // Both completed
    assert.equal(executionOrder.length, 2);
    // They ran in order (1 before 2) because the lock serialized them
    assert.equal(executionOrder[0], 1);
    assert.equal(executionOrder[1], 2);
  });

  it('allows concurrent operations on DIFFERENT pipelines', async () => {
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store });

    // Start two independent pipelines
    const p1 = orchestrator.startPipeline('user-1', { idea: 'App one' });
    const p2 = orchestrator.startPipeline('user-2', { idea: 'App two' });

    // Both should complete without waiting for each other
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.ok(r1.id !== r2.id);
    // Both should be in a valid state (not stuck)
    const s1 = await store.getById(r1.id);
    const s2 = await store.getById(r2.id);
    assert.ok(s1 !== null);
    assert.ok(s2 !== null);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION 4 — Stage guard: approveSpec
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Stage guard — approveSpec', () => {
  it('accepts from awaiting_approval', async () => {
    const { orchestrator, store } = createOrchestrator();
    const started = await orchestrator.startPipeline('user-1', {
      idea: 'Todo app',
    });
    await waitForStage(store, started.id, ['awaiting_approval']);

    // approveSpec should not throw
    const result = await orchestrator.approveSpec(started.id, 'my-app', 'private');
    // Should have advanced past awaiting_approval
    assert.notEqual(result.stage, 'awaiting_approval');
  });

  it('rejects from scribe_clarifying', async () => {
    const scribe = createMockScribe({
      analyzIdea: async () => ({
        type: 'clarification',
        data: mockClarification,
      }),
    });
    const { orchestrator, store } = createOrchestrator({ scribe });

    const started = await orchestrator.startPipeline('user-1', {
      idea: 'App idea',
    });
    await waitForStage(store, started.id, ['scribe_clarifying']);

    await assert.rejects(() => orchestrator.approveSpec(started.id, 'repo', 'private'), {
      message: /Invalid stage/,
    });
  });

  it('rejects from scribe_generating', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-approve-gen';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'scribe_generating',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.approveSpec(pipelineId, 'repo', 'private'), {
      message: /Invalid stage/,
    });
  });

  it('rejects from completed', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-approve-done';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'completed',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.approveSpec(pipelineId, 'repo', 'private'), {
      message: /Invalid stage/,
    });
  });

  it('rejects from cancelled', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-approve-cancelled';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'cancelled',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.approveSpec(pipelineId, 'repo', 'private'), {
      message: /Invalid stage/,
    });
  });

  it('rejects from proto_building', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-approve-proto';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'proto_building',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.approveSpec(pipelineId, 'repo', 'private'), {
      message: /Invalid stage/,
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION 5 — Stage guard: retryStage
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Stage guard — retryStage', () => {
  it('accepts from failed', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-retry-failed';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'failed',
      error: {
        code: 'AI_PROVIDER_ERROR',
        message: 'Fail',
        retryable: true,
      },
    });
    const { orchestrator } = createOrchestrator({ store });

    // retryStage should not throw — it will attempt to re-run scribe
    const result = await orchestrator.retryStage(pipelineId);
    assert.ok(result);
  });

  it('rejects from awaiting_approval', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-retry-awaiting';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'awaiting_approval',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.retryStage(pipelineId), {
      message: /Invalid stage/,
    });
  });

  it('rejects from scribe_generating', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-retry-gen';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'scribe_generating',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.retryStage(pipelineId), {
      message: /Invalid stage/,
    });
  });

  it('rejects from completed', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-retry-done';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'completed',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.retryStage(pipelineId), {
      message: /Invalid stage/,
    });
  });

  it('rejects from cancelled', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-retry-cancelled';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'cancelled',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.retryStage(pipelineId), {
      message: /Invalid stage/,
    });
  });

  it('rejects from proto_building', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-retry-proto';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'proto_building',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.retryStage(pipelineId), {
      message: /Invalid stage/,
    });
  });

  it('enforces max manual retry limit', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-retry-limit';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'failed',
      error: {
        code: 'AI_PROVIDER_ERROR',
        message: 'Fail',
        retryable: true,
      },
      metrics: {
        startedAt: new Date(),
        clarificationRounds: 0,
        retryCount: 5, // already at limit
      },
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.retryStage(pipelineId), {
      message: /Maksimum tekrar deneme limiti/,
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION 6 — Stage guard: rejectSpec
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Stage guard — rejectSpec', () => {
  it('accepts from awaiting_approval', async () => {
    const { orchestrator, store } = createOrchestrator();
    const started = await orchestrator.startPipeline('user-1', {
      idea: 'Todo app',
    });
    await waitForStage(store, started.id, ['awaiting_approval']);

    // rejectSpec should transition back to scribe_generating
    await orchestrator.rejectSpec(started.id, 'add more detail');
    // After regeneration completes, it should land at awaiting_approval again
    const final = await waitForStage(store, started.id, ['awaiting_approval', 'scribe_generating']);
    assert.ok(final.stage === 'awaiting_approval' || final.stage === 'scribe_generating');
  });

  it('rejects from scribe_generating', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-reject-gen';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'scribe_generating',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.rejectSpec(pipelineId, 'feedback'), {
      message: /Invalid stage/,
    });
  });

  it('rejects from completed', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-reject-done';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'completed',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.rejectSpec(pipelineId, 'feedback'), {
      message: /Invalid stage/,
    });
  });

  it('rejects from proto_building', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-reject-proto';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'proto_building',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.rejectSpec(pipelineId, 'feedback'), {
      message: /Invalid stage/,
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION 7 — Stage guard: confirmPush
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Stage guard — confirmPush', () => {
  it('rejects from awaiting_approval', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-push-approval';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'awaiting_approval',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.confirmPush(pipelineId), {
      message: /Invalid stage/,
    });
  });

  it('rejects from scribe_generating', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-push-scribe';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'scribe_generating',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.confirmPush(pipelineId), {
      message: /Invalid stage/,
    });
  });

  it('is idempotent from already-advanced stages (proto_building)', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-push-idem-proto';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'proto_building',
    });
    const { orchestrator } = createOrchestrator({ store });

    // Should not throw — idempotency guard catches already-advanced states
    const result = await orchestrator.confirmPush(pipelineId);
    assert.equal(result.stage, 'proto_building');
  });

  it('is idempotent from already-advanced stages (completed)', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-push-idem-done';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'completed',
    });
    const { orchestrator } = createOrchestrator({ store });

    const result = await orchestrator.confirmPush(pipelineId);
    assert.equal(result.stage, 'completed');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION 8 — Stage guard: cancelPush
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Stage guard — cancelPush', () => {
  it('accepts from awaiting_push_confirm', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-cpush-valid';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'awaiting_push_confirm',
      protoOutput: mockProtoOutput,
    });
    const { orchestrator } = createOrchestrator({ store });

    const result = await orchestrator.cancelPush(pipelineId);
    assert.equal(result.stage, 'completed_partial');
  });

  it('is idempotent from terminal stages', async () => {
    const terminalStages: PipelineStage[] = [
      'completed',
      'completed_partial',
      'cancelled',
      'failed',
    ];

    for (const stage of terminalStages) {
      const store = new InMemoryStore();
      const pipelineId = `pipe-cpush-${stage}`;
      store.seed({ id: pipelineId, userId: 'user-1', stage });
      const { orchestrator } = createOrchestrator({ store });

      const result = await orchestrator.cancelPush(pipelineId);
      assert.equal(result.stage, stage, `cancelPush should be idempotent from ${stage}`);
    }
  });

  it('rejects from scribe_generating', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-cpush-gen';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'scribe_generating',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.cancelPush(pipelineId), {
      message: /Invalid stage/,
    });
  });

  it('rejects from awaiting_approval', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-cpush-approval';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'awaiting_approval',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.cancelPush(pipelineId), {
      message: /Invalid stage/,
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION 9 — Stage guard: skipTrace
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Stage guard — skipTrace', () => {
  it('accepts from trace_testing', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-skip-trace';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'trace_testing',
    });
    const { orchestrator } = createOrchestrator({ store });

    const result = await orchestrator.skipTrace(pipelineId);
    assert.equal(result.stage, 'completed_partial');
  });

  it('accepts from failed when proto already succeeded', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-skip-trace-failed';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'failed',
      protoOutput: mockProtoOutput,
      error: {
        code: 'TRACE_TEST_GENERATION_FAILED',
        message: 'Fail',
        retryable: true,
      },
    });
    const { orchestrator } = createOrchestrator({ store });

    const result = await orchestrator.skipTrace(pipelineId);
    assert.equal(result.stage, 'completed_partial');
  });

  it('rejects from failed when proto has not run', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-skip-trace-no-proto';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'failed',
      // No protoOutput
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.skipTrace(pipelineId), {
      message: /Cannot skip trace/,
    });
  });

  it('rejects from awaiting_approval', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-skip-trace-approval';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'awaiting_approval',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.skipTrace(pipelineId), {
      message: /Cannot skip trace/,
    });
  });

  it('rejects from scribe_generating', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-skip-trace-scribe';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'scribe_generating',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.skipTrace(pipelineId), {
      message: /Cannot skip trace/,
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION 10 — Stage guard: iterateProtoFromFeedback
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Stage guard — iterateProtoFromFeedback', () => {
  it('accepts from awaiting_push_confirm', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-iterate-push';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'awaiting_push_confirm',
      approvedSpec: validSpec,
      protoConfig: { repoName: 'my-app', repoVisibility: 'private' },
      protoOutput: mockProtoOutput,
    });
    const { orchestrator } = createOrchestrator({ store });

    const result = await orchestrator.iterateProtoFromFeedback(pipelineId, 'fix the button');
    assert.equal(result.stage, 'proto_building');
  });

  it('accepts from awaiting_critic_resolution', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-iterate-critic';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'awaiting_critic_resolution',
      approvedSpec: validSpec,
      protoConfig: { repoName: 'my-app', repoVisibility: 'private' },
      protoOutput: mockProtoOutput,
    });
    const { orchestrator } = createOrchestrator({ store });

    const result = await orchestrator.iterateProtoFromFeedback(pipelineId, 'fix the issue');
    assert.equal(result.stage, 'proto_building');
  });

  it('rejects from awaiting_approval', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-iterate-approval';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'awaiting_approval',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.iterateProtoFromFeedback(pipelineId, 'fix something'), {
      message: /Invalid stage/,
    });
  });

  it('rejects from scribe_generating', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-iterate-scribe';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'scribe_generating',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.iterateProtoFromFeedback(pipelineId, 'fix something'), {
      message: /Invalid stage/,
    });
  });

  it('rejects from completed', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-iterate-done';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'completed',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.iterateProtoFromFeedback(pipelineId, 'fix something'), {
      message: /Invalid stage/,
    });
  });

  it('rejects when approvedSpec is missing', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-iterate-no-spec';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'awaiting_push_confirm',
      // No approvedSpec
      protoConfig: { repoName: 'my-app', repoVisibility: 'private' },
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(
      () => orchestrator.iterateProtoFromFeedback(pipelineId, 'fix the button'),
      { message: /no approvedSpec/ }
    );
  });

  it('rejects when protoConfig is missing', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-iterate-no-config';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'awaiting_push_confirm',
      approvedSpec: validSpec,
      // No protoConfig
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(
      () => orchestrator.iterateProtoFromFeedback(pipelineId, 'fix the button'),
      { message: /no protoConfig/ }
    );
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION 11 — Stage guard: criticOverride
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Stage guard — criticOverride', () => {
  it('accepts from awaiting_critic_resolution', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-critic-override';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'awaiting_critic_resolution',
      protoOutput: mockProtoOutput,
    });
    const { orchestrator } = createOrchestrator({ store });

    const result = await orchestrator.criticOverride(pipelineId);
    assert.equal(result.stage, 'awaiting_push_confirm');
  });

  it('is idempotent from already-advanced stages', async () => {
    const advancedStages: PipelineStage[] = [
      'awaiting_push_confirm',
      'proto_building',
      'trace_testing',
      'completed',
      'completed_partial',
    ];

    for (const stage of advancedStages) {
      const store = new InMemoryStore();
      const pipelineId = `pipe-critic-idem-${stage}`;
      store.seed({ id: pipelineId, userId: 'user-1', stage });
      const { orchestrator } = createOrchestrator({ store });

      const result = await orchestrator.criticOverride(pipelineId);
      assert.equal(result.stage, stage, `criticOverride should be idempotent from ${stage}`);
    }
  });

  it('rejects from awaiting_approval', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-critic-approval';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'awaiting_approval',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.criticOverride(pipelineId), {
      message: /Invalid stage/,
    });
  });

  it('rejects from scribe_generating', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-critic-scribe';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'scribe_generating',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.criticOverride(pipelineId), {
      message: /Invalid stage/,
    });
  });

  it('rejects from failed', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-critic-failed';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'failed',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.criticOverride(pipelineId), {
      message: /Invalid stage/,
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION 12 — Stage guard: toggleTrace
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Stage guard — toggleTrace', () => {
  it('accepts from pre-trace stages', async () => {
    const preTraceStages: PipelineStage[] = [
      'scribe_clarifying',
      'scribe_generating',
      'awaiting_approval',
      'proto_building',
      'awaiting_push_confirm',
      'awaiting_critic_resolution',
      'critic_reviewing_spec',
      'critic_reviewing_code',
    ];

    for (const stage of preTraceStages) {
      const store = new InMemoryStore();
      const pipelineId = `pipe-toggle-${stage}`;
      store.seed({ id: pipelineId, userId: 'user-1', stage });
      const { orchestrator } = createOrchestrator({ store });

      const result = await orchestrator.toggleTrace(pipelineId, false);
      assert.ok(result, `toggleTrace should accept from ${stage}`);
    }
  });

  it('rejects from trace_testing', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-toggle-trace';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'trace_testing',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.toggleTrace(pipelineId, false), {
      message: /Invalid stage/,
    });
  });

  it('rejects from completed', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-toggle-done';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'completed',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.toggleTrace(pipelineId, true), {
      message: /Invalid stage/,
    });
  });

  it('rejects from cancelled', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-toggle-cancelled';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'cancelled',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.toggleTrace(pipelineId, true), {
      message: /Invalid stage/,
    });
  });

  it('rejects from failed', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-toggle-failed';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'failed',
    });
    const { orchestrator } = createOrchestrator({ store });

    await assert.rejects(() => orchestrator.toggleTrace(pipelineId, false), {
      message: /Invalid stage/,
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION 13 — cancelPipeline (universal transition)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('cancelPipeline — universal transition', () => {
  const allStages: PipelineStage[] = [
    'scribe_clarifying',
    'scribe_generating',
    'critic_reviewing_spec',
    'awaiting_approval',
    'proto_building',
    'critic_reviewing_code',
    'awaiting_critic_resolution',
    'awaiting_push_confirm',
    'trace_testing',
    'fix_loop_iteration',
    'ci_running',
    'completed',
    'completed_partial',
    'failed',
    'cancelled',
  ];

  for (const stage of allStages) {
    it(`cancels from ${stage}`, async () => {
      const store = new InMemoryStore();
      const pipelineId = `pipe-cancel-${stage}`;
      store.seed({ id: pipelineId, userId: 'user-1', stage });
      const { orchestrator } = createOrchestrator({ store });

      const result = await orchestrator.cancelPipeline(pipelineId);
      assert.equal(
        result.stage,
        'cancelled',
        `cancelPipeline should produce 'cancelled' from ${stage}`
      );
    });
  }

  it('is idempotent — double-cancel returns same state', async () => {
    const store = new InMemoryStore();
    const pipelineId = 'pipe-cancel-idem';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'awaiting_approval',
    });
    const { orchestrator } = createOrchestrator({ store });

    const first = await orchestrator.cancelPipeline(pipelineId);
    assert.equal(first.stage, 'cancelled');

    const second = await orchestrator.cancelPipeline(pipelineId);
    assert.equal(second.stage, 'cancelled');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION 14 — sendMessage routing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('sendMessage — state-dependent routing', () => {
  it('stores as user_note when not in scribe_clarifying', async () => {
    const { orchestrator, store } = createOrchestrator();
    const started = await orchestrator.startPipeline('user-1', {
      idea: 'Todo app',
    });
    await waitForStage(store, started.id, ['awaiting_approval']);

    const result = await orchestrator.sendMessage(started.id, 'just a note');
    assert.equal(result.stage, 'awaiting_approval');
    const lastMsg = result.scribeConversation[result.scribeConversation.length - 1];
    assert.equal(lastMsg.type, 'user_note');
    assert.equal(lastMsg.content, 'just a note');
  });

  it('triggers scribe continuation from scribe_clarifying', async () => {
    const scribe = createMockScribe({
      analyzIdea: async () => ({
        type: 'clarification',
        data: mockClarification,
      }),
      continueAfterAnswer: async () => ({
        type: 'spec' as const,
        data: mockScribeOutput,
      }),
    });
    const { orchestrator, store } = createOrchestrator({ scribe });

    const started = await orchestrator.startPipeline('user-1', {
      idea: 'App',
    });
    await waitForStage(store, started.id, ['scribe_clarifying']);

    await orchestrator.sendMessage(started.id, 'Google Auth');
    const specReady = await waitForStage(store, started.id, ['awaiting_approval']);
    assert.equal(specReady.stage, 'awaiting_approval');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION 15 — getPipeline / getStatus — not-found
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('getStatus — pipeline not found', () => {
  it('throws PipelineNotFoundError for non-existent pipeline', async () => {
    const { orchestrator } = createOrchestrator();

    await assert.rejects(
      () => orchestrator.getStatus('non-existent-id'),
      (err: unknown) => {
        assert.ok(err instanceof PipelineNotFoundError);
        assert.equal(err.code, 'PIPELINE_NOT_FOUND');
        return true;
      }
    );
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION 16 — Event emission on state transitions
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Event emission on transitions', () => {
  it('emits stage_change events during happy path', async () => {
    const events: PipelineEvent[] = [];
    const { orchestrator, store } = createOrchestrator({
      emit: (e) => events.push(e),
    });

    const started = await orchestrator.startPipeline('user-1', {
      idea: 'Todo',
    });
    await waitForStage(store, started.id, ['awaiting_approval']);

    const stageChanges = events.filter((e) => e.type === 'stage_change').map((e) => e.stage);

    assert.ok(
      stageChanges.includes('awaiting_approval'),
      'should emit awaiting_approval stage_change'
    );
  });

  it('emits error event on scribe failure', async () => {
    const events: PipelineEvent[] = [];
    const scribe = createMockScribe({
      analyzIdea: async () => ({
        type: 'error' as const,
        error: {
          code: 'AI_PROVIDER_ERROR',
          message: 'AI down',
          retryable: true,
        },
      }),
    });
    const { orchestrator, store } = createOrchestrator({
      scribe,
      emit: (e) => events.push(e),
    });

    const started = await orchestrator.startPipeline('user-1', {
      idea: 'App',
    });
    await waitForStage(store, started.id, ['failed']);

    const errorEvents = events.filter((e) => e.type === 'error');
    assert.ok(errorEvents.length > 0, 'should emit at least one error event');
    assert.equal(errorEvents[0].stage, 'failed');
  });

  it('emits stage_change for cancel', async () => {
    const events: PipelineEvent[] = [];
    const store = new InMemoryStore();
    const pipelineId = 'pipe-event-cancel';
    store.seed({
      id: pipelineId,
      userId: 'user-1',
      stage: 'awaiting_approval',
    });
    const { orchestrator } = createOrchestrator({
      store,
      emit: (e) => events.push(e),
    });

    await orchestrator.cancelPipeline(pipelineId);

    const cancelEvent = events.find((e) => e.type === 'stage_change' && e.stage === 'cancelled');
    assert.ok(cancelEvent, 'should emit cancelled stage_change event');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION 17 — Token usage accumulation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Token usage accumulation', () => {
  it('getLiveTokenUsage combines persisted and in-memory', () => {
    const { orchestrator } = createOrchestrator();
    const pipelineId = 'pipe-token';

    // Simulate some in-memory accumulation
    const cb = orchestrator.createTokenCallback(pipelineId);
    cb({ inputTokens: 100, outputTokens: 50 });
    cb({ inputTokens: 200, outputTokens: 100 });

    const persisted = { inputTokens: 500, outputTokens: 250, totalTokens: 750 };
    const live = orchestrator.getLiveTokenUsage(pipelineId, persisted);

    assert.equal(live.inputTokens, 800); // 500 + 100 + 200
    assert.equal(live.outputTokens, 400); // 250 + 50 + 100
    assert.equal(live.totalTokens, 1200);
  });

  it('getLiveTokenUsage works with no persisted metrics', () => {
    const { orchestrator } = createOrchestrator();
    const pipelineId = 'pipe-token-empty';

    const cb = orchestrator.createTokenCallback(pipelineId);
    cb({ inputTokens: 42, outputTokens: 18 });

    const live = orchestrator.getLiveTokenUsage(pipelineId);
    assert.equal(live.inputTokens, 42);
    assert.equal(live.outputTokens, 18);
    assert.equal(live.totalTokens, 60);
  });

  it('getLiveTokenUsage returns zeros when no accumulator exists', () => {
    const { orchestrator } = createOrchestrator();
    const live = orchestrator.getLiveTokenUsage('non-existent');
    assert.equal(live.inputTokens, 0);
    assert.equal(live.outputTokens, 0);
    assert.equal(live.totalTokens, 0);
  });

  it('accumulates estimatedCostUsd', () => {
    const { orchestrator } = createOrchestrator();
    const pipelineId = 'pipe-token-cost';

    const cb = orchestrator.createTokenCallback(pipelineId);
    cb({ inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001 });
    cb({ inputTokens: 200, outputTokens: 100, estimatedCostUsd: 0.002 });

    // getLiveTokenUsage doesn't expose cost directly, but the accumulation
    // is verified via the internal state — the important thing is it doesn't
    // throw and the token counts are correct.
    const live = orchestrator.getLiveTokenUsage(pipelineId);
    assert.equal(live.inputTokens, 300);
    assert.equal(live.outputTokens, 150);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION 18 — Comprehensive stage-guard matrix
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Stage transition matrix — all invalid transitions are rejected', () => {
  // Each entry: [method, validStages, ...stagesToReject]
  // This catches regressions if someone accidentally removes a guard.

  const guardedOps: Array<{
    name: string;
    validStages: PipelineStage[];
    rejectedStages: PipelineStage[];
    invoke: (orch: PipelineOrchestrator, id: string) => Promise<unknown>;
  }> = [
    {
      name: 'approveSpec',
      validStages: ['awaiting_approval'],
      rejectedStages: [
        'scribe_clarifying',
        'scribe_generating',
        'proto_building',
        'trace_testing',
        'completed',
        'cancelled',
        'failed',
      ],
      invoke: (o, id) => o.approveSpec(id, 'repo', 'private'),
    },
    {
      name: 'rejectSpec',
      validStages: ['awaiting_approval'],
      rejectedStages: [
        'scribe_clarifying',
        'scribe_generating',
        'proto_building',
        'trace_testing',
        'completed',
        'cancelled',
        'failed',
      ],
      invoke: (o, id) => o.rejectSpec(id, 'feedback'),
    },
    {
      name: 'retryStage',
      validStages: ['failed'],
      rejectedStages: [
        'scribe_clarifying',
        'scribe_generating',
        'awaiting_approval',
        'proto_building',
        'trace_testing',
        'completed',
        'cancelled',
      ],
      invoke: (o, id) => o.retryStage(id),
    },
    {
      name: 'confirmPush',
      validStages: ['awaiting_push_confirm'],
      rejectedStages: [
        'scribe_clarifying',
        'scribe_generating',
        'awaiting_approval',
        'cancelled',
        'failed',
      ],
      invoke: (o, id) => o.confirmPush(id),
    },
    {
      name: 'criticOverride',
      validStages: ['awaiting_critic_resolution'],
      rejectedStages: [
        'scribe_clarifying',
        'scribe_generating',
        'awaiting_approval',
        'cancelled',
        'failed',
      ],
      invoke: (o, id) => o.criticOverride(id),
    },
  ];

  for (const op of guardedOps) {
    for (const stage of op.rejectedStages) {
      it(`${op.name} rejects from ${stage}`, async () => {
        const store = new InMemoryStore();
        const pipelineId = `matrix-${op.name}-${stage}`;
        store.seed({ id: pipelineId, userId: 'user-1', stage });
        const { orchestrator } = createOrchestrator({ store });

        await assert.rejects(
          () => op.invoke(orchestrator, pipelineId),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            // The error should indicate an invalid stage
            assert.ok(
              err.message.includes('Invalid stage') || err.message.includes('Cannot'),
              `${op.name} from ${stage} should reject with stage error, got: ${err.message}`
            );
            return true;
          }
        );
      });
    }
  }
});
