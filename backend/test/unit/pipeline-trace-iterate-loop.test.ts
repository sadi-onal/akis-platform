import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// PR-F (mimari refactor 2026-05-19): Trace iterate-loop testleri.
// Trace başarılı dönse bile uncovered AC veya test failure varsa
// orchestrator Proto'yu otomatik re-iterate eder. Max retry sayısı
// TRACE_MAX_ITERATE_RETRIES env var ile parametrik (default 3).
//
// AUTO_PUSH_AFTER_PROTO=true: preview-confirm gate'i atla, böylece
// Proto → Trace doğrudan zincirleme çalışır ve iterate-loop'u
// gözlemleyebiliriz. Production'da preview gate ON; ama iterate
// davranışı orthogonal — preview gate iterate-loop'un sonunda
// devreye girer (max retry sonrası push gate aşaması).
process.env.AUTO_PUSH_AFTER_PROTO = 'true';

import {
  PipelineOrchestrator,
  type PipelineStore,
  type PipelineStateUpdate,
} from '../../src/pipeline/core/orchestrator/PipelineOrchestrator.js';
import { __clearEnvCacheForTests } from '../../src/config/env.js';

__clearEnvCacheForTests();

import type {
  PipelineState,
  PipelineStage,
  ScribeOutput,
  StructuredSpec,
  ProtoOutput,
  TraceOutput,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';
import type {
  ScribeAgent,
  ScribeState,
  ScribeResult,
} from '../../src/pipeline/agents/scribe/ScribeAgent.js';
import type { ProtoAgent, ProtoResult } from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type { TraceAgent, TraceResult } from '../../src/pipeline/agents/trace/TraceAgent.js';

// ─── Fixtures ────────────────────────────────────

const validSpec: StructuredSpec = {
  title: 'Reminder App',
  problemStatement: 'Hatırlatıcı uygulaması.',
  userStories: [{ persona: 'Kullanıcı', action: 'Hatırlatıcı ekle', benefit: 'Unutma' }],
  acceptanceCriteria: [
    { id: 'ac-1', given: 'Login', when: 'Add reminder', then: 'Saved' },
    { id: 'ac-2', given: 'Login', when: 'Delete reminder', then: 'Removed' },
    { id: 'ac-3', given: 'Login', when: 'Edit reminder', then: 'Updated' },
  ],
  technicalConstraints: { stack: 'React + Vite' },
  outOfScope: [],
};

const mockScribeOutput: ScribeOutput = {
  spec: validSpec,
  rawMarkdown: '# Reminder\n',
  confidence: 0.9,
  clarificationsAsked: 0,
};

const mockProtoOutput: ProtoOutput = {
  ok: true,
  branch: 'proto/scaffold-1',
  repo: 'testuser/reminder-app',
  repoUrl: 'https://github.com/testuser/reminder-app',
  files: [
    { filePath: 'src/App.tsx', content: 'export default function App() {}', linesOfCode: 1 },
  ],
  setupCommands: ['npm install'],
  metadata: { filesCreated: 1, totalLinesOfCode: 1, stackUsed: 'React + Vite', committed: true },
};

function makeUncoveredTrace(): TraceOutput {
  return {
    ok: true,
    testFiles: [
      { filePath: 'tests/e2e/reminder.spec.ts', content: 'test()', testCount: 1 },
    ],
    coverageMatrix: { 'ac-1': ['tests/e2e/reminder.spec.ts'] },
    testSummary: {
      totalTests: 1,
      coveragePercentage: 33,
      coveredCriteria: ['ac-1'],
      uncoveredCriteria: ['ac-2', 'ac-3'],
    },
    branch: 'trace/tests-1',
  };
}

function makeFullyCoveredTrace(): TraceOutput {
  return {
    ok: true,
    testFiles: [
      { filePath: 'tests/e2e/reminder.spec.ts', content: 'test()', testCount: 3 },
    ],
    coverageMatrix: {
      'ac-1': ['tests/e2e/reminder.spec.ts'],
      'ac-2': ['tests/e2e/reminder.spec.ts'],
      'ac-3': ['tests/e2e/reminder.spec.ts'],
    },
    testSummary: {
      totalTests: 3,
      coveragePercentage: 100,
      coveredCriteria: ['ac-1', 'ac-2', 'ac-3'],
      uncoveredCriteria: [],
    },
    branch: 'trace/tests-1',
  };
}

// ─── In-memory store ─────────────────────────────

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
    } as PipelineState;
    this.pipelines.set(id, pipeline);
    return { ...pipeline };
  }

  async getById(id: string): Promise<PipelineState | null> {
    const p = this.pipelines.get(id);
    return p ? { ...p } : null;
  }

  async listByUser(userId: string): Promise<PipelineState[]> {
    return [...this.pipelines.values()]
      .filter((p) => p.userId === userId)
      .map((p) => ({ ...p }));
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

// ─── Mocks ───────────────────────────────────────

function createMockScribe(): ScribeAgent {
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
    analyzIdea: async (): Promise<ScribeResult> => ({
      type: 'spec' as const,
      data: mockScribeOutput,
    }),
    processUserAnswer(state: ScribeState, answer: string) {
      state.conversation.push({ type: 'user_answer', content: answer });
    },
    continueAfterAnswer: async (): Promise<ScribeResult> => ({
      type: 'spec' as const,
      data: mockScribeOutput,
    }),
    regenerateSpec: async (): Promise<ScribeResult> => ({
      type: 'spec' as const,
      data: mockScribeOutput,
    }),
    generateSpec: async (): Promise<ScribeResult> => ({
      type: 'spec' as const,
      data: mockScribeOutput,
    }),
  } as unknown as ScribeAgent;
}

function createMockProto(callCounter: { value: number }): ProtoAgent {
  return {
    execute: async (): Promise<ProtoResult> => {
      callCounter.value += 1;
      return { type: 'output' as const, data: mockProtoOutput };
    },
  } as unknown as ProtoAgent;
}

/**
 * Scripted Trace mock — emits a sequence of TraceOutput per execute call.
 * Lets us simulate "first run uncovered → second run covered" scenarios.
 * The last entry stays in effect after the scripted sequence is exhausted.
 */
function createScriptedTrace(
  outputs: TraceOutput[],
  callCounter: { value: number },
): TraceAgent {
  return {
    execute: async (): Promise<TraceResult> => {
      const idx = Math.min(callCounter.value, outputs.length - 1);
      callCounter.value += 1;
      const out = outputs[idx];
      if (!out) throw new Error('Scripted trace ran out of outputs');
      return { type: 'output' as const, data: out };
    },
  } as unknown as TraceAgent;
}

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

interface FixtureOptions {
  traceOutputs: TraceOutput[];
  traceEnabled?: boolean;
}

function createFixture(opts: FixtureOptions) {
  const protoCounter = { value: 0 };
  const traceCounter = { value: 0 };
  const store = new InMemoryStore();
  const orchestrator = new PipelineOrchestrator(
    store,
    createMockScribe(),
    createMockProto(protoCounter),
    createScriptedTrace(opts.traceOutputs, traceCounter),
    async () => 'testuser',
    async () => 'ghp_mock_token_for_tests',
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
  );
  // Critic agent intentionally NOT wired — these tests focus on Trace
  // iterate-loop only; Critic guardrail behavior is covered separately.
  return { store, orchestrator, protoCounter, traceCounter };
}

// ─── Tests ───────────────────────────────────────

describe('PR-F — Trace iterate-loop', () => {
  it('uncovered AC → triggers Proto re-iterate (retry counter increments)', async () => {
    process.env.TRACE_MAX_ITERATE_RETRIES = '3';
    const { orchestrator, store, protoCounter } = createFixture({
      // First trace run leaves 2/3 ACs uncovered → iterate; second run is
      // fully covered → loop terminates at completed.
      traceOutputs: [makeUncoveredTrace(), makeFullyCoveredTrace()],
    });
    const started = await orchestrator.startPipeline(
      'user-1',
      { idea: 'Reminder app' },
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'reminder-app', 'private');
    // After re-iterate the pipeline lands on completed (auto-push) with
    // BOTH traceOutput AND the retry counter visible.
    const finalState = await waitForStage(store, started.id, ['completed']);
    assert.equal(finalState.stage, 'completed');

    const intermediate = (finalState.intermediateState ?? {}) as Record<string, unknown>;
    assert.equal(
      intermediate.traceIterateRetryCount,
      1,
      'retry counter should have incremented once',
    );
    assert.ok(
      typeof intermediate.traceIterateLastFeedback === 'string' &&
        (intermediate.traceIterateLastFeedback as string).includes('ac-2'),
      'feedback contains uncovered AC ids',
    );
    // Proto ran twice — once for the original spec approval, once for the
    // automatic re-iterate.
    assert.equal(protoCounter.value, 2, 'Proto re-ran exactly once');
  });

  it('max retry reached → pipeline transitions to completed (handoff to user)', async () => {
    process.env.TRACE_MAX_ITERATE_RETRIES = '2';
    // Every Trace call leaves AC uncovered → iterate loop runs until max.
    const { orchestrator, store, protoCounter } = createFixture({
      traceOutputs: [makeUncoveredTrace(), makeUncoveredTrace(), makeUncoveredTrace()],
    });
    const started = await orchestrator.startPipeline(
      'user-1',
      { idea: 'Reminder app' },
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'reminder-app', 'private');
    const final = await waitForStage(store, started.id, ['completed']);

    const intermediate = (final.intermediateState ?? {}) as Record<string, unknown>;
    // Retry counter must NOT exceed maxRetries.
    assert.equal(
      intermediate.traceIterateRetryCount,
      2,
      'retry counter stops at TRACE_MAX_ITERATE_RETRIES',
    );
    // Proto runs = initial + max retries (1 + 2 = 3).
    assert.equal(protoCounter.value, 3, 'Proto runs initial + max retries');
  });

  it('trace success on first run → no iterate (counter never set)', async () => {
    process.env.TRACE_MAX_ITERATE_RETRIES = '3';
    const { orchestrator, store, protoCounter } = createFixture({
      traceOutputs: [makeFullyCoveredTrace()],
    });
    const started = await orchestrator.startPipeline(
      'user-1',
      { idea: 'Reminder app' },
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'reminder-app', 'private');
    const final = await waitForStage(store, started.id, ['completed']);

    const intermediate = (final.intermediateState ?? {}) as Record<string, unknown>;
    assert.equal(
      intermediate.traceIterateRetryCount,
      undefined,
      'retry counter never set when no iterate needed',
    );
    assert.equal(protoCounter.value, 1, 'Proto ran exactly once');
  });

  it('traceEnabled=false → iterate loop disabled even with uncovered AC', async () => {
    process.env.TRACE_MAX_ITERATE_RETRIES = '3';
    const { orchestrator, store, protoCounter } = createFixture({
      traceOutputs: [makeUncoveredTrace()],
    });
    const started = await orchestrator.startPipeline(
      'user-1',
      { idea: 'Reminder app' },
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    await waitForStage(store, started.id, ['awaiting_approval']);
    // Disable Trace BEFORE Proto runs.
    await orchestrator.toggleTrace(started.id, false);
    await orchestrator.approveSpec(started.id, 'reminder-app', 'private');
    // With Trace disabled, the pipeline goes straight from Proto → completed.
    // No iterate-loop fires regardless of uncovered ACs.
    const final = await waitForStage(store, started.id, ['completed']);
    const intermediate = (final.intermediateState ?? {}) as Record<string, unknown>;
    assert.equal(intermediate.traceIterateRetryCount, undefined);
    assert.equal(protoCounter.value, 1);
  });

  it('TRACE_MAX_ITERATE_RETRIES=0 → iterate loop disabled', async () => {
    process.env.TRACE_MAX_ITERATE_RETRIES = '0';
    const { orchestrator, store, protoCounter } = createFixture({
      traceOutputs: [makeUncoveredTrace()],
    });
    const started = await orchestrator.startPipeline(
      'user-1',
      { idea: 'Reminder app' },
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'reminder-app', 'private');
    const final = await waitForStage(store, started.id, ['completed']);
    const intermediate = (final.intermediateState ?? {}) as Record<string, unknown>;
    assert.equal(
      intermediate.traceIterateRetryCount,
      undefined,
      'retry counter never increments when max=0',
    );
    assert.equal(protoCounter.value, 1);
  });

  it('feedback includes uncovered AC ids (regression check)', async () => {
    process.env.TRACE_MAX_ITERATE_RETRIES = '3';
    const { orchestrator, store } = createFixture({
      traceOutputs: [makeUncoveredTrace(), makeFullyCoveredTrace()],
    });
    const started = await orchestrator.startPipeline(
      'user-1',
      { idea: 'Reminder app' },
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'reminder-app', 'private');
    const final = await waitForStage(store, started.id, ['completed']);

    const intermediate = (final.intermediateState ?? {}) as Record<string, unknown>;
    const feedback = intermediate.traceIterateLastFeedback as string | undefined;
    assert.ok(feedback);
    assert.ok(feedback.includes('ac-2'), 'feedback mentions uncovered ac-2');
    assert.ok(feedback.includes('ac-3'), 'feedback mentions uncovered ac-3');
    // The covered AC is not mentioned as missing.
    assert.ok(
      !feedback.includes('- ac-1'),
      'feedback does NOT list the covered AC',
    );
  });
});

// PR-F2 (2026-05-19): Trace iterate-loop with preview gate ON.
// Trace now runs in dryRun BEFORE awaiting_push_confirm. The iterate-loop
// must still trigger on uncovered AC pre-gate, and after retries terminate,
// the pipeline lands on `awaiting_push_confirm` (NOT `completed`) so the
// user reviews the scaffold + coverage matrix.
describe('PR-F2 — Trace dryRun iterate-loop with preview gate', () => {
  it('uncovered AC pre-gate → iterate-loop → terminates at awaiting_push_confirm', async () => {
    // Flip preview gate ON for this scenario; restore afterwards.
    const prevPushFlag = process.env.AUTO_PUSH_AFTER_PROTO;
    process.env.AUTO_PUSH_AFTER_PROTO = 'false';
    process.env.TRACE_MAX_ITERATE_RETRIES = '3';
    try {
      const { orchestrator, store, protoCounter, traceCounter } = createFixture({
        // First trace dryRun: uncovered → iterate. Second: fully covered → stop.
        traceOutputs: [makeUncoveredTrace(), makeFullyCoveredTrace()],
      });
      const started = await orchestrator.startPipeline(
        'user-1',
        { idea: 'Reminder app' },
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
      await waitForStage(store, started.id, ['awaiting_approval']);
      await orchestrator.approveSpec(started.id, 'reminder-app', 'private');
      // Expect to land at the push gate (NOT completed) once iterate-loop
      // terminates with full coverage.
      const gated = await waitForStage(store, started.id, ['awaiting_push_confirm']);
      assert.equal(gated.stage, 'awaiting_push_confirm');

      const intermediate = (gated.intermediateState ?? {}) as Record<string, unknown>;
      assert.equal(
        intermediate.traceIterateRetryCount,
        1,
        'retry counter incremented exactly once',
      );
      assert.equal(protoCounter.value, 2, 'Proto re-ran once (initial + iterate)');
      assert.equal(traceCounter.value, 2, 'Trace ran twice (initial dryRun + iterate dryRun)');
      assert.ok(gated.traceOutput, 'traceOutput from final dryRun pass visible at push gate');
      assert.equal(gated.traceOutput?.testSummary?.uncoveredCriteria?.length, 0);
    } finally {
      if (prevPushFlag === undefined) {
        delete process.env.AUTO_PUSH_AFTER_PROTO;
      } else {
        process.env.AUTO_PUSH_AFTER_PROTO = prevPushFlag;
      }
    }
  });

  it('iterate retry exhausted pre-gate → still lands on awaiting_push_confirm', async () => {
    const prevPushFlag = process.env.AUTO_PUSH_AFTER_PROTO;
    process.env.AUTO_PUSH_AFTER_PROTO = 'false';
    process.env.TRACE_MAX_ITERATE_RETRIES = '2';
    try {
      const { orchestrator, store, protoCounter } = createFixture({
        // Always uncovered → iterate-loop hits max retry then hands off to push gate.
        traceOutputs: [makeUncoveredTrace(), makeUncoveredTrace(), makeUncoveredTrace()],
      });
      const started = await orchestrator.startPipeline(
        'user-1',
        { idea: 'Reminder app' },
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
      await waitForStage(store, started.id, ['awaiting_approval']);
      await orchestrator.approveSpec(started.id, 'reminder-app', 'private');
      const gated = await waitForStage(store, started.id, ['awaiting_push_confirm']);
      assert.equal(gated.stage, 'awaiting_push_confirm');

      const intermediate = (gated.intermediateState ?? {}) as Record<string, unknown>;
      assert.equal(
        intermediate.traceIterateRetryCount,
        2,
        'retry counter stops at TRACE_MAX_ITERATE_RETRIES',
      );
      assert.equal(protoCounter.value, 3, 'Proto runs initial + max retries');
      assert.ok(gated.traceOutput, 'final (still-uncovered) traceOutput surfaces at gate');
    } finally {
      if (prevPushFlag === undefined) {
        delete process.env.AUTO_PUSH_AFTER_PROTO;
      } else {
        process.env.AUTO_PUSH_AFTER_PROTO = prevPushFlag;
      }
    }
  });
});
