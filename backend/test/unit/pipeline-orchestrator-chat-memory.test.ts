/**
 * Orchestrator integration tests for chat-memory wire-up (issue #462).
 *
 * Asserts the flag-gated behaviour required by the BUG-A acceptance
 * criteria:
 *   - When `CHAT_CONTEXT_ENABLED=false` the agent's `knowledgeContext`
 *     is unchanged vs. baseline (zero behaviour change — kill-switch).
 *   - When `CHAT_CONTEXT_ENABLED=true` the agent's `knowledgeContext`
 *     includes the "## Conversation so far" block with prior turns.
 *   - Second Scribe turn sees the first turn's content in its system prompt.
 *
 * The test reloads `../../src/config/env.js` between assertions so the
 * flag can be toggled mid-suite (env is otherwise cached in a module
 * singleton).
 */

// Ensure env.ts can parse — worktree test runs may not have a local .env
// so we seed the zod-required variables before importing anything that
// calls getEnv(). This runs at module-load, before test files and
// orchestrator wiring.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';
process.env.AUTH_JWT_SECRET ??= 'test-jwt-secret-at-least-32-chars-long-for-zod';

import { describe, it, beforeEach, afterEach } from 'node:test';
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
  ScribeOutput,
  ScribeClarification,
  StructuredSpec,
  ProtoOutput,
  TraceOutput,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';
import type { ScribeAgent, ScribeState, ScribeResult } from '../../src/pipeline/agents/scribe/ScribeAgent.js';
import type { ProtoAgent } from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type { TraceAgent } from '../../src/pipeline/agents/trace/TraceAgent.js';
import { ChatMemoryContextService } from '../../src/services/knowledge/ChatMemoryContextService.js';
import type { KnowledgeRetrievalService } from '../../src/services/knowledge/retrieval/KnowledgeRetrievalService.js';
import type { ChatRetrievalAnchorService } from '../../src/services/knowledge/retrieval/ChatRetrievalAnchorService.js';
import type { RetrievalResult } from '../../src/services/knowledge/retrieval/types.js';
import { __clearEnvCacheForTests } from '../../src/config/env.js';

// ─── Fixtures (trimmed copies of pipeline-orchestrator.test.ts) ───

const validSpec: StructuredSpec = {
  title: 'Memory Wire Demo',
  problemStatement: 'Chat hafızası doğru akmalı.',
  userStories: [{ persona: 'Kullanıcı', action: 'Sohbet et', benefit: 'Cevap al' }],
  acceptanceCriteria: [{ id: 'ac-1', given: 'Mesaj var', when: 'Gönderdim', then: 'Hatırlıyor' }],
  technicalConstraints: { stack: 'React + Vite' },
  outOfScope: [],
};
const mockScribeOutput: ScribeOutput = { spec: validSpec, rawMarkdown: '# Memory Wire Demo', confidence: 0.9, clarificationsAsked: 0 };
const mockClarification: ScribeClarification = { questions: [{ id: 'q1', question: 'Stack?', reason: 'Gerekli' }] };
const mockProtoOutput: ProtoOutput = {
  ok: true,
  branch: 'proto/demo',
  repo: 'tester/demo',
  repoUrl: 'https://github.com/tester/demo',
  files: [{ filePath: 'src/App.tsx', content: 'x', linesOfCode: 1 }],
  setupCommands: [],
  metadata: { filesCreated: 1, totalLinesOfCode: 1, stackUsed: 'React + Vite', committed: true },
};
const mockTraceOutput: TraceOutput = {
  ok: true,
  testFiles: [{ filePath: 'tests/e2e.spec.ts', content: 'test()', testCount: 1 }],
  coverageMatrix: { 'ac-1': ['tests/e2e.spec.ts'] },
  testSummary: { totalTests: 1, coveragePercentage: 100, coveredCriteria: ['ac-1'], uncoveredCriteria: [] },
  branch: 'trace/demo',
};

// ─── In-memory store ─────────────────────────────────────────────

class InMemoryStore implements PipelineStore {
  private pipelines = new Map<string, PipelineState>();

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
  async getById(id: string) { const p = this.pipelines.get(id); return p ? { ...p } : null; }
  async listByUser(userId: string) { return [...this.pipelines.values()].filter(p => p.userId === userId).map(p => ({ ...p })); }
  async update(id: string, data: Partial<PipelineStateUpdate>) {
    const existing = this.pipelines.get(id);
    if (!existing) throw new Error(`Pipeline not found: ${id}`);
    const updated = {
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

// ─── Helpers ─────────────────────────────────────────────────────

async function waitForStage(store: PipelineStore, id: string, stages: PipelineStage[], timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = await store.getById(id);
    if (p && stages.includes(p.stage)) return p;
    await new Promise(r => setTimeout(r, 10));
  }
  const p = await store.getById(id);
  throw new Error(`Timeout: expected ${stages.join('|')}, got ${p?.stage}`);
}

/**
 * Scribe mock that CAPTURES the `knowledgeContext` passed into it on every
 * invocation. Lets the test assert whether the chat-memory block ended up
 * in the agent's system-prompt source.
 */
function createCapturingScribe(turns: Array<(state: ScribeState) => ScribeResult>): {
  agent: ScribeAgent;
  captured: string[];
} {
  const captured: string[] = [];
  let call = 0;
  const responder = (state: ScribeState) => {
    captured.push(state.knowledgeContext ?? '');
    const turn = turns[Math.min(call, turns.length - 1)];
    call += 1;
    return Promise.resolve(turn(state));
  };
  const agent: ScribeAgent = {
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
    analyzIdea: responder,
    processUserAnswer(state: ScribeState, answer: string) {
      state.conversation.push({ type: 'user_answer', content: answer });
    },
    continueAfterAnswer: responder,
    regenerateSpec: async () => ({ type: 'spec' as const, data: mockScribeOutput }),
    generateSpec: async () => ({ type: 'spec' as const, data: mockScribeOutput }),
  } as unknown as ScribeAgent;

  return { agent, captured };
}

function createMockProto(): ProtoAgent {
  return { execute: async () => ({ type: 'output' as const, data: mockProtoOutput }) } as unknown as ProtoAgent;
}
function createMockTrace(): TraceAgent {
  return { execute: async () => ({ type: 'output' as const, data: mockTraceOutput }) } as unknown as TraceAgent;
}

/** Stub retrieval that always returns one hit echoing the query. */
class StubRetrieval {
  retrieveWithAnchors(query: string): Promise<RetrievalResult[]> {
    return Promise.resolve([
      {
        documentId: `doc-${query}`,
        chunkId: `chunk-${query}`,
        content: `RAG[${query}]`,
        score: 0.8,
        retrievalMethod: 'hybrid',
        provenance: { title: `t-${query}`, docType: 'repo_doc' },
      },
    ]);
  }
}

const NOOP_ANCHORS = {
  read: async () => [],
  write: async () => { /* ignore */ },
  clear: async () => { /* ignore */ },
  readAll: async () => [],
} as unknown as ChatRetrievalAnchorService;

function createOrchestrator(scribe: ScribeAgent) {
  const store = new InMemoryStore();
  const orchestrator = new PipelineOrchestrator(
    store,
    scribe,
    createMockProto(),
    createMockTrace(),
    async () => 'testuser',
    async () => 'ghp_mock_token',
    () => ({
      createRepository: async () => ({ url: '' }),
      createBranch: async () => { /* noop */ },
      commitFile: async () => { /* noop */ },
      pushFiles: async () => { /* noop */ },
      createPR: async () => ({ url: '' }),
      listFiles: async () => [],
      getFileContent: async () => '',
    }),
  );
  const memory = new ChatMemoryContextService(
    new StubRetrieval() as unknown as KnowledgeRetrievalService,
    NOOP_ANCHORS,
  );
  orchestrator.setChatMemoryService(memory);
  return { orchestrator, store };
}

// ─── Flag-gated wire-up ──────────────────────────────────────────

describe('Orchestrator — chat-memory wire-up (issue #462)', () => {
  const originalFlag = process.env.CHAT_CONTEXT_ENABLED;

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.CHAT_CONTEXT_ENABLED;
    else process.env.CHAT_CONTEXT_ENABLED = originalFlag;
  });

  it('does NOT inject chat memory when CHAT_CONTEXT_ENABLED=false (kill-switch)', async () => {
    delete process.env.CHAT_CONTEXT_ENABLED;
    __clearEnvCacheForTests();

    const { agent, captured } = createCapturingScribe([
      () => ({ type: 'spec' as const, data: mockScribeOutput }),
    ]);
    const { orchestrator, store } = createOrchestrator(agent);
    const started = await orchestrator.startPipeline(
      'user-flag-off',
      { idea: 'React todo app with Google Auth' },
      undefined, undefined, undefined, undefined, true,
    );
    await waitForStage(store, started.id, ['awaiting_approval', 'completed']);

    assert.ok(captured.length >= 1, 'scribe must be called');
    const ctx = captured[0];
    assert.ok(!ctx.includes('## Conversation so far'),
      'flag-off: knowledgeContext must NOT contain chat-memory block');
  });

  it('injects chat memory when CHAT_CONTEXT_ENABLED=true (prior turns + RAG hit)', async () => {
    process.env.CHAT_CONTEXT_ENABLED = 'true';
    __clearEnvCacheForTests();

    const { agent, captured } = createCapturingScribe([
      () => ({ type: 'clarification' as const, data: mockClarification }),
      () => ({ type: 'spec' as const, data: mockScribeOutput }),
    ]);
    const { orchestrator, store } = createOrchestrator(agent);

    const started = await orchestrator.startPipeline(
      'user-flag-on',
      { idea: 'Quantum grocery planner with AI' },
    );
    await waitForStage(store, started.id, ['scribe_clarifying']);

    // Turn 2 — the continuation carries prior turns.
    await orchestrator.sendMessage(started.id, 'React kullanayım');
    await waitForStage(store, started.id, ['awaiting_approval']);

    assert.ok(captured.length >= 2, 'scribe must be called at least twice');
    const turn2Ctx = captured[1];
    assert.ok(turn2Ctx.includes('## Conversation so far'),
      'turn 2 must include "Conversation so far" block');
    assert.ok(turn2Ctx.includes('Quantum grocery planner'),
      'turn 2 must include turn 1 user idea content');
    assert.ok(turn2Ctx.includes('## Retrieved context'),
      'turn 2 must include retrieval block from stub');
  });
});

// ─── 3-turn pipeline memory chain ────────────────────────────────

describe('Orchestrator — 3-turn conversation memory chain (issue #462)', () => {
  const originalFlag = process.env.CHAT_CONTEXT_ENABLED;
  beforeEach(() => { process.env.CHAT_CONTEXT_ENABLED = 'true'; });
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.CHAT_CONTEXT_ENABLED;
    else process.env.CHAT_CONTEXT_ENABLED = originalFlag;
  });

  it('turn 3 Scribe input includes both turn 1 and turn 2 content', async () => {
    __clearEnvCacheForTests();

    // Turn 1: clarification. Turn 2: clarification again (round up).
    // Turn 3: spec. `captured` collects the knowledgeContext each call sees.
    const { agent, captured } = createCapturingScribe([
      () => ({ type: 'clarification' as const, data: mockClarification }),
      () => ({ type: 'clarification' as const, data: mockClarification }),
      () => ({ type: 'spec' as const, data: mockScribeOutput }),
    ]);
    const { orchestrator, store } = createOrchestrator(agent);

    const started = await orchestrator.startPipeline(
      'user-3turn',
      { idea: 'CONTENT-TURN-ONE build an auth gateway' },
    );
    await waitForStage(store, started.id, ['scribe_clarifying']);

    await orchestrator.sendMessage(started.id, 'CONTENT-TURN-TWO oauth please');
    await waitForStage(store, started.id, ['scribe_clarifying']);

    await orchestrator.sendMessage(started.id, 'CONTENT-TURN-THREE github oauth is fine');
    await waitForStage(store, started.id, ['awaiting_approval']);

    assert.ok(captured.length >= 3, 'scribe must be called at least 3 times');
    const turn3Ctx = captured[2];
    assert.ok(turn3Ctx.includes('CONTENT-TURN-ONE'),
      'turn 3 must include turn 1 content — ctx length: ' + turn3Ctx.length);
    assert.ok(turn3Ctx.includes('CONTENT-TURN-TWO'),
      'turn 3 must include turn 2 content');
  });
});
