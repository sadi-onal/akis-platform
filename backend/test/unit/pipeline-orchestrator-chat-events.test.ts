/**
 * Orchestrator integration tests for chat-event-log (Task 2).
 *
 * Asserts that `proto_started` and `proto_completed` events are persisted
 * to `scribeConversation` each time the orchestrator runs Proto:
 *   - After initial spec approval (iteration === 1)
 *   - After a user-feedback iterate (iteration counter increments to 2)
 */

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';
process.env.AUTH_JWT_SECRET ??= 'test-jwt-secret-at-least-32-chars-long-for-zod';
// DOGFOOD_MODE bypasses real GitHub access inside validateGitHubAccess
process.env.DOGFOOD_MODE = 'true';
// Disable preview gate so Proto goes straight to trace_testing without needing real Trace
process.env.AUTO_PUSH_AFTER_PROTO = 'false';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  PipelineOrchestrator,
  type PipelineStore,
  type PipelineStateUpdate,
} from '../../src/pipeline/core/orchestrator/PipelineOrchestrator.js';
import type {
  PipelineState,
  PipelineStage,
  StructuredSpec,
  ScribeOutput,
  ProtoOutput,
  TraceOutput,
  ScribeMessageType,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';
import type { ProtoAgent } from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type { TraceAgent } from '../../src/pipeline/agents/trace/TraceAgent.js';
import type { ScribeAgent } from '../../src/pipeline/agents/scribe/ScribeAgent.js';

// ─── Fixtures ──────────────────────────────────────────────────────

const VALID_SPEC: StructuredSpec = {
  title: 'Sayaç Uygulaması',
  problemStatement: 'Bir sayaç lazım.',
  userStories: [{ persona: 'Kullanıcı', action: 'Butona bas', benefit: 'Sayı artsın' }],
  acceptanceCriteria: [
    { id: 'ac-1', given: 'Sayfa açık', when: 'Butona basıyorum', then: 'Sayı artar' },
  ],
  technicalConstraints: { stack: 'React + Vite' },
  outOfScope: [],
};

const MOCK_SCRIBE_OUTPUT: ScribeOutput = {
  spec: VALID_SPEC,
  rawMarkdown: '# Sayaç',
  confidence: 0.9,
  clarificationsAsked: 0,
};

const MOCK_PROTO_OUT: ProtoOutput = {
  ok: true,
  branch: 'proto/sayac-uygulamasi',
  repo: 'testuser/sayac-uygulamasi',
  repoUrl: 'https://github.com/testuser/sayac-uygulamasi',
  files: [
    {
      filePath: 'src/App.tsx',
      content: 'export default function App() { return <div>0</div>; }',
      linesOfCode: 1,
    },
    {
      filePath: 'src/Counter.tsx',
      content: 'export const Counter = () => <button>+</button>;',
      linesOfCode: 1,
    },
    { filePath: 'package.json', content: '{}', linesOfCode: 1 },
    { filePath: 'vite.config.ts', content: 'export default {};', linesOfCode: 1 },
    { filePath: 'index.html', content: '<html></html>', linesOfCode: 1 },
  ],
  setupCommands: [],
  summary: 'Sayaç hazır.',
  metadata: {
    filesCreated: 5,
    totalLinesOfCode: 150,
    stackUsed: 'React + Vite',
    committed: false,
  },
};

const MOCK_TRACE_OUT: TraceOutput = {
  ok: true,
  testFiles: [{ filePath: 'tests/counter.spec.ts', content: 'test()', testCount: 1 }],
  coverageMatrix: { 'ac-1': ['tests/counter.spec.ts'] },
  testSummary: {
    totalTests: 1,
    coveragePercentage: 100,
    coveredCriteria: ['ac-1'],
    uncoveredCriteria: [],
  },
  branch: 'trace/sayac',
};

// ─── In-memory store ────────────────────────────────────────────────

class InMemoryStore implements PipelineStore {
  private pipelines = new Map<string, PipelineState>();

  seed(pipeline: PipelineState): void {
    this.pipelines.set(pipeline.id, { ...pipeline });
  }

  async create(userId: string): Promise<PipelineState> {
    const id = crypto.randomUUID();
    const p: PipelineState = {
      id,
      userId,
      stage: 'scribe_generating',
      scribeConversation: [],
      metrics: { startedAt: new Date(), clarificationRounds: 0, retryCount: 0 },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.pipelines.set(id, p);
    return { ...p };
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
    const updated = {
      ...existing,
      ...data,
      metrics: data.metrics ? { ...existing.metrics, ...data.metrics } : existing.metrics,
      stageVersion:
        (existing.stageVersion ?? 0) + (data.stage && data.stage !== existing.stage ? 1 : 0),
      updatedAt: new Date(),
    } as PipelineState;
    if (data.error === null) updated.error = undefined;
    this.pipelines.set(id, updated);
    return { ...updated };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

async function waitForStage(
  store: PipelineStore,
  id: string,
  stages: PipelineStage[],
  timeoutMs = 5_000
): Promise<PipelineState> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = await store.getById(id);
    if (p && stages.includes(p.stage)) return p;
    await new Promise((r) => setTimeout(r, 10));
  }
  const p = await store.getById(id);
  throw new Error(`Timeout: expected [${stages.join('|')}], got ${p?.stage}`);
}

function createMockProto(out: ProtoOutput = MOCK_PROTO_OUT): ProtoAgent {
  return {
    execute: async () => ({ type: 'output' as const, data: out }),
  } as unknown as ProtoAgent;
}

function createMockTrace(): TraceAgent {
  return {
    execute: async () => ({ type: 'output' as const, data: MOCK_TRACE_OUT }),
  } as unknown as TraceAgent;
}

function createMockScribe(): ScribeAgent {
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
    analyzIdea: async () => ({ type: 'spec' as const, data: MOCK_SCRIBE_OUTPUT }),
    continueAfterAnswer: async () => ({ type: 'spec' as const, data: MOCK_SCRIBE_OUTPUT }),
    processUserAnswer: () => {
      /* noop */
    },
    regenerateSpec: async () => ({ type: 'spec' as const, data: MOCK_SCRIBE_OUTPUT }),
    generateSpec: async () => ({ type: 'spec' as const, data: MOCK_SCRIBE_OUTPUT }),
  } as unknown as ScribeAgent;
}

function makeGitHubService() {
  return {
    createRepository: async () => ({ url: 'https://github.com/testuser/sayac' }),
    createBranch: async () => {
      /* noop */
    },
    commitFile: async () => {
      /* noop */
    },
    pushFiles: async () => {
      /* noop */
    },
    createPR: async () => ({ url: 'https://github.com/testuser/sayac/pull/1' }),
    listFiles: async () => [],
    getFileContent: async () => '',
  };
}

function createMockTraceError(code: string, message: string): TraceAgent {
  return {
    execute: async () => ({
      type: 'error' as const,
      error: { code, message },
    }),
  } as unknown as TraceAgent;
}

function createOrchestrator(
  proto: ProtoAgent = createMockProto(),
  trace: TraceAgent = createMockTrace()
) {
  const store = new InMemoryStore();
  const orchestrator = new PipelineOrchestrator(
    store,
    createMockScribe(),
    proto,
    trace,
    async () => 'testuser',
    async () => 'ghp_mock_token',
    () => makeGitHubService()
  );
  return { orchestrator, store };
}

// ─── Tests ──────────────────────────────────────────────────────────

// ─── Seed helper ────────────────────────────────────────────────────

function makeApprovalSeed(id: string, userId: string): PipelineState {
  return {
    id,
    userId,
    stage: 'awaiting_approval',
    // traceEnabled must be explicitly true — `!undefined` is truthy and the
    // orchestrator treats it as "Trace disabled", skipping runTrace entirely.
    traceEnabled: true,
    scribeConversation: [{ type: 'spec_approved', content: VALID_SPEC }] as ScribeMessageType[],
    scribeOutput: MOCK_SCRIBE_OUTPUT,
    approvedSpec: VALID_SPEC,
    metrics: { startedAt: new Date(), clarificationRounds: 0, retryCount: 0 },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('Orchestrator — chat event log: proto events (Task 2)', () => {
  it('appends proto_started + proto_completed when Proto runs after spec approval', async () => {
    const { orchestrator, store } = createOrchestrator();

    // Seed a pipeline at awaiting_approval with a prior spec_approved message
    const seed: PipelineState = {
      id: crypto.randomUUID(),
      userId: 'user-test-1',
      stage: 'awaiting_approval',
      scribeConversation: [{ type: 'spec_approved', content: VALID_SPEC }] as ScribeMessageType[],
      scribeOutput: MOCK_SCRIBE_OUTPUT,
      approvedSpec: VALID_SPEC,
      metrics: { startedAt: new Date(), clarificationRounds: 0, retryCount: 0 },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    (store as InMemoryStore).seed(seed);

    // Trigger approveSpec — runs Proto in background
    await orchestrator.approveSpec(seed.id, 'sayac-uygulamasi', 'private');

    // Wait for pipeline to advance past proto_building
    const final = await waitForStage(
      store,
      seed.id,
      ['trace_testing', 'awaiting_push_confirm', 'completed', 'completed_partial'],
      5_000
    );

    const conv = final.scribeConversation;

    const startedEvents = conv.filter((m) => m.type === 'proto_started');
    const completedEvents = conv.filter((m) => m.type === 'proto_completed');

    assert.strictEqual(startedEvents.length, 1, 'should have exactly 1 proto_started event');
    assert.strictEqual(completedEvents.length, 1, 'should have exactly 1 proto_completed event');

    const started = startedEvents[0] as Extract<ScribeMessageType, { type: 'proto_started' }>;
    const completed = completedEvents[0] as Extract<ScribeMessageType, { type: 'proto_completed' }>;

    assert.strictEqual(started.content.iteration, 1, 'proto_started iteration should be 1');
    assert.strictEqual(completed.content.iteration, 1, 'proto_completed iteration should be 1');
    assert.strictEqual(completed.content.filesCreated, 5, 'filesCreated should match ProtoOutput');
    assert.strictEqual(completed.content.totalLines, 150, 'totalLines should match ProtoOutput');
    assert.strictEqual(
      completed.content.summary,
      'Sayaç hazır.',
      'summary should match ProtoOutput'
    );
    assert.ok(typeof started.timestamp === 'string', 'proto_started should have a timestamp');
    assert.ok(typeof completed.timestamp === 'string', 'proto_completed should have a timestamp');
  });

  it('proto_completed iteration counter increments across runs', async () => {
    const { orchestrator, store } = createOrchestrator();

    // Seed a pipeline that already has 1 prior proto_completed (from a previous run)
    const seed: PipelineState = {
      id: crypto.randomUUID(),
      userId: 'user-test-2',
      stage: 'awaiting_push_confirm',
      scribeConversation: [
        { type: 'spec_approved', content: VALID_SPEC },
        { type: 'proto_started', content: { iteration: 1 }, timestamp: new Date().toISOString() },
        {
          type: 'proto_completed',
          content: { iteration: 1, summary: 'İlk üretim.', filesCreated: 3, totalLines: 90 },
          timestamp: new Date().toISOString(),
        },
        { type: 'user_feedback', content: 'Lütfen TypeScript kullan.' },
      ] as ScribeMessageType[],
      scribeOutput: MOCK_SCRIBE_OUTPUT,
      approvedSpec: VALID_SPEC,
      protoOutput: MOCK_PROTO_OUT,
      protoConfig: { repoName: 'sayac-uygulamasi', repoVisibility: 'private' },
      metrics: { startedAt: new Date(), clarificationRounds: 0, retryCount: 0 },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    (store as InMemoryStore).seed(seed);

    // Trigger iterate-with-feedback — calls runProtoAndTrace internally
    await orchestrator.iterateProtoFromFeedback(seed.id, 'Lütfen TypeScript kullan.');

    // Wait for pipeline to advance past proto_building
    const final = await waitForStage(
      store,
      seed.id,
      ['trace_testing', 'awaiting_push_confirm', 'completed', 'completed_partial'],
      5_000
    );

    const conv = final.scribeConversation;

    const completedEvents = conv.filter((m) => m.type === 'proto_completed');
    assert.strictEqual(
      completedEvents.length,
      2,
      'should have 2 proto_completed events total (one old + one new)'
    );

    const newCompleted = completedEvents[1] as Extract<
      ScribeMessageType,
      { type: 'proto_completed' }
    >;
    assert.strictEqual(
      newCompleted.content.iteration,
      2,
      'second proto_completed iteration should be 2'
    );

    const startedEvents = conv.filter((m) => m.type === 'proto_started');
    assert.strictEqual(startedEvents.length, 2, 'should have 2 proto_started events total');
    const newStarted = startedEvents[1] as Extract<ScribeMessageType, { type: 'proto_started' }>;
    assert.strictEqual(
      newStarted.content.iteration,
      2,
      'second proto_started iteration should be 2'
    );
  });
});

describe('Orchestrator — chat event log: trace events (Task 3)', () => {
  it('appends trace_started + trace_completed when Trace succeeds', async () => {
    const { orchestrator, store } = createOrchestrator();

    const seed = makeApprovalSeed(crypto.randomUUID(), 'user-trace-1');
    (store as InMemoryStore).seed(seed);

    // approveSpec → Proto dryRun → Trace dryRun → awaiting_push_confirm
    await orchestrator.approveSpec(seed.id, 'sayac-uygulamasi', 'private');

    await waitForStage(
      store,
      seed.id,
      ['awaiting_push_confirm', 'completed', 'completed_partial'],
      5_000
    );

    // appendTraceCompleted fires AFTER store.update({traceOutput, stage}), so
    // poll until trace_completed lands (max 2 s).
    let finalState = await store.getById(seed.id);
    const deadline = Date.now() + 2_000;
    while (
      Date.now() < deadline &&
      !finalState?.scribeConversation.some((m) => m.type === 'trace_completed')
    ) {
      await new Promise((r) => setTimeout(r, 10));
      finalState = await store.getById(seed.id);
    }
    const final = finalState!;

    const conv = final.scribeConversation;

    const traceStartedEvents = conv.filter((m) => m.type === 'trace_started');
    const traceCompletedEvents = conv.filter((m) => m.type === 'trace_completed');

    assert.strictEqual(traceStartedEvents.length, 1, 'should have exactly 1 trace_started event');
    assert.strictEqual(
      traceCompletedEvents.length,
      1,
      'should have exactly 1 trace_completed event'
    );

    const started = traceStartedEvents[0] as Extract<ScribeMessageType, { type: 'trace_started' }>;
    const completed = traceCompletedEvents[0] as Extract<
      ScribeMessageType,
      { type: 'trace_completed' }
    >;

    assert.strictEqual(started.content.iteration, 1, 'trace_started iteration should be 1');
    assert.strictEqual(completed.content.iteration, 1, 'trace_completed iteration should be 1');
    assert.strictEqual(
      completed.content.totalTests,
      MOCK_TRACE_OUT.testSummary.totalTests,
      'totalTests should match TraceOutput'
    );
    assert.strictEqual(
      completed.content.coverage,
      MOCK_TRACE_OUT.testSummary.coveragePercentage,
      'coverage should match TraceOutput'
    );
    assert.strictEqual(completed.content.passed, true, 'passed should be true');
    assert.ok(typeof started.timestamp === 'string', 'trace_started should have a timestamp');
    assert.ok(typeof completed.timestamp === 'string', 'trace_completed should have a timestamp');

    // Data-consistency: traceOutput persisted before trace_completed (ordering guarantee)
    assert.ok(
      final.traceOutput !== undefined,
      'traceOutput must be persisted when trace_completed is in conversation'
    );
    const traceStartedIdx = conv.findIndex((m) => m.type === 'trace_started');
    const traceCompletedIdx = conv.findIndex((m) => m.type === 'trace_completed');
    assert.ok(traceStartedIdx < traceCompletedIdx, 'trace_started must precede trace_completed');
  });

  it('appends trace_failed when Trace returns an error result', async () => {
    const failingTrace = createMockTraceError('AI_PROVIDER_ERROR', 'rate limit exceeded');
    const { orchestrator, store } = createOrchestrator(createMockProto(), failingTrace);

    const seed = makeApprovalSeed(crypto.randomUUID(), 'user-trace-2');
    (store as InMemoryStore).seed(seed);

    await orchestrator.approveSpec(seed.id, 'sayac-uygulamasi', 'private');

    // On Trace failure with dryRun+awaiting_push_confirm, pipeline falls back to
    // awaiting_push_confirm (dryRun soft-fail path). Otherwise completed_partial.
    const final = await waitForStage(
      store,
      seed.id,
      ['awaiting_push_confirm', 'completed_partial', 'failed'],
      5_000
    );

    const conv = final.scribeConversation;

    const traceFailedEvents = conv.filter((m) => m.type === 'trace_failed');
    assert.strictEqual(traceFailedEvents.length, 1, 'should have exactly 1 trace_failed event');

    const failed = traceFailedEvents[0] as Extract<ScribeMessageType, { type: 'trace_failed' }>;
    assert.strictEqual(
      failed.content.errorCode,
      'AI_PROVIDER_ERROR',
      'errorCode should match the error returned by TraceAgent'
    );
    assert.ok(
      typeof failed.content.errorMessage === 'string' && failed.content.errorMessage.length > 0,
      'errorMessage should be a non-empty string'
    );
    assert.strictEqual(failed.content.recoveryAction, 'retry', 'recoveryAction should be retry');
    assert.ok(typeof failed.timestamp === 'string', 'trace_failed should have a timestamp');

    // There should also be a trace_started that preceded the failure
    const traceStartedEvents = conv.filter((m) => m.type === 'trace_started');
    assert.strictEqual(
      traceStartedEvents.length,
      1,
      'should have exactly 1 trace_started before the failure'
    );
    assert.strictEqual(
      (traceStartedEvents[0] as Extract<ScribeMessageType, { type: 'trace_started' }>).content
        .iteration,
      1,
      'trace_started iteration should be 1'
    );
  });
});
