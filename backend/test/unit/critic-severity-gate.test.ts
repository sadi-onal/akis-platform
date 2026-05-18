import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// PR-F (mimari refactor 2026-05-19): Critic ana akıştan "guardrail"
// konumuna çekildi. Pipeline yalnızca findings içinde severity=critical
// bir bulgu varsa `awaiting_critic_resolution`'a düşer. Bu test dosyası
// yeni davranışı doğrular:
//   1. hasCriticalFinding=true → hard-block (awaiting_critic_resolution)
//   2. hasCriticalFinding=false (sadece major/minor/info) → pipeline devam eder
//   3. Findings her durumda intermediateState.criticCodeOutput'a yazılır
process.env.AUTO_PUSH_AFTER_PROTO = 'true';
// Trace iterate-loop'u kapat ki bu testler sadece Critic davranışına odaklansın.
process.env.TRACE_MAX_ITERATE_RETRIES = '0';

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
import type { CriticReviewOutput } from '../../src/pipeline/agents/critic/CriticTypes.js';

// ─── Fixtures ────────────────────────────────────

const validSpec: StructuredSpec = {
  title: 'Note App',
  problemStatement: 'Notları takip eder.',
  userStories: [{ persona: 'Kullanıcı', action: 'Not oluşturma', benefit: 'Takip' }],
  acceptanceCriteria: [
    { id: 'ac-1', given: 'Giriş yapmış', when: 'Not ekle', then: 'Oluşur' },
  ],
  technicalConstraints: { stack: 'React + Vite' },
  outOfScope: [],
};

const mockScribeOutput: ScribeOutput = {
  spec: validSpec,
  rawMarkdown: '# Note App\n...',
  confidence: 0.9,
  clarificationsAsked: 0,
};

const mockProtoOutput: ProtoOutput = {
  ok: true,
  branch: 'proto/scaffold-1',
  repo: 'testuser/note-app',
  repoUrl: 'https://github.com/testuser/note-app',
  files: [
    { filePath: 'src/App.tsx', content: 'export default function App() {}', linesOfCode: 1 },
  ],
  setupCommands: ['npm install'],
  metadata: { filesCreated: 1, totalLinesOfCode: 1, stackUsed: 'React + Vite', committed: true },
};

const mockTraceOutput: TraceOutput = {
  ok: true,
  testFiles: [{ filePath: 'tests/e2e/note.spec.ts', content: 'test()', testCount: 1 }],
  coverageMatrix: { 'ac-1': ['tests/e2e/note.spec.ts'] },
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

/**
 * Build a Critic mock that returns a fixed severity (and a low score so
 * the pre-PR-F threshold check still treats `approved=false`). This lets
 * us isolate the new severity-gate behavior from the legacy
 * score-vs-threshold path.
 */
function createSeverityCriticAI(
  severity: 'critical' | 'major' | 'minor' | 'info',
  score = 50,
): CriticAIDeps {
  return {
    async generateText(): Promise<string> {
      return JSON.stringify({
        overallScore: score,
        findings: [
          {
            severity,
            category: 'completeness',
            description: `mock ${severity} finding`,
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

function createOrchestrator(opts: {
  severity: 'critical' | 'major' | 'minor' | 'info';
  score?: number;
}) {
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
  const critic = new CriticAgent(createSeverityCriticAI(opts.severity, opts.score));
  orchestrator.setCriticAgent(critic);
  return { store, orchestrator };
}

// ─── Tests ───────────────────────────────────────

describe('PR-F — Critic severity gate (guardrail mode)', () => {
  it('severity=critical → halts at awaiting_critic_resolution', async () => {
    const { orchestrator, store } = createOrchestrator({ severity: 'critical', score: 30 });
    const started = await orchestrator.startPipeline(
      'user-1',
      { idea: 'React note app' },
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-note-app', 'private');
    const blocked = await waitForStage(store, started.id, ['awaiting_critic_resolution']);

    assert.equal(blocked.stage, 'awaiting_critic_resolution');
    assert.ok(blocked.protoOutput, 'protoOutput preserved');
    assert.ok(!blocked.traceOutput, 'Trace did not run');

    const review = blocked.intermediateState?.criticCodeOutput as CriticReviewOutput | undefined;
    assert.ok(review, 'criticCodeOutput persisted');
    assert.equal(review.hasCriticalFinding, true);
    assert.equal(review.maxSeverity, 'critical');

    const block = blocked.intermediateState?.criticBlock as
      | { maxSeverity: string; manuallyOverridden: boolean }
      | undefined;
    assert.ok(block, 'criticBlock audit object exists');
    assert.equal(block.maxSeverity, 'critical');
    assert.equal(block.manuallyOverridden, false);
  });

  it('severity=major → pipeline continues to completed (no hard-block)', async () => {
    const { orchestrator, store } = createOrchestrator({ severity: 'major', score: 50 });
    const started = await orchestrator.startPipeline(
      'user-1',
      { idea: 'React note app' },
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-note-app', 'private');
    const final = await waitForStage(store, started.id, ['completed']);

    assert.equal(final.stage, 'completed');
    assert.ok(final.traceOutput, 'Trace must have run');

    // Findings still surfaced via intermediateState — they just don't block.
    const review = final.intermediateState?.criticCodeOutput as CriticReviewOutput | undefined;
    assert.ok(review, 'criticCodeOutput persisted on continued pipeline');
    assert.equal(review.hasCriticalFinding, false);
    assert.equal(review.maxSeverity, 'major');

    // criticBlock must NOT be set when there's no hard-block.
    assert.equal(
      (final.intermediateState as Record<string, unknown> | undefined)?.criticBlock,
      undefined,
    );
  });

  it('severity=minor → pipeline continues; findings still in intermediateState', async () => {
    const { orchestrator, store } = createOrchestrator({ severity: 'minor', score: 80 });
    const started = await orchestrator.startPipeline(
      'user-1',
      { idea: 'React note app' },
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-note-app', 'private');
    const final = await waitForStage(store, started.id, ['completed']);

    assert.equal(final.stage, 'completed');
    const review = final.intermediateState?.criticCodeOutput as CriticReviewOutput | undefined;
    assert.ok(review, 'criticCodeOutput persisted');
    assert.equal(review.hasCriticalFinding, false);
    assert.equal(review.maxSeverity, 'minor');
    // findings array survived round-trip
    assert.equal(review.findings.length, 1);
    assert.equal(review.findings[0]?.severity, 'minor');
  });
});
