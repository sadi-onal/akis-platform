/**
 * PDP-3 B5 — feedback-driven Proto re-iteration tests.
 *
 * Spec: docs/product/wave3/b5-feedback-iteration.md
 *
 * Covers `iterateProtoFromFeedback`:
 *   - Stage rejection: rejects calls outside `awaiting_push_confirm`
 *   - Happy path: pipeline transitions awaiting_push_confirm → proto_building
 *     and Proto is re-invoked with dryRun + a feedbackContext that includes
 *     the user's correction request
 *   - Conversation audit: `user_feedback` entry appended to scribe_conversation
 *   - Idempotency vs lock: see notes below
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.AUTO_PUSH_AFTER_PROTO = 'false';

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
  StructuredSpec,
  ProtoOutput,
  TraceOutput,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';
import type { ScribeAgent, ScribeState } from '../../src/pipeline/agents/scribe/ScribeAgent.js';
import type { ProtoAgent, ProtoResult } from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type { TraceAgent } from '../../src/pipeline/agents/trace/TraceAgent.js';
import { __clearEnvCacheForTests } from '../../src/config/env.js';

__clearEnvCacheForTests();

// ─── Fixtures (mirror pipeline-preview-gate.test.ts) ────

const validSpec: StructuredSpec = {
  title: 'Todo App',
  problemStatement: 'Görev takip uygulaması.',
  userStories: [{ persona: 'Kullanıcı', action: 'Görev oluştur', benefit: 'Takip' }],
  acceptanceCriteria: [{ id: 'ac-1', given: 'Açık', when: 'Ekle', then: 'Görünür' }],
  technicalConstraints: { stack: 'React + Vite' },
  outOfScope: [],
};

const mockScribeOutput: ScribeOutput = {
  spec: validSpec,
  rawMarkdown: '# Todo App',
  confidence: 0.85,
  clarificationsAsked: 0,
};

const dryRunProtoOutput: ProtoOutput = {
  ok: true,
  branch: 'dry-run',
  repo: 'testuser/todo-app',
  repoUrl: 'https://github.com/testuser/todo-app',
  files: [
    { filePath: 'src/App.tsx', content: 'green-original', linesOfCode: 1 },
    { filePath: 'package.json', content: '{"name":"todo"}', linesOfCode: 1 },
  ],
  setupCommands: ['npm install'],
  metadata: { filesCreated: 2, totalLinesOfCode: 2, stackUsed: 'React + Vite', committed: false },
};

const revisedDryRunOutput: ProtoOutput = {
  ...dryRunProtoOutput,
  files: [
    { filePath: 'src/App.tsx', content: 'pink-revised', linesOfCode: 1 },
    { filePath: 'package.json', content: '{"name":"todo"}', linesOfCode: 1 },
  ],
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

function createMockScribe(): ScribeAgent {
  return {
    createInitialState() {
      return {
        idea: 'todo',
        conversation: [],
        clarificationRound: 0,
        phase: 'clarifying' as const,
        pendingQuestionIds: [],
        answeredQuestionIds: [],
      };
    },
    analyzIdea: async () => ({ type: 'spec' as const, data: mockScribeOutput }),
    processUserAnswer(_state: ScribeState, _answer: string) {},
    continueAfterAnswer: async () => ({ type: 'spec' as const, data: mockScribeOutput }),
    regenerateSpec: async () => ({ type: 'spec' as const, data: mockScribeOutput }),
    generateSpec: async () => ({ type: 'spec' as const, data: mockScribeOutput }),
  } as unknown as ScribeAgent;
}

function createMockTrace(): TraceAgent {
  return {
    execute: async () => ({ type: 'output' as const, data: mockTraceOutput }),
  } as unknown as TraceAgent;
}

function createOrchestrator(overrides?: {
  store?: PipelineStore;
  proto?: ProtoAgent;
  emit?: (event: PipelineEvent) => void;
}) {
  const store = overrides?.store ?? new InMemoryStore();
  return {
    store,
    orchestrator: new PipelineOrchestrator(
      store,
      createMockScribe(),
      overrides?.proto ??
        ({
          execute: async () => ({ type: 'output' as const, data: dryRunProtoOutput }),
          pushScaffoldFiles: async () => ({ type: 'output' as const, data: dryRunProtoOutput }),
        } as unknown as ProtoAgent),
      createMockTrace(),
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

// ─── Tests ───────────────────────────────────────

describe('B5 Iterate from feedback', () => {
  it('rejects iteration outside awaiting_push_confirm', async () => {
    process.env.AUTO_PUSH_AFTER_PROTO = 'false';
    __clearEnvCacheForTests();

    const { orchestrator, store } = createOrchestrator();
    const started = await orchestrator.startPipeline(
      'user-1',
      { idea: 'todo' },
      undefined,
      undefined,
      undefined,
      undefined,
      true /* traceEnabled */
    );
    // Pipeline currently scribe_generating → awaiting_approval; we are NOT at
    // awaiting_push_confirm yet. iterateProtoFromFeedback must reject.
    await waitForStage(store, started.id, ['awaiting_approval']);

    await assert.rejects(
      () => orchestrator.iterateProtoFromFeedback(started.id, 'make it pink'),
      /Invalid stage|awaiting_push_confirm/i
    );
  });

  it('happy path: transitions to proto_building and re-runs Proto with feedback context', async () => {
    process.env.AUTO_PUSH_AFTER_PROTO = 'false';
    __clearEnvCacheForTests();

    // Spy: capture every input to proto.execute so we can prove the
    // feedback text reached the agent through knowledgeContext.
    const executeCalls: Array<{ dryRun?: boolean; knowledgeContext?: string }> = [];
    const proto: ProtoAgent = {
      execute: async (input: unknown) => {
        const i = input as { dryRun?: boolean; knowledgeContext?: string };
        executeCalls.push({ dryRun: i.dryRun, knowledgeContext: i.knowledgeContext });
        // First call: original dry-run; second (after iterate): revised
        const data = executeCalls.length === 1 ? dryRunProtoOutput : revisedDryRunOutput;
        return { type: 'output' as const, data };
      },
      pushScaffoldFiles: async () =>
        ({ type: 'output' as const, data: dryRunProtoOutput }) as ProtoResult,
    } as unknown as ProtoAgent;
    const { orchestrator, store } = createOrchestrator({ proto });

    // Bring pipeline to awaiting_push_confirm
    const started = await orchestrator.startPipeline(
      'user-1',
      { idea: 'todo' },
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-todo', 'private');
    await waitForStage(store, started.id, ['awaiting_push_confirm']);
    assert.equal(executeCalls.length, 1);

    // Iterate with feedback
    const FEEDBACK = 'yeşil renkleri pembe yap';
    const transitioning = await orchestrator.iterateProtoFromFeedback(started.id, FEEDBACK);
    assert.equal(transitioning.stage, 'proto_building');

    // Wait for the new dryRun to land
    const rerun = await waitForStage(store, started.id, ['awaiting_push_confirm']);
    assert.equal(executeCalls.length, 2, 'Proto must be invoked a second time');
    assert.equal(executeCalls[1]?.dryRun, true, 'second invocation must still be dryRun');
    assert.match(
      executeCalls[1]?.knowledgeContext ?? '',
      /KULLANICI DÜZELTME İSTEĞİ/,
      'feedback block must be prepended to Proto knowledge context'
    );
    assert.match(
      executeCalls[1]?.knowledgeContext ?? '',
      new RegExp(FEEDBACK),
      'feedback text must appear verbatim in Proto context'
    );

    // Files are replaced with the revised set
    assert.equal(rerun.protoOutput?.files?.[0]?.content, 'pink-revised');

    // Conversation audit: user_feedback entry appended
    const feedbackEntries = rerun.scribeConversation.filter((m) => m.type === 'user_feedback');
    assert.equal(feedbackEntries.length, 1);
    assert.equal(
      (feedbackEntries[0] as { content: string }).content,
      FEEDBACK,
      'user_feedback content must be verbatim'
    );
  });

  it('rejects iteration when pipeline lacks approvedSpec (defensive)', async () => {
    process.env.AUTO_PUSH_AFTER_PROTO = 'false';
    __clearEnvCacheForTests();

    const { orchestrator, store } = createOrchestrator();
    // Forge a pipeline that's at awaiting_push_confirm but has no approvedSpec
    // (shouldn't happen in real life but defensive guard catches it).
    const p = await store.create('user-x');
    await store.update(p.id, {
      stage: 'awaiting_push_confirm',
      protoOutput: dryRunProtoOutput,
      protoConfig: { repoName: 'forged', repoVisibility: 'private' },
    });

    await assert.rejects(
      () => orchestrator.iterateProtoFromFeedback(p.id, 'do thing'),
      /approvedSpec/i
    );
  });
});
