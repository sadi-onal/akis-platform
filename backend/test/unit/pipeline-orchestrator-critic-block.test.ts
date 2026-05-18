import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// P8 — Critic hard-block tests assert the legacy auto-push flow because the
// preview-confirm gate (`awaiting_push_confirm`) is orthogonal to the
// hard-block decision; both behave identically once Critic approves. With
// AUTO_PUSH_AFTER_PROTO=true, the orchestrator transitions directly from
// proto_building → critic_reviewing_code → (approved? trace : critic-block).
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
import {
  CriticAgent,
  type CriticAIDeps,
} from '../../src/pipeline/agents/critic/CriticAgent.js';

// ─── Fixtures ────────────────────────────────────

const validSpec: StructuredSpec = {
  title: 'Todo App',
  problemStatement: 'Kullanıcı görevlerini takip eder.',
  userStories: [{ persona: 'Kullanıcı', action: 'Görev oluşturma', benefit: 'Takip' }],
  acceptanceCriteria: [
    { id: 'ac-1', given: 'Giriş yapmış', when: 'Görev ekle', then: 'Oluşur' },
  ],
  technicalConstraints: { stack: 'React + Vite' },
  outOfScope: [],
};

const mockScribeOutput: ScribeOutput = {
  spec: validSpec,
  rawMarkdown: '# Todo App\n...',
  confidence: 0.85,
  clarificationsAsked: 1,
};

const mockProtoOutput: ProtoOutput = {
  ok: true,
  branch: 'proto/scaffold-1',
  repo: 'testuser/todo-app',
  repoUrl: 'https://github.com/testuser/todo-app',
  files: [{ filePath: 'src/App.tsx', content: 'export default function App() {}', linesOfCode: 1 }],
  setupCommands: ['npm install'],
  metadata: { filesCreated: 1, totalLinesOfCode: 1, stackUsed: 'React + Vite', committed: true },
};

const mockTraceOutput: TraceOutput = {
  ok: true,
  testFiles: [{ filePath: 'tests/e2e/todo.spec.ts', content: 'test()', testCount: 1 }],
  coverageMatrix: { 'ac-1': ['tests/e2e/todo.spec.ts'] },
  testSummary: {
    totalTests: 1,
    coveragePercentage: 100,
    coveredCriteria: ['ac-1'],
    uncoveredCriteria: [],
  },
  branch: 'trace/tests-1',
};

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

function createMockProto(): ProtoAgent {
  return {
    execute: async (): Promise<ProtoResult> => ({
      type: 'output' as const,
      data: mockProtoOutput,
    }),
  } as unknown as ProtoAgent;
}

function createMockTrace(): TraceAgent {
  return {
    execute: async (): Promise<TraceResult> => ({
      type: 'output' as const,
      data: mockTraceOutput,
    }),
  } as unknown as TraceAgent;
}

function createFixedScoreCriticAI(score: number): CriticAIDeps {
  return {
    async generateText(): Promise<string> {
      return JSON.stringify({
        overallScore: score,
        findings: [
          {
            severity: score < 75 ? 'critical' : 'minor',
            category: 'completeness',
            description: 'mock finding',
            suggestion: 'mock suggestion',
          },
        ],
        summary: 'mock review',
        reviewType: 'code_review',
        iteration: 1,
      });
    },
  };
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

function createOrchestrator(opts?: { criticThreshold?: number }) {
  const store = new InMemoryStore();
  const orchestrator = new PipelineOrchestrator(
    store,
    createMockScribe(),
    createMockProto(),
    createMockTrace(),
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
  // The orchestrator's critic-code review only fires when an agent is wired.
  // Use a low score (40) for hard-block tests, high (90) for happy path.
  const score = opts?.criticThreshold === undefined ? 40 : opts.criticThreshold;
  const critic = new CriticAgent(createFixedScoreCriticAI(score));
  orchestrator.setCriticAgent(critic);
  return { store, orchestrator };
}

// ─── Tests ───────────────────────────────────────

describe('Orchestrator — P8 critic hard-block', () => {
  it('halts at awaiting_critic_resolution when score < threshold', async () => {
    const { orchestrator, store } = createOrchestrator({ criticThreshold: 40 });

    const started = await orchestrator.startPipeline(
      'user-1',
      { idea: 'React todo app with Google Auth' },
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-todo-app', 'private');

    const blocked = await waitForStage(store, started.id, ['awaiting_critic_resolution']);
    assert.equal(blocked.stage, 'awaiting_critic_resolution');
    assert.ok(blocked.protoOutput, 'protoOutput is preserved for the preview');
    assert.ok(!blocked.traceOutput, 'Trace must NOT have run');

    const criticBlock = blocked.intermediateState?.criticBlock as
      | { overallScore: number; findingsCount: number; manuallyOverridden: boolean }
      | undefined;
    assert.ok(criticBlock, 'criticBlock audit object exists');
    assert.equal(criticBlock.overallScore, 40);
    assert.equal(criticBlock.findingsCount, 1);
    assert.equal(criticBlock.manuallyOverridden, false);
  });

  it('criticOverride() advances to awaiting_push_confirm and stamps manuallyOverridden', async () => {
    // Override is only legal when AUTO_PUSH_AFTER_PROTO=false (the default
    // user-facing flow), because confirmPush is the downstream gate. Flip
    // it for this test only and restore at the end.
    const original = process.env.AUTO_PUSH_AFTER_PROTO;
    process.env.AUTO_PUSH_AFTER_PROTO = 'false';
    try {
      const { orchestrator, store } = createOrchestrator({ criticThreshold: 40 });
      const started = await orchestrator.startPipeline(
        'user-1',
        { idea: 'React todo app with Google Auth' },
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
      await waitForStage(store, started.id, ['awaiting_approval']);
      await orchestrator.approveSpec(started.id, 'my-todo-app', 'private');
      const blocked = await waitForStage(store, started.id, ['awaiting_critic_resolution']);
      assert.equal(blocked.stage, 'awaiting_critic_resolution');

      const overridden = await orchestrator.criticOverride(started.id);
      assert.equal(overridden.stage, 'awaiting_push_confirm');
      const block = overridden.intermediateState?.criticBlock as
        | { manuallyOverridden: boolean; overriddenAt: string }
        | undefined;
      assert.ok(block);
      assert.equal(block.manuallyOverridden, true);
      assert.ok(block.overriddenAt);
    } finally {
      process.env.AUTO_PUSH_AFTER_PROTO = original ?? 'true';
    }
  });

  it('criticOverride() is idempotent past the gate', async () => {
    const original = process.env.AUTO_PUSH_AFTER_PROTO;
    process.env.AUTO_PUSH_AFTER_PROTO = 'false';
    try {
      const { orchestrator, store } = createOrchestrator({ criticThreshold: 40 });
      const started = await orchestrator.startPipeline(
        'user-1',
        { idea: 'React todo app with Google Auth' },
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
      await waitForStage(store, started.id, ['awaiting_approval']);
      await orchestrator.approveSpec(started.id, 'my-todo-app', 'private');
      await waitForStage(store, started.id, ['awaiting_critic_resolution']);
      await orchestrator.criticOverride(started.id);

      // Second call: pipeline is already at awaiting_push_confirm — should
      // not throw, returns current state.
      const second = await orchestrator.criticOverride(started.id);
      assert.equal(second.stage, 'awaiting_push_confirm');
    } finally {
      process.env.AUTO_PUSH_AFTER_PROTO = original ?? 'true';
    }
  });

  it('high-score critic does NOT block (legacy completed flow still works)', async () => {
    const { orchestrator, store } = createOrchestrator({ criticThreshold: 90 });
    const started = await orchestrator.startPipeline(
      'user-1',
      { idea: 'React todo app with Google Auth' },
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-todo-app', 'private');
    const completed = await waitForStage(store, started.id, ['completed']);
    assert.equal(completed.stage, 'completed');
    assert.ok(completed.protoOutput);
    assert.ok(completed.traceOutput);
  });

  it('iterateProtoFromFeedback accepts awaiting_critic_resolution as origin', async () => {
    const original = process.env.AUTO_PUSH_AFTER_PROTO;
    process.env.AUTO_PUSH_AFTER_PROTO = 'false';
    try {
      const { orchestrator, store } = createOrchestrator({ criticThreshold: 40 });
      const started = await orchestrator.startPipeline(
        'user-1',
        { idea: 'React todo app with Google Auth' },
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
      await waitForStage(store, started.id, ['awaiting_approval']);
      await orchestrator.approveSpec(started.id, 'my-todo-app', 'private');
      await waitForStage(store, started.id, ['awaiting_critic_resolution']);

      const result = await orchestrator.iterateProtoFromFeedback(
        started.id,
        'Lütfen renkleri pembe yap',
      );
      // Pipeline transitions immediately back into proto_building; the
      // background re-run continues asynchronously.
      assert.equal(result.stage, 'proto_building');
    } finally {
      process.env.AUTO_PUSH_AFTER_PROTO = original ?? 'true';
    }
  });
});
