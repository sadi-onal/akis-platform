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
import {
  PipelineNotFoundError,
  InvalidStageError,
  PipelineErrorCode,
  createPipelineError,
  RETRY_CONFIG,
} from '../../src/pipeline/core/contracts/PipelineErrors.js';
import {
  ScribeInputSchema,
} from '../../src/pipeline/core/contracts/PipelineSchemas.js';
import type { ScribeAgent, ScribeState, ScribeResult } from '../../src/pipeline/agents/scribe/ScribeAgent.js';
import type { ProtoAgent, ProtoResult } from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type { TraceAgent, TraceResult } from '../../src/pipeline/agents/trace/TraceAgent.js';

// ─── Test Fixtures ────────────────────────────────

const validSpec: StructuredSpec = {
  title: 'Edge Case Todo App',
  problemStatement: 'Kullanicilarin gorevlerini takip edebilecekleri bir uygulama.',
  userStories: [{ persona: 'Kullanici', action: 'Gorev olusturma', benefit: 'Takip' }],
  acceptanceCriteria: [{ id: 'ac-1', given: 'Giris yapmis', when: 'Gorev ekle', then: 'Olusur' }],
  technicalConstraints: { stack: 'React + Vite' },
  outOfScope: [],
};

const mockScribeOutput: ScribeOutput = {
  spec: validSpec,
  rawMarkdown: '# Edge Case Todo App',
  confidence: 0.85,
  clarificationsAsked: 0,
};

const mockClarification: ScribeClarification = {
  questions: [
    { id: 'q1', question: 'Auth yontemi?', reason: 'Detay', suggestions: ['Google'] },
  ],
};

const mockProtoOutput: ProtoOutput = {
  ok: true,
  branch: 'proto/scaffold-edge',
  repo: 'testuser/edge-app',
  repoUrl: 'https://github.com/testuser/edge-app',
  files: [{ filePath: 'src/App.tsx', content: 'export default function App() {}', linesOfCode: 1 }],
  setupCommands: ['npm install'],
  metadata: { filesCreated: 1, totalLinesOfCode: 1, stackUsed: 'React + Vite', committed: true },
};

const mockTraceOutput: TraceOutput = {
  ok: true,
  testFiles: [{ filePath: 'tests/e2e/edge.spec.ts', content: 'test()', testCount: 2 }],
  coverageMatrix: { 'ac-1': ['tests/e2e/edge.spec.ts'] },
  testSummary: { totalTests: 2, coveragePercentage: 100, coveredCriteria: ['ac-1'], uncoveredCriteria: [] },
  branch: 'trace/tests-edge',
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

  /** Direct setter for testing — forces a specific stage without going through the orchestrator */
  async forceStage(id: string, stage: PipelineStage, extras?: Partial<PipelineState>): Promise<void> {
    const existing = this.pipelines.get(id);
    if (!existing) throw new Error(`Pipeline not found: ${id}`);
    this.pipelines.set(id, { ...existing, stage, ...extras, updatedAt: new Date() });
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

// ═══════════════════════════════════════════════════
// 1. EDGE CASE: Empty / short idea validation
// ═══════════════════════════════════════════════════

describe('Pipeline edge cases — Empty idea validation', () => {
  it('ScribeInputSchema rejects empty string idea', () => {
    const result = ScribeInputSchema.safeParse({ idea: '' });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.error.issues.length > 0);
    }
  });

  it('ScribeInputSchema rejects idea shorter than 10 characters', () => {
    const result = ScribeInputSchema.safeParse({ idea: 'short' });
    assert.equal(result.success, false);
  });

  it('ScribeInputSchema rejects single-word idea under 10 chars', () => {
    const result = ScribeInputSchema.safeParse({ idea: 'app' });
    assert.equal(result.success, false);
  });

  it('ScribeInputSchema rejects whitespace-only idea under 10 chars', () => {
    const result = ScribeInputSchema.safeParse({ idea: '         ' });
    assert.equal(result.success, false);
  });

  it('ScribeInputSchema accepts idea with exactly 10 characters', () => {
    const result = ScribeInputSchema.safeParse({ idea: '1234567890' });
    assert.equal(result.success, true);
  });

  it('ScribeInputSchema rejects idea with 9 characters', () => {
    const result = ScribeInputSchema.safeParse({ idea: '123456789' });
    assert.equal(result.success, false);
  });

  it('ScribeInputSchema rejects missing idea field', () => {
    const result = ScribeInputSchema.safeParse({});
    assert.equal(result.success, false);
  });

  it('ScribeInputSchema rejects null idea', () => {
    const result = ScribeInputSchema.safeParse({ idea: null });
    assert.equal(result.success, false);
  });

  it('createPipelineError returns correct SCRIBE_EMPTY_IDEA error', () => {
    const error = createPipelineError(PipelineErrorCode.SCRIBE_EMPTY_IDEA);
    assert.equal(error.code, 'SCRIBE_EMPTY_IDEA');
    assert.equal(error.retryable, false);
    assert.ok(error.message.length > 0);
    assert.equal(error.recoveryAction, undefined);
  });
});

// ═══════════════════════════════════════════════════
// 2. EDGE CASE: Invalid state transitions
// ═══════════════════════════════════════════════════

describe('Pipeline edge cases — Invalid state transitions', () => {
  it('rejects approveSpec from proto_building stage', async () => {
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Todo app edge case' });
    await waitForStage(store, started.id, ['awaiting_approval']);

    // Force stage to proto_building to simulate mid-build
    await store.forceStage(started.id, 'proto_building');

    await assert.rejects(
      () => orchestrator.approveSpec(started.id, 'repo', 'private'),
      (err: Error) => err.message.includes('Invalid stage'),
    );
  });

  it('rejects approveSpec from completed stage', async () => {
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Todo app edge case' });
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-app', 'private');
    await waitForStage(store, started.id, ['completed']);

    await assert.rejects(
      () => orchestrator.approveSpec(started.id, 'repo', 'private'),
      (err: Error) => err.message.includes('Invalid stage'),
    );
  });

  it('rejects approveSpec from cancelled stage', async () => {
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Todo app edge case' });
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.cancelPipeline(started.id);

    await assert.rejects(
      () => orchestrator.approveSpec(started.id, 'repo', 'private'),
      (err: Error) => err.message.includes('Invalid stage'),
    );
  });

  it('rejects retryStage from awaiting_approval (non-failed)', async () => {
    const { orchestrator, store } = createOrchestrator();

    const started = await orchestrator.startPipeline('user-1', { idea: 'Todo app edge case' });
    await waitForStage(store, started.id, ['awaiting_approval']);

    await assert.rejects(
      () => orchestrator.retryStage(started.id),
      (err: Error) => err.message.includes('Invalid stage'),
    );
  });

  it('rejects retryStage from completed stage', async () => {
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Todo app edge case' });
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-app', 'private');
    await waitForStage(store, started.id, ['completed']);

    await assert.rejects(
      () => orchestrator.retryStage(started.id),
      (err: Error) => err.message.includes('Invalid stage'),
    );
  });

  it('rejects retryStage from cancelled stage', async () => {
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Todo app edge case' });
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.cancelPipeline(started.id);

    await assert.rejects(
      () => orchestrator.retryStage(started.id),
      (err: Error) => err.message.includes('Invalid stage'),
    );
  });

  it('rejects rejectSpec from non-awaiting_approval stage', async () => {
    const scribe = createMockScribe({
      analyzIdea: async () => ({ type: 'clarification', data: mockClarification }),
    });
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store, scribe });

    const started = await orchestrator.startPipeline('user-1', { idea: 'App edge case idea' });
    await waitForStage(store, started.id, ['scribe_clarifying']);

    await assert.rejects(
      () => orchestrator.rejectSpec(started.id, 'some feedback'),
      (err: Error) => err.message.includes('Invalid stage'),
    );
  });

  it('InvalidStageError has correct fields', () => {
    const err = new InvalidStageError('awaiting_approval', 'completed');
    assert.equal(err.code, 'INVALID_STAGE');
    assert.equal(err.name, 'InvalidStageError');
    assert.ok(err.message.includes('awaiting_approval'));
    assert.ok(err.message.includes('completed'));
  });
});

// ═══════════════════════════════════════════════════
// 3. EDGE CASE: Retry on failed state
// ═══════════════════════════════════════════════════

describe('Pipeline edge cases — Retry on failed state', () => {
  it('retry clears error and increments retryCount', async () => {
    let protoCallCount = 0;
    const proto = createMockProto({
      execute: async () => {
        protoCallCount++;
        if (protoCallCount === 1) {
          return { type: 'error' as const, error: { code: 'GITHUB_API_ERROR', message: 'Fail', retryable: true } };
        }
        return { type: 'output' as const, data: mockProtoOutput };
      },
    });
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store, proto });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Todo app edge retry' }, undefined, undefined, undefined, undefined, true);
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-app', 'private');
    await waitForStage(store, started.id, ['failed']);

    // Verify error is present before retry
    const failedState = await store.getById(started.id);
    assert.ok(failedState?.error);
    assert.equal(failedState?.metrics.retryCount, 0);

    // Retry
    const retried = await orchestrator.retryStage(started.id);
    assert.equal(retried.error, undefined, 'Error should be cleared after retry');
    assert.equal(retried.metrics.retryCount, 1, 'retryCount should increment');
  });

  it('retry Scribe failure resets to scribe_clarifying', async () => {
    let analyzCount = 0;
    const scribe = createMockScribe({
      analyzIdea: async () => {
        analyzCount++;
        if (analyzCount === 1) {
          return { type: 'error' as const, error: { code: 'AI_PROVIDER_ERROR', message: 'Down', retryable: true } };
        }
        return { type: 'clarification', data: mockClarification };
      },
    });
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store, scribe });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Edge retry scribe' });
    await waitForStage(store, started.id, ['failed']);

    // Retry should go back to scribe
    const retried = await orchestrator.retryStage(started.id);
    assert.equal(retried.stage, 'scribe_clarifying');
  });

  it('retry Trace failure transitions to trace_testing then completes', async () => {
    let traceCallCount = 0;
    const trace = createMockTrace({
      execute: async () => {
        traceCallCount++;
        if (traceCallCount === 1) {
          return { type: 'error' as const, error: { code: 'TRACE_TEST_GENERATION_FAILED', message: 'Fail', retryable: true } };
        }
        return { type: 'output' as const, data: mockTraceOutput };
      },
    });
    const store = new InMemoryStore();
    // Use a proto that succeeds then trace that fails first time
    const { orchestrator } = createOrchestrator({ store, trace });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Edge retry trace' }, undefined, undefined, undefined, undefined, true);
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-app', 'private');

    // Trace error causes completed_partial (graceful degradation)
    await waitForStage(store, started.id, ['completed_partial']);

    // Force to failed for retry test (since completed_partial is terminal,
    // we need to force the state for this edge case)
    await store.forceStage(started.id, 'failed', {
      error: { code: 'TRACE_TEST_GENERATION_FAILED', message: 'Fail', retryable: true },
    } as Partial<PipelineState>);

    await orchestrator.retryStage(started.id);
    const completed = await waitForStage(store, started.id, ['completed']);
    assert.equal(completed.stage, 'completed');
    assert.ok(completed.traceOutput);
  });

  it('retry enforces max 5 manual retries', async () => {
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Edge retry limit' });
    await waitForStage(store, started.id, ['awaiting_approval']);

    // Force to failed with retryCount at the limit
    await store.forceStage(started.id, 'failed', {
      metrics: { startedAt: new Date(), clarificationRounds: 0, retryCount: 5 },
    } as Partial<PipelineState>);

    await assert.rejects(
      () => orchestrator.retryStage(started.id),
      (err: Error & { statusCode?: number }) => {
        return err.message.includes('Maksimum') && err.statusCode === 429;
      },
    );
  });

  it('retry with retryCount below limit succeeds', async () => {
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
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store, proto });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Edge retry under limit' });
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-app', 'private');
    await waitForStage(store, started.id, ['failed']);

    // Force retryCount to 4 (one below limit)
    await store.forceStage(started.id, 'failed', {
      approvedSpec: validSpec,
      metrics: { startedAt: new Date(), clarificationRounds: 0, retryCount: 4 },
    } as Partial<PipelineState>);

    // Should succeed (count goes to 5)
    const retried = await orchestrator.retryStage(started.id);
    assert.equal(retried.metrics.retryCount, 5);
  });
});

// ═══════════════════════════════════════════════════
// 4. EDGE CASE: Cancel during different stages
// ═══════════════════════════════════════════════════

describe('Pipeline edge cases — Cancel during different stages', () => {
  it('cancel from scribe_generating stage', async () => {
    // Use a slow scribe to catch it in scribe_generating
    const scribe = createMockScribe({
      analyzIdea: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { type: 'spec' as const, data: mockScribeOutput };
      },
    });
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store, scribe });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Edge cancel generating' });
    // The store.create sets initial stage to scribe_generating
    // Cancel immediately before scribe finishes
    const cancelled = await orchestrator.cancelPipeline(started.id);
    assert.equal(cancelled.stage, 'cancelled');
  });

  it('cancel from failed stage', async () => {
    const scribe = createMockScribe({
      analyzIdea: async () => ({
        type: 'error' as const,
        error: { code: 'AI_PROVIDER_ERROR', message: 'Down', retryable: true },
      }),
    });
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store, scribe });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Edge cancel failed' });
    await waitForStage(store, started.id, ['failed']);

    const cancelled = await orchestrator.cancelPipeline(started.id);
    assert.equal(cancelled.stage, 'cancelled');
  });

  it('cancel from completed_partial stage', async () => {
    const trace = createMockTrace({
      execute: async () => ({
        type: 'error' as const,
        error: { code: 'TRACE_TEST_GENERATION_FAILED', message: 'Fail', retryable: true },
      }),
    });
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store, trace });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Edge cancel partial' }, undefined, undefined, undefined, undefined, true);
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-app', 'private');
    await waitForStage(store, started.id, ['completed_partial']);

    const cancelled = await orchestrator.cancelPipeline(started.id);
    assert.equal(cancelled.stage, 'cancelled');
  });

  it('cancel from trace_testing stage', async () => {
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Edge cancel trace' }, undefined, undefined, undefined, undefined, true);
    await waitForStage(store, started.id, ['awaiting_approval']);

    // Force to trace_testing to simulate mid-trace
    await store.forceStage(started.id, 'trace_testing', {
      protoOutput: mockProtoOutput,
    } as Partial<PipelineState>);

    const cancelled = await orchestrator.cancelPipeline(started.id);
    assert.equal(cancelled.stage, 'cancelled');
  });

  it('double cancel is idempotent (no error thrown)', async () => {
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Edge double cancel' });
    await waitForStage(store, started.id, ['awaiting_approval']);

    const first = await orchestrator.cancelPipeline(started.id);
    assert.equal(first.stage, 'cancelled');

    const second = await orchestrator.cancelPipeline(started.id);
    assert.equal(second.stage, 'cancelled');
  });

  it('cancel emits stage_change event with cancelled', async () => {
    const events: PipelineEvent[] = [];
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store, emit: (e) => events.push(e) });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Edge cancel event' });
    await waitForStage(store, started.id, ['awaiting_approval']);

    await orchestrator.cancelPipeline(started.id);
    const cancelEvent = events.find((e) => e.type === 'stage_change' && e.stage === 'cancelled');
    assert.ok(cancelEvent, 'Should emit stage_change event with cancelled');
    assert.equal(cancelEvent?.pipelineId, started.id);
  });
});

// ═══════════════════════════════════════════════════
// 5. EDGE CASE: Skip trace → completed_partial
// ═══════════════════════════════════════════════════

describe('Pipeline edge cases — Skip trace transitions', () => {
  it('skipTrace from trace_testing transitions to completed_partial', async () => {
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Edge skip trace' }, undefined, undefined, undefined, undefined, true);
    await waitForStage(store, started.id, ['awaiting_approval']);

    await store.forceStage(started.id, 'trace_testing', {
      protoOutput: mockProtoOutput,
      approvedSpec: validSpec,
    } as Partial<PipelineState>);

    const skipped = await orchestrator.skipTrace(started.id);
    assert.equal(skipped.stage, 'completed_partial');
    assert.ok(skipped.metrics.totalDurationMs != null, 'Should calculate totalDurationMs');
  });

  it('skipTrace from failed stage with protoOutput succeeds (Trace failure skip)', async () => {
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Edge skip trace failed' }, undefined, undefined, undefined, undefined, true);
    await waitForStage(store, started.id, ['awaiting_approval']);

    // Simulate: Proto succeeded, Trace failed
    await store.forceStage(started.id, 'failed', {
      protoOutput: mockProtoOutput,
      error: { code: 'TRACE_TEST_GENERATION_FAILED', message: 'Fail', retryable: true },
    } as Partial<PipelineState>);

    const skipped = await orchestrator.skipTrace(started.id);
    assert.equal(skipped.stage, 'completed_partial');
  });

  it('skipTrace from failed stage without protoOutput throws', async () => {
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Edge skip trace no proto' });
    await waitForStage(store, started.id, ['awaiting_approval']);

    // Simulate: Scribe failed (no protoOutput)
    await store.forceStage(started.id, 'failed', {
      error: { code: 'AI_PROVIDER_ERROR', message: 'Scribe fail', retryable: true },
    } as Partial<PipelineState>);

    await assert.rejects(
      () => orchestrator.skipTrace(started.id),
      (err: Error) => err.message.includes('Cannot skip trace'),
    );
  });

  it('skipTrace from scribe_clarifying throws', async () => {
    const scribe = createMockScribe({
      analyzIdea: async () => ({ type: 'clarification', data: mockClarification }),
    });
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store, scribe });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Edge skip trace clarifying' });
    await waitForStage(store, started.id, ['scribe_clarifying']);

    await assert.rejects(
      () => orchestrator.skipTrace(started.id),
      (err: Error) => err.message.includes('Cannot skip trace'),
    );
  });

  it('skipTrace from awaiting_approval throws', async () => {
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Edge skip trace approval' });
    await waitForStage(store, started.id, ['awaiting_approval']);

    await assert.rejects(
      () => orchestrator.skipTrace(started.id),
      (err: Error) => err.message.includes('Cannot skip trace'),
    );
  });

  it('skipTrace from completed throws', async () => {
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Edge skip trace completed' });
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-app', 'private');
    await waitForStage(store, started.id, ['completed']);

    await assert.rejects(
      () => orchestrator.skipTrace(started.id),
      (err: Error) => err.message.includes('Cannot skip trace'),
    );
  });

  it('skipTrace emits completed event with completed_partial', async () => {
    const events: PipelineEvent[] = [];
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store, emit: (e) => events.push(e) });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Edge skip trace event' }, undefined, undefined, undefined, undefined, true);
    await waitForStage(store, started.id, ['awaiting_approval']);

    await store.forceStage(started.id, 'trace_testing', {
      protoOutput: mockProtoOutput,
    } as Partial<PipelineState>);

    await orchestrator.skipTrace(started.id);
    const completedEvent = events.find((e) => e.type === 'completed' && e.stage === 'completed_partial');
    assert.ok(completedEvent, 'Should emit completed event with completed_partial stage');
  });
});

// ═══════════════════════════════════════════════════
// 6. EDGE CASE: Pipeline not found
// ═══════════════════════════════════════════════════

describe('Pipeline edge cases — Pipeline not found', () => {
  it('getStatus throws PipelineNotFoundError for non-existent id', async () => {
    const { orchestrator } = createOrchestrator();

    await assert.rejects(
      () => orchestrator.getStatus('non-existent-uuid'),
      (err: Error) => err instanceof PipelineNotFoundError,
    );
  });

  it('cancelPipeline throws PipelineNotFoundError for non-existent id', async () => {
    const { orchestrator } = createOrchestrator();

    await assert.rejects(
      () => orchestrator.cancelPipeline('non-existent-uuid'),
      (err: Error) => err instanceof PipelineNotFoundError,
    );
  });

  it('retryStage throws PipelineNotFoundError for non-existent id', async () => {
    const { orchestrator } = createOrchestrator();

    await assert.rejects(
      () => orchestrator.retryStage('non-existent-uuid'),
      (err: Error) => err instanceof PipelineNotFoundError,
    );
  });

  it('PipelineNotFoundError has correct code', () => {
    const err = new PipelineNotFoundError('some-id');
    assert.equal(err.code, 'PIPELINE_NOT_FOUND');
    assert.equal(err.name, 'PipelineNotFoundError');
    assert.ok(err.message.includes('some-id'));
  });
});

// ═══════════════════════════════════════════════════
// 7. EDGE CASE: Error definitions completeness
// ═══════════════════════════════════════════════════

describe('Pipeline edge cases — Error definitions completeness', () => {
  it('all PipelineErrorCode values produce valid errors', () => {
    for (const code of Object.values(PipelineErrorCode)) {
      const error = createPipelineError(code, `tech detail for ${code}`);
      assert.equal(error.code, code);
      assert.ok(error.message.length > 0, `${code} should have a message`);
      assert.equal(typeof error.retryable, 'boolean', `${code} should have retryable`);
      assert.equal(error.technicalDetail, `tech detail for ${code}`);
    }
  });

  it('RETRY_CONFIG has sane defaults', () => {
    assert.equal(RETRY_CONFIG.maxRetries, 3);
    assert.ok(RETRY_CONFIG.backoffDelays.length === 3);
    assert.ok(RETRY_CONFIG.stageTimeoutMs > 0);
    assert.ok(RETRY_CONFIG.traceStageTimeoutMs > RETRY_CONFIG.stageTimeoutMs,
      'Trace timeout should be larger than default stage timeout');
    assert.ok(RETRY_CONFIG.aiCallTimeoutMs > 0);
    assert.ok(RETRY_CONFIG.maxCodebaseContextChars > 0);
  });

  it('retryable errors have recoveryAction=retry', () => {
    const retryableCodes = [
      PipelineErrorCode.AI_RATE_LIMITED,
      PipelineErrorCode.AI_PROVIDER_ERROR,
      PipelineErrorCode.AI_INVALID_RESPONSE,
      PipelineErrorCode.GITHUB_API_ERROR,
      PipelineErrorCode.PROTO_SCAFFOLD_GENERATION_FAILED,
      PipelineErrorCode.PROTO_PUSH_FAILED,
      PipelineErrorCode.TRACE_CODE_READ_FAILED,
      PipelineErrorCode.TRACE_TEST_GENERATION_FAILED,
      PipelineErrorCode.TRACE_AI_CALL_TIMEOUT,
      PipelineErrorCode.PIPELINE_TIMEOUT,
      PipelineErrorCode.NETWORK_ERROR,
    ];
    for (const code of retryableCodes) {
      const error = createPipelineError(code);
      assert.equal(error.retryable, true, `${code} should be retryable`);
      assert.equal(error.recoveryAction, 'retry', `${code} should have recovery action 'retry'`);
    }
  });

  it('non-retryable errors have specific recovery actions', () => {
    const ghNotConnected = createPipelineError(PipelineErrorCode.GITHUB_NOT_CONNECTED);
    assert.equal(ghNotConnected.retryable, false);
    assert.equal(ghNotConnected.recoveryAction, 'reconnect_github');

    const emptyIdea = createPipelineError(PipelineErrorCode.SCRIBE_EMPTY_IDEA);
    assert.equal(emptyIdea.retryable, false);
    assert.equal(emptyIdea.recoveryAction, undefined);

    const cancelled = createPipelineError(PipelineErrorCode.PIPELINE_CANCELLED);
    assert.equal(cancelled.retryable, false);
    assert.equal(cancelled.recoveryAction, undefined);

    const aiKeyMissing = createPipelineError(PipelineErrorCode.AI_KEY_MISSING);
    assert.equal(aiKeyMissing.retryable, false);
    assert.equal(aiKeyMissing.recoveryAction, 'configure_ai_key');
  });
});

// ═══════════════════════════════════════════════════
// 8. EDGE CASE: Conversation overflow guard
// ═══════════════════════════════════════════════════

describe('Pipeline edge cases — Conversation overflow', () => {
  it('sendMessage fails gracefully when conversation exceeds 20 messages', async () => {
    const scribe = createMockScribe({
      analyzIdea: async () => ({ type: 'clarification', data: mockClarification }),
    });
    const store = new InMemoryStore();
    const { orchestrator } = createOrchestrator({ store, scribe });

    const started = await orchestrator.startPipeline('user-1', { idea: 'Edge conversation overflow' });
    await waitForStage(store, started.id, ['scribe_clarifying']);

    // Stuff 20 messages into the conversation to trigger the guard
    const bulkConversation = Array.from({ length: 20 }, (_, i) => ({
      type: 'user_answer' as const,
      content: `Message ${i}`,
    }));
    await store.forceStage(started.id, 'scribe_clarifying', {
      scribeConversation: bulkConversation,
    } as Partial<PipelineState>);

    const result = await orchestrator.sendMessage(started.id, 'one more message');
    assert.equal(result.stage, 'failed');
    assert.ok(result.error);
  });
});
