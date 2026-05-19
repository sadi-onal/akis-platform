import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// PR-F3 (mimari karar 2026-05-19): Critic critical-finding iterate-loop testleri.
// Critic kod review'da severity=critical bulgu varsa orchestrator kullanıcıyı
// hard-block etmeden önce Proto'yu kritik bulgular feedback olarak verilerek
// otomatik re-iterate eder. Max retry sayısı CRITIC_CRITICAL_MAX_ITERATE_RETRIES
// env var ile parametrik (default 3). Pattern Trace iterate-loop ile birebir
// aynı.
//
// AUTO_PUSH_AFTER_PROTO=true: preview-confirm gate'i atla, böylece Proto →
// Critic → (iterate ya da Trace) doğrudan zincirleme çalışır. Production'da
// preview gate ON; ama iterate davranışı orthogonal — preview gate Critic
// iterate'in sonunda devreye girer.
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
import type {
  CriticAgent,
  CriticResult,
} from '../../src/pipeline/agents/critic/CriticAgent.js';
import type { CriticReviewOutput } from '../../src/pipeline/agents/critic/CriticTypes.js';

// ─── Fixtures ────────────────────────────────────

const validSpec: StructuredSpec = {
  title: 'Reminder App',
  problemStatement: 'Hatırlatıcı uygulaması.',
  userStories: [{ persona: 'Kullanıcı', action: 'Hatırlatıcı ekle', benefit: 'Unutma' }],
  acceptanceCriteria: [
    { id: 'ac-1', given: 'Login', when: 'Add reminder', then: 'Saved' },
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

const mockFullyCoveredTrace: TraceOutput = {
  ok: true,
  testFiles: [
    { filePath: 'tests/e2e/reminder.spec.ts', content: 'test()', testCount: 1 },
  ],
  coverageMatrix: { 'ac-1': ['tests/e2e/reminder.spec.ts'] },
  testSummary: {
    totalTests: 1,
    coveragePercentage: 100,
    coveredCriteria: ['ac-1'],
    uncoveredCriteria: [],
  },
  branch: 'trace/tests-1',
};

function makeCriticWithCritical(): CriticReviewOutput {
  return {
    approved: false,
    overallScore: 35,
    findings: [
      {
        severity: 'critical',
        category: 'spec_compliance',
        description: 'SQL injection açığı authentication katmanında',
        suggestion: 'Parametrized queries kullan, ORM güvenli API çağırılarına geç',
        location: 'src/auth/login.ts',
      },
      {
        severity: 'major',
        category: 'testability',
        description: 'Test edilemez tightly-coupled controller',
        suggestion: 'DI ile decouple et',
      },
    ],
    summary: 'Güvenlik açığı tespit edildi',
    reviewType: 'code_review',
    iteration: 1,
    hasCriticalFinding: true,
    maxSeverity: 'critical',
  };
}

function makeCriticAllClean(): CriticReviewOutput {
  return {
    approved: true,
    overallScore: 95,
    findings: [
      {
        severity: 'minor',
        category: 'testability',
        description: 'Daha fazla doc string',
        suggestion: 'JSDoc ekle',
      },
    ],
    summary: 'Tertemiz',
    reviewType: 'code_review',
    iteration: 1,
    hasCriticalFinding: false,
    maxSeverity: 'minor',
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

function createMockTrace(callCounter: { value: number }): TraceAgent {
  return {
    execute: async (): Promise<TraceResult> => {
      callCounter.value += 1;
      return { type: 'output' as const, data: mockFullyCoveredTrace };
    },
  } as unknown as TraceAgent;
}

/**
 * Scripted Critic mock — emits a sequence of CriticReviewOutput per code-review
 * call. Lets us simulate "first run critical → second run clean" scenarios.
 * The last entry stays in effect after the scripted sequence is exhausted.
 *
 * Spec review (Scribe-side) is stubbed as `approved: true` so it never blocks.
 */
function createScriptedCritic(
  codeOutputs: CriticReviewOutput[],
  callCounter: { value: number },
): CriticAgent {
  return {
    reviewSpec: async (): Promise<CriticResult> => ({
      type: 'review' as const,
      data: {
        approved: true,
        overallScore: 95,
        findings: [],
        summary: 'spec ok',
        reviewType: 'spec_review',
        iteration: 1,
        hasCriticalFinding: false,
        maxSeverity: 'info',
      },
    }),
    reviewCode: async (): Promise<CriticResult> => {
      const idx = Math.min(callCounter.value, codeOutputs.length - 1);
      callCounter.value += 1;
      const out = codeOutputs[idx];
      if (!out) throw new Error('Scripted critic ran out of outputs');
      return { type: 'review' as const, data: out };
    },
  } as unknown as CriticAgent;
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
  criticOutputs: CriticReviewOutput[];
}

function createFixture(opts: FixtureOptions) {
  const protoCounter = { value: 0 };
  const traceCounter = { value: 0 };
  const criticCounter = { value: 0 };
  const store = new InMemoryStore();
  const orchestrator = new PipelineOrchestrator(
    store,
    createMockScribe(),
    createMockProto(protoCounter),
    createMockTrace(traceCounter),
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
  orchestrator.setCriticAgent(createScriptedCritic(opts.criticOutputs, criticCounter));
  return { store, orchestrator, protoCounter, traceCounter, criticCounter };
}

// ─── Tests ───────────────────────────────────────

describe('PR-F3 — Critic critical-finding iterate-loop', () => {
  it('hasCriticalFinding=true, retry<max → triggers Proto re-iterate (counter increments)', async () => {
    process.env.CRITIC_CRITICAL_MAX_ITERATE_RETRIES = '3';
    const { orchestrator, store, protoCounter, criticCounter } = createFixture({
      // First critic pass: critical → iterate. Second: clean → flow proceeds.
      criticOutputs: [makeCriticWithCritical(), makeCriticAllClean()],
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
    const finalState = await waitForStage(store, started.id, ['completed']);
    assert.equal(finalState.stage, 'completed');

    const intermediate = (finalState.intermediateState ?? {}) as Record<string, unknown>;
    assert.equal(
      intermediate.criticIterateRetryCount,
      1,
      'criticIterateRetryCount should have incremented once',
    );
    assert.ok(
      typeof intermediate.criticIterateLastFeedback === 'string' &&
        (intermediate.criticIterateLastFeedback as string).includes(
          'Aşağıdaki kritik bulgular',
        ),
      'feedback contains the canonical Turkish prompt prefix',
    );
    // Proto ran twice — once on approveSpec, once on Critic re-iterate.
    assert.equal(protoCounter.value, 2, 'Proto re-ran exactly once');
    // Critic was called twice (initial + iterate); third pass would have been
    // unnecessary because second result was clean.
    assert.equal(criticCounter.value, 2, 'Critic reviewed code twice');
  });

  it('hasCriticalFinding=true, retry=max → falls back to awaiting_critic_resolution', async () => {
    process.env.CRITIC_CRITICAL_MAX_ITERATE_RETRIES = '2';
    // Every critic pass keeps flagging critical → iterate loop hits max, then
    // hands off to the hard-block fallback.
    const { orchestrator, store, protoCounter, criticCounter } = createFixture({
      criticOutputs: [
        makeCriticWithCritical(),
        makeCriticWithCritical(),
        makeCriticWithCritical(),
      ],
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
    const blocked = await waitForStage(store, started.id, ['awaiting_critic_resolution']);
    assert.equal(blocked.stage, 'awaiting_critic_resolution');

    const intermediate = (blocked.intermediateState ?? {}) as Record<string, unknown>;
    assert.equal(
      intermediate.criticIterateRetryCount,
      2,
      'criticIterateRetryCount stops at CRITIC_CRITICAL_MAX_ITERATE_RETRIES',
    );
    // criticBlock fingerprint persisted so UI can render the explanation.
    const criticBlock = intermediate.criticBlock as Record<string, unknown> | undefined;
    assert.ok(criticBlock, 'criticBlock metadata persisted on fallback');
    assert.equal(criticBlock?.manuallyOverridden, false);
    // Proto runs = initial + max retries (1 + 2 = 3).
    assert.equal(protoCounter.value, 3, 'Proto runs initial + max retries');
    // Critic reviewed code on every Proto run.
    assert.equal(criticCounter.value, 3, 'Critic reviewed code on every Proto run');
  });

  it('hasCriticalFinding=false → no iterate, flow continues straight to Trace/completion', async () => {
    process.env.CRITIC_CRITICAL_MAX_ITERATE_RETRIES = '3';
    const { orchestrator, store, protoCounter, criticCounter } = createFixture({
      criticOutputs: [makeCriticAllClean()],
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
    assert.equal(final.stage, 'completed');

    const intermediate = (final.intermediateState ?? {}) as Record<string, unknown>;
    assert.equal(
      intermediate.criticIterateRetryCount,
      undefined,
      'criticIterateRetryCount never set when no critical finding',
    );
    assert.equal(protoCounter.value, 1, 'Proto ran exactly once');
    assert.equal(criticCounter.value, 1, 'Critic reviewed code exactly once');
  });

  it('feedback prompt includes critical finding description + suggestion', async () => {
    process.env.CRITIC_CRITICAL_MAX_ITERATE_RETRIES = '3';
    const { orchestrator, store } = createFixture({
      criticOutputs: [makeCriticWithCritical(), makeCriticAllClean()],
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
    const feedback = intermediate.criticIterateLastFeedback as string | undefined;
    assert.ok(feedback, 'feedback persisted');
    assert.ok(
      feedback.includes('SQL injection açığı'),
      'feedback contains the critical finding description',
    );
    assert.ok(
      feedback.includes('Parametrized queries kullan'),
      'feedback contains the critical finding suggestion',
    );
    // Non-critical (major) finding is NOT pushed into the iterate feedback.
    assert.ok(
      !feedback.includes('DI ile decouple et'),
      'feedback does NOT mention non-critical findings',
    );
  });

  it('CRITIC_CRITICAL_MAX_ITERATE_RETRIES=0 → iterate loop disabled, immediate fallback', async () => {
    process.env.CRITIC_CRITICAL_MAX_ITERATE_RETRIES = '0';
    const { orchestrator, store, protoCounter, criticCounter } = createFixture({
      criticOutputs: [makeCriticWithCritical()],
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
    const blocked = await waitForStage(store, started.id, ['awaiting_critic_resolution']);
    const intermediate = (blocked.intermediateState ?? {}) as Record<string, unknown>;
    assert.equal(
      intermediate.criticIterateRetryCount,
      undefined,
      'criticIterateRetryCount never increments when max=0',
    );
    // criticBlock still persisted — same hard-block fingerprint as pre-PR-F3.
    assert.ok(intermediate.criticBlock, 'criticBlock metadata persisted');
    assert.equal(protoCounter.value, 1, 'Proto ran exactly once');
    assert.equal(criticCounter.value, 1, 'Critic reviewed code exactly once');
  });

  // Restore defaults after the test suite so other test files (running in the
  // same process) don't pick up our env mutations.
  it('cleanup: reset env var', () => {
    delete process.env.CRITIC_CRITICAL_MAX_ITERATE_RETRIES;
    assert.equal(process.env.CRITIC_CRITICAL_MAX_ITERATE_RETRIES, undefined);
  });
});
