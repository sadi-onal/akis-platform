/**
 * PR-V5: Truthful Progress + No Premature Checkmarks
 *
 * Verifies that the orchestrator emits an explicit
 * `{ stage, status: 'completed', progress: 100 }` activity BEFORE each
 * stage transition. Pre-PR-V5 the frontend inferred completion from
 * "stage X is no longer the latest activity" — producing premature
 * checkmarks at Scribe→Proto / Proto→Trace handoffs. The explicit
 * stage-completed event lets the frontend derive completion from a
 * deterministic signal instead.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Match the surrounding fixture's choice to use the legacy auto-push flow —
// otherwise the test would have to drive the preview-confirm gate manually
// and we'd be testing two things at once. The preview-gate path is covered
// by the existing pipeline-preview-gate.test.ts file.
process.env.AUTO_PUSH_AFTER_PROTO = 'true';

import {
  PipelineOrchestrator,
  type PipelineStore,
  type PipelineStateUpdate,
} from '../../src/pipeline/core/orchestrator/PipelineOrchestrator.js';
import { __clearEnvCacheForTests } from '../../src/config/env.js';

__clearEnvCacheForTests();

import {
  getActivities,
  __resetActivityBufferForTests,
  type PipelineActivity,
} from '../../src/pipeline/core/activityEmitter.js';
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
  testSummary: {
    totalTests: 2,
    coveragePercentage: 100,
    coveredCriteria: ['ac-1'],
    uncoveredCriteria: [],
  },
  branch: 'trace/tests-456',
};

// ─── In-Memory Store (copy of the fixture used by pipeline-orchestrator.test.ts) ──

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
    createInitialState(input: {
      idea: string;
      context?: string;
      targetStack?: string;
    }): ScribeState {
      return {
        idea: input.idea,
        context: input.context,
        targetStack: input.targetStack,
        conversation: [],
        clarificationRound: 0,
        phase: 'clarifying' as const,
      };
    },
    analyzIdea: async () => ({ type: 'spec' as const, data: mockScribeOutput }),
    processUserAnswer(_state: ScribeState, _answer: string) {},
    continueAfterAnswer: async () => ({ type: 'spec' as const, data: mockScribeOutput }),
    regenerateSpec: async () => ({ type: 'spec' as const, data: mockScribeOutput }),
    generateSpec: async () => ({ type: 'spec' as const, data: mockScribeOutput }),
  } as unknown as ScribeAgent;
}

function createMockProto(): ProtoAgent {
  return {
    execute: async (): Promise<ProtoResult> => ({ type: 'output' as const, data: mockProtoOutput }),
  } as unknown as ProtoAgent;
}

function createMockTrace(): TraceAgent {
  return {
    execute: async (): Promise<TraceResult> => ({ type: 'output' as const, data: mockTraceOutput }),
  } as unknown as TraceAgent;
}

function createOrchestrator() {
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
    })
  );
  return { store, orchestrator };
}

function completedActivities(
  activities: PipelineActivity[],
  stage: PipelineActivity['stage']
): PipelineActivity[] {
  return activities.filter((a) => a.stage === stage && a.status === 'completed');
}

// ─── Tests ────────────────────────────────────────

describe('PR-V5 — explicit stage-completed activity emission', () => {
  it('emits stage="scribe" status="completed" progress=100 when scribe phase succeeds', async () => {
    const { orchestrator, store } = createOrchestrator();
    const started = await orchestrator.startPipeline(
      'user-1',
      { idea: 'React todo app with Google Auth' },
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );
    __resetActivityBufferForTests(started.id);

    const specReady = await waitForStage(store, started.id, ['awaiting_approval']);

    const activities = getActivities(specReady.id);
    const scribeCompleted = completedActivities(activities, 'scribe');
    assert.equal(
      scribeCompleted.length,
      1,
      `expected exactly one scribe stage-completed activity, got ${scribeCompleted.length}`
    );
    assert.equal(scribeCompleted[0]!.status, 'completed');
    assert.equal(scribeCompleted[0]!.progress, 100);
    assert.equal(scribeCompleted[0]!.step, 'stage_completed');
  });

  it('emits stage="proto" status="completed" progress=100 when proto phase succeeds', async () => {
    const { orchestrator, store } = createOrchestrator();
    const started = await orchestrator.startPipeline(
      'user-1',
      { idea: 'React todo app' },
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );
    __resetActivityBufferForTests(started.id);

    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-todo-app', 'private');
    const completed = await waitForStage(store, started.id, ['completed']);

    const activities = getActivities(completed.id);
    const protoCompleted = completedActivities(activities, 'proto');
    assert.equal(
      protoCompleted.length,
      1,
      `expected exactly one proto stage-completed activity, got ${protoCompleted.length}`
    );
    assert.equal(protoCompleted[0]!.status, 'completed');
    assert.equal(protoCompleted[0]!.progress, 100);
  });

  it('emits proto stage-completed BEFORE the trace stage activities arrive', async () => {
    const { orchestrator, store } = createOrchestrator();
    const started = await orchestrator.startPipeline(
      'user-1',
      { idea: 'React todo app' },
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );
    __resetActivityBufferForTests(started.id);

    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-todo-app', 'private');
    const completed = await waitForStage(store, started.id, ['completed']);

    const activities = getActivities(completed.id);
    const protoCompletedIdx = activities.findIndex(
      (a) => a.stage === 'proto' && a.status === 'completed'
    );
    const firstTraceIdx = activities.findIndex((a) => a.stage === 'trace');

    assert.notEqual(protoCompletedIdx, -1, 'proto stage-completed activity must be emitted');
    assert.notEqual(firstTraceIdx, -1, 'at least one trace activity must be emitted');
    assert.ok(
      protoCompletedIdx < firstTraceIdx,
      `proto stage-completed (idx=${protoCompletedIdx}) must precede the first trace activity (idx=${firstTraceIdx})`
    );
  });

  it('emits stage="trace" status="completed" progress=100 when trace phase succeeds', async () => {
    const { orchestrator, store } = createOrchestrator();
    const started = await orchestrator.startPipeline(
      'user-1',
      { idea: 'React todo app' },
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );
    __resetActivityBufferForTests(started.id);

    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'my-todo-app', 'private');
    const completed = await waitForStage(store, started.id, ['completed']);

    const activities = getActivities(completed.id);
    const traceCompleted = completedActivities(activities, 'trace');
    assert.equal(
      traceCompleted.length,
      1,
      `expected exactly one trace stage-completed activity, got ${traceCompleted.length}`
    );
    assert.equal(traceCompleted[0]!.status, 'completed');
    assert.equal(traceCompleted[0]!.progress, 100);
  });
});
