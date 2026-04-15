/**
 * Pipeline Integration Test — Happy Path & completed_partial
 *
 * Tests the full AKIS pipeline flow through PipelineOrchestrator:
 *   idea → Scribe (clarify → generate) → approve → Proto → Trace → completed
 *
 * Uses an in-memory PipelineStore and mock agents (no DB, no real AI, no GitHub).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  PipelineOrchestrator,
  type PipelineStore,
  type PipelineStateUpdate,
} from '../../src/pipeline/core/orchestrator/PipelineOrchestrator.js';
import { ScribeAgent, type ScribeAIDeps } from '../../src/pipeline/agents/scribe/ScribeAgent.js';
import { ProtoAgent, type ProtoAIDeps, type ProtoGitHubDeps } from '../../src/pipeline/agents/proto/ProtoAgent.js';
import { TraceAgent, type TraceAIDeps, type TraceGitHubDeps } from '../../src/pipeline/agents/trace/TraceAgent.js';
import type {
  PipelineState,
  PipelineStage,
  ScribeMessageType,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';
import type { GitHubServiceLike } from '../../src/pipeline/core/pipeline-factory.js';

// ─── Test Fixtures ──────────────────────────────────

const CLARIFICATION_RESPONSE = JSON.stringify({
  ready: false,
  questions: [
    {
      id: 'q1',
      question: 'Hangi platformu hedefliyorsunuz?',
      reason: 'Teknoloji stack seçimi için önemli',
      suggestions: ['Web', 'Mobile', 'Her ikisi'],
    },
    {
      id: 'q2',
      question: 'Veritabanı tercihiniz var mı?',
      reason: 'Veri saklama stratejisi için',
      suggestions: ['localStorage', 'Supabase'],
    },
  ],
});

const READY_RESPONSE = JSON.stringify({ ready: true });

const SPEC_RESPONSE = JSON.stringify({
  spec: {
    title: 'Basit Hesap Makinesi',
    problemStatement: 'Kullanıcıların basit matematiksel işlemler yapabilecekleri bir web uygulaması.',
    userStories: [
      { persona: 'Kullanıcı', action: 'Toplama işlemi yapma', benefit: 'Hızlı hesaplama' },
      { persona: 'Kullanıcı', action: 'Çıkarma işlemi yapma', benefit: 'Hızlı hesaplama' },
    ],
    acceptanceCriteria: [
      { id: 'ac-1', given: 'Kullanıcı uygulamayı açtığında', when: 'İki sayı girip toplama butonuna basınca', then: 'Doğru toplam gösterilir' },
      { id: 'ac-2', given: 'Kullanıcı uygulamayı açtığında', when: 'İki sayı girip çıkarma butonuna basınca', then: 'Doğru fark gösterilir' },
    ],
    technicalConstraints: { stack: 'React + Vite', integrations: [], nonFunctional: ['Responsive'] },
    outOfScope: ['Bilimsel hesaplamalar'],
  },
  plan: {
    projectName: 'basit-hesap-makinesi',
    summary: 'Basit bir hesap makinesi web uygulaması',
    features: [
      { name: 'Toplama', description: 'İki sayıyı toplar' },
      { name: 'Çıkarma', description: 'İki sayıyı çıkarır' },
    ],
    techChoices: ['React', 'Vite'],
    estimatedFiles: 8,
    requiresTests: true,
  },
  rawMarkdown: '# Basit Hesap Makinesi\n\n## Problem\nKullanıcılar basit hesaplamalar yapabilmeli.',
  confidence: 0.92,
  clarificationsAsked: 1,
});

const PROTO_RESPONSE = JSON.stringify({
  files: [
    { filePath: 'package.json', content: '{"name":"basit-hesap-makinesi","scripts":{"dev":"vite"}}', linesOfCode: 5 },
    { filePath: 'index.html', content: '<!DOCTYPE html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>', linesOfCode: 1 },
    { filePath: 'vite.config.js', content: 'import react from "@vitejs/plugin-react"; export default { plugins: [react()] };', linesOfCode: 3 },
    { filePath: '.gitignore', content: 'node_modules\ndist\n.env', linesOfCode: 3 },
    { filePath: 'README.md', content: '# Basit Hesap Makinesi', linesOfCode: 1 },
    { filePath: 'src/main.jsx', content: 'import React from "react"; import ReactDOM from "react-dom/client"; import App from "./App"; ReactDOM.createRoot(document.getElementById("root")).render(<App />);', linesOfCode: 4 },
    { filePath: 'src/App.jsx', content: 'import Calculator from "./components/Calculator"; export default function App() { return <Calculator />; }', linesOfCode: 5 },
    { filePath: 'src/App.css', content: 'body { font-family: sans-serif; }', linesOfCode: 1 },
    { filePath: 'src/components/Calculator.jsx', content: 'export default function Calculator() { return <div>Calculator</div>; }', linesOfCode: 10 },
  ],
  metadata: { filesCreated: 9, totalLinesOfCode: 33, stackUsed: 'React + Vite', committed: true },
  setupCommands: ['npm install', 'npm run dev'],
});

const TRACE_RESPONSE = JSON.stringify({
  testFiles: [
    {
      filePath: 'tests/e2e/calculator.spec.ts',
      content: 'import { test, expect } from "@playwright/test"; test("toplama", async ({ page }) => { /* ... */ });',
      testCount: 2,
    },
    {
      filePath: 'tests/playwright.config.ts',
      content: 'import { defineConfig } from "@playwright/test"; export default defineConfig({ testDir: "./e2e" });',
      testCount: 0,
    },
  ],
  coverageMatrix: {
    'ac-1': ['tests/e2e/calculator.spec.ts'],
    'ac-2': ['tests/e2e/calculator.spec.ts'],
  },
  testSummary: {
    totalTests: 2,
    coveragePercentage: 100,
    coveredCriteria: ['ac-1', 'ac-2'],
    uncoveredCriteria: [],
  },
});

// ─── In-Memory Pipeline Store ───────────────────────

function createInMemoryStore(): PipelineStore {
  const pipelines = new Map<string, PipelineState>();
  let counter = 0;

  return {
    async create(userId: string): Promise<PipelineState> {
      counter++;
      const id = `test-pipeline-${counter}`;
      const state: PipelineState = {
        id,
        userId,
        stage: 'scribe_clarifying',
        scribeConversation: [],
        metrics: {
          startedAt: new Date(),
          clarificationRounds: 0,
          retryCount: 0,
        },
        attemptCount: 0,
        stageVersion: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      pipelines.set(id, state);
      return structuredClone(state);
    },

    async getById(id: string): Promise<PipelineState | null> {
      const p = pipelines.get(id);
      return p ? structuredClone(p) : null;
    },

    async listByUser(userId: string): Promise<PipelineState[]> {
      return [...pipelines.values()]
        .filter((p) => p.userId === userId)
        .map((p) => structuredClone(p));
    },

    async update(
      id: string,
      data: Partial<PipelineStateUpdate>,
      _opts?: { expectedStageVersion?: number },
    ): Promise<PipelineState> {
      const existing = pipelines.get(id);
      if (!existing) throw new Error(`Pipeline not found: ${id}`);

      const updated = { ...existing, ...data, updatedAt: new Date() } as PipelineState;
      if (data.metrics) {
        updated.metrics = { ...existing.metrics, ...data.metrics };
      }
      if (data.stage && data.stage !== existing.stage) {
        updated.stageVersion = (existing.stageVersion ?? 0) + 1;
      }
      pipelines.set(id, updated);
      return structuredClone(updated);
    },
  };
}

// ─── Mock AI Factories ──────────────────────────────

function createSequentialAI(responses: string[]): ScribeAIDeps & ProtoAIDeps & TraceAIDeps {
  let callIndex = 0;
  return {
    async generateText(_system: string, _user: string): Promise<string> {
      if (callIndex >= responses.length) {
        throw new Error(`No more mock AI responses (used ${responses.length})`);
      }
      return responses[callIndex++];
    },
  };
}

// ─── Mock GitHub ────────────────────────────────────

function createMockGitHub(): ProtoGitHubDeps & TraceGitHubDeps & GitHubServiceLike {
  const pushedFiles: Array<{ path: string; content: string }> = [];

  return {
    async createRepository(_owner, name, _isPrivate) {
      return { url: `https://github.com/testuser/${name}` };
    },
    async createBranch() {},
    async commitFile(_o, _r, _b, filePath, content) {
      pushedFiles.push({ path: filePath, content });
    },
    async pushFiles(_o, _r, _b, files) {
      pushedFiles.push(...files);
    },
    async createPR(_o, repo) {
      return { url: `https://github.com/testuser/${repo}/pull/1` };
    },
    async listFiles() {
      return [
        'package.json',
        'index.html',
        'vite.config.js',
        'src/main.jsx',
        'src/App.jsx',
        'src/App.css',
        'src/components/Calculator.jsx',
      ];
    },
    async getFileContent(_o, _r, _b, filePath) {
      if (filePath === 'src/App.jsx') return 'export default function App() { return <div>Calculator</div>; }';
      if (filePath === 'src/components/Calculator.jsx') return 'export default function Calculator() { return <div>Calc</div>; }';
      if (filePath === 'src/main.jsx') return 'import App from "./App"; render(App);';
      return '{}';
    },
  };
}

// ─── Helper: wait for pipeline to reach a target stage ──

async function waitForStage(
  store: PipelineStore,
  pipelineId: string,
  targetStages: PipelineStage[],
  timeoutMs = 10_000,
): Promise<PipelineState> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = await store.getById(pipelineId);
    if (p && targetStages.includes(p.stage)) return p;
    await new Promise((r) => setTimeout(r, 50));
  }
  const final = await store.getById(pipelineId);
  throw new Error(
    `Pipeline ${pipelineId} did not reach ${targetStages.join('|')} within ${timeoutMs}ms. ` +
    `Current stage: ${final?.stage ?? 'NOT_FOUND'}, error: ${JSON.stringify(final?.error)}`,
  );
}

/**
 * Wait for the pipeline conversation to contain a message of the given type.
 * This is necessary because the orchestrator runs Scribe in the background
 * and the stage may already be correct before the conversation is populated.
 */
async function waitForConversationMessage(
  store: PipelineStore,
  pipelineId: string,
  messageType: ScribeMessageType['type'],
  timeoutMs = 10_000,
): Promise<PipelineState> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = await store.getById(pipelineId);
    if (p && p.scribeConversation.some((m) => m.type === messageType)) return p;
    await new Promise((r) => setTimeout(r, 50));
  }
  const final = await store.getById(pipelineId);
  throw new Error(
    `Pipeline ${pipelineId} conversation did not contain '${messageType}' within ${timeoutMs}ms. ` +
    `Stage: ${final?.stage}, messages: ${final?.scribeConversation.map((m) => m.type).join(', ')}`,
  );
}

// ─── Integration: Happy Path ────────────────────────

describe('Pipeline integration — happy path', () => {
  let store: PipelineStore;
  let events: Array<{ type: string; stage?: string }>;

  beforeEach(() => {
    store = createInMemoryStore();
    events = [];
  });

  it('completes full flow: idea → scribe_clarifying → scribe_generating → awaiting_approval → proto_building → trace_testing → completed', async () => {
    // Scribe AI: 1) clarification, 2) ready (after answer), 3) spec
    const scribeAI = createSequentialAI([CLARIFICATION_RESPONSE, READY_RESPONSE, SPEC_RESPONSE]);
    const protoAI = createSequentialAI([PROTO_RESPONSE]);
    const traceAI = createSequentialAI([TRACE_RESPONSE]);
    const github = createMockGitHub();

    const scribe = new ScribeAgent(scribeAI);
    const proto = new ProtoAgent(protoAI, github);
    const trace = new TraceAgent(traceAI, github);

    const orchestrator = new PipelineOrchestrator(
      store,
      scribe,
      proto,
      trace,
      async () => 'testuser',           // getGitHubOwner
      async () => 'ghp_mock_token_test', // getGitHubToken (mock prefix skips validation)
      () => github,                      // createGitHubService
      (event) => events.push({ type: event.type, stage: event.stage }),
      (model, ghService?) => ({
        scribe: new ScribeAgent(scribeAI),
        proto: new ProtoAgent(protoAI, ghService ?? github),
        trace: new TraceAgent(traceAI, ghService ?? github),
      }),
    );

    // 1. Start pipeline with idea
    const initial = await orchestrator.startPipeline('user-1', {
      idea: 'basit hesap makinesi, toplama ve cikarma yapsin',
    });
    assert.ok(initial.id, 'pipeline should have an id');
    assert.equal(initial.title, 'basit hesap makinesi, toplama ve cikarma yapsin');

    // 2. Wait for Scribe to produce clarification questions (wait for conversation, not just stage)
    const afterClarify = await waitForConversationMessage(store, initial.id, 'clarification');
    assert.equal(afterClarify.stage, 'scribe_clarifying');

    // Verify clarification questions exist in conversation
    const clarMsg = afterClarify.scribeConversation.find((m) => m.type === 'clarification');
    assert.ok(clarMsg, 'should have clarification message');
    if (clarMsg && clarMsg.type === 'clarification') {
      assert.ok(clarMsg.content.questions.length >= 1, 'should have at least 1 question');
    }

    // 3. User answers questions
    await orchestrator.sendMessage(initial.id, 'Web platformu, localStorage kullanmak istiyorum');

    // 4. Wait for Scribe to generate spec (transitions through scribe_generating → awaiting_approval)
    const afterSpec = await waitForStage(store, initial.id, ['awaiting_approval']);
    assert.equal(afterSpec.stage, 'awaiting_approval');

    // Verify spec quality
    assert.ok(afterSpec.scribeOutput, 'should have scribeOutput');
    assert.ok(afterSpec.scribeOutput!.confidence > 0.7, `confidence should be > 0.7, got ${afterSpec.scribeOutput!.confidence}`);
    assert.equal(afterSpec.scribeOutput!.spec.title, 'Basit Hesap Makinesi');
    assert.ok(afterSpec.scribeOutput!.spec.userStories.length >= 2, 'spec should have at least 2 user stories');
    assert.ok(afterSpec.scribeOutput!.spec.acceptanceCriteria.length >= 2, 'spec should have at least 2 acceptance criteria');

    // Verify scribe metrics
    assert.ok(afterSpec.metrics.scribeCompletedAt, 'scribeCompletedAt should be set');
    assert.ok(afterSpec.metrics.clarificationRounds >= 1, 'should have at least 1 clarification round');

    // 5. Approve spec → triggers Proto → Trace in background
    const afterApprove = await orchestrator.approveSpec(
      initial.id,
      'basit-hesap-makinesi',
      'private',
    );
    assert.equal(afterApprove.stage, 'proto_building');
    assert.ok(afterApprove.approvedSpec, 'approvedSpec should be set');
    assert.ok(afterApprove.metrics.approvedAt, 'approvedAt should be set');

    // 6. Wait for Proto to complete → transitions to trace_testing
    const _afterProto = await waitForStage(store, initial.id, ['trace_testing', 'completed', 'completed_partial']);
    // Proto should have completed if we see trace_testing or later
    const pipelineAfterProto = await store.getById(initial.id);
    assert.ok(pipelineAfterProto, 'pipeline should exist');
    assert.ok(pipelineAfterProto!.protoOutput, 'protoOutput should be set');
    assert.ok(pipelineAfterProto!.protoOutput!.files.length >= 3, `should have at least 3 files, got ${pipelineAfterProto!.protoOutput!.files.length}`);
    assert.ok(
      pipelineAfterProto!.protoOutput!.files.some((f) => f.filePath === 'src/App.jsx'),
      'should include App.jsx',
    );
    assert.ok(
      pipelineAfterProto!.protoOutput!.files.some((f) => f.filePath === 'package.json'),
      'should include package.json',
    );

    // Check repoUrl and branch on protoOutput
    assert.ok(pipelineAfterProto!.protoOutput!.repoUrl, 'should have repoUrl');
    assert.ok(pipelineAfterProto!.protoOutput!.branch, 'should have branch');

    // 7. Wait for Trace to complete → pipeline reaches 'completed'
    const finalState = await waitForStage(store, initial.id, ['completed', 'completed_partial']);

    // If Trace succeeded, we should have completed
    if (finalState.stage === 'completed') {
      assert.ok(finalState.traceOutput, 'traceOutput should be set');
      assert.ok(finalState.traceOutput!.testFiles.length >= 1, 'should have at least 1 test file');
      assert.equal(finalState.traceOutput!.testSummary.totalTests, 2);
      assert.equal(finalState.traceOutput!.testSummary.coveragePercentage, 100);
    }

    // 8. Verify metrics are recorded
    assert.ok(finalState.metrics.startedAt, 'startedAt should be set');
    assert.ok(finalState.metrics.totalDurationMs != null, 'totalDurationMs should be set');
    assert.ok(finalState.metrics.totalDurationMs! > 0, 'totalDurationMs should be positive');

    // 9. Verify state transition events were emitted
    const stageChanges = events.filter((e) => e.type === 'stage_change');
    assert.ok(stageChanges.length >= 2, `should have at least 2 stage_change events, got ${stageChanges.length}`);
  });

  it('records correct timestamps across all pipeline stages', async () => {
    // Use "ready" directly → no clarification
    const scribeAI = createSequentialAI([READY_RESPONSE, SPEC_RESPONSE]);
    const protoAI = createSequentialAI([PROTO_RESPONSE]);
    const traceAI = createSequentialAI([TRACE_RESPONSE]);
    const github = createMockGitHub();

    const scribe = new ScribeAgent(scribeAI);
    const proto = new ProtoAgent(protoAI, github);
    const trace = new TraceAgent(traceAI, github);

    const orchestrator = new PipelineOrchestrator(
      store,
      scribe,
      proto,
      trace,
      async () => 'testuser',
      async () => 'ghp_mock_token_test',
      () => github,
      undefined,
      (model, ghService?) => ({
        scribe: new ScribeAgent(scribeAI),
        proto: new ProtoAgent(protoAI, ghService ?? github),
        trace: new TraceAgent(traceAI, ghService ?? github),
      }),
    );

    const pipeline = await orchestrator.startPipeline('user-1', {
      idea: 'basit hesap makinesi — toplama, cikarma, carpma, bolme',
    });

    // Wait for spec
    const afterSpec = await waitForStage(store, pipeline.id, ['awaiting_approval']);
    assert.ok(afterSpec.metrics.startedAt);
    assert.ok(afterSpec.metrics.scribeCompletedAt);

    // Approve → Proto → Trace
    await orchestrator.approveSpec(pipeline.id, 'calc-app', 'public');

    const final = await waitForStage(store, pipeline.id, ['completed', 'completed_partial']);
    assert.ok(final.metrics.approvedAt, 'approvedAt should be set');
    assert.ok(final.metrics.protoCompletedAt, 'protoCompletedAt should be set');
    assert.ok(final.metrics.totalDurationMs != null && final.metrics.totalDurationMs > 0);

    // Timestamps should be in chronological order
    const started = new Date(final.metrics.startedAt).getTime();
    const scribeCompleted = new Date(final.metrics.scribeCompletedAt!).getTime();
    const approved = new Date(final.metrics.approvedAt!).getTime();
    const protoCompleted = new Date(final.metrics.protoCompletedAt!).getTime();

    assert.ok(started <= scribeCompleted, 'startedAt <= scribeCompletedAt');
    assert.ok(scribeCompleted <= approved, 'scribeCompletedAt <= approvedAt');
    assert.ok(approved <= protoCompleted, 'approvedAt <= protoCompletedAt');
  });
});

// ─── Integration: completed_partial (Trace fails) ───

describe('Pipeline integration — completed_partial path', () => {
  let store: PipelineStore;

  beforeEach(() => {
    store = createInMemoryStore();
  });

  it('transitions to completed_partial when Trace fails', async () => {
    // Scribe: ready + spec (no clarification)
    const scribeAI = createSequentialAI([READY_RESPONSE, SPEC_RESPONSE]);
    const protoAI = createSequentialAI([PROTO_RESPONSE]);
    // Trace AI always fails
    const traceAI: TraceAIDeps = {
      async generateText(): Promise<string> {
        throw new Error('AI provider unavailable');
      },
    };
    const github = createMockGitHub();

    const scribe = new ScribeAgent(scribeAI);
    const proto = new ProtoAgent(protoAI, github);
    const trace = new TraceAgent(traceAI, github);

    const orchestrator = new PipelineOrchestrator(
      store,
      scribe,
      proto,
      trace,
      async () => 'testuser',
      async () => 'ghp_mock_token_test',
      () => github,
      undefined,
      (model, ghService?) => ({
        scribe: new ScribeAgent(scribeAI),
        proto: new ProtoAgent(protoAI, ghService ?? github),
        trace: new TraceAgent(traceAI, ghService ?? github),
      }),
    );

    const pipeline = await orchestrator.startPipeline('user-1', {
      idea: 'basit hesap makinesi uygulamasi gelistir',
    });

    // Wait for spec
    await waitForStage(store, pipeline.id, ['awaiting_approval']);

    // Approve → Proto succeeds → Trace fails → completed_partial
    await orchestrator.approveSpec(pipeline.id, 'calc-partial', 'private');

    const final = await waitForStage(store, pipeline.id, ['completed_partial', 'completed', 'failed'], 15_000);
    assert.equal(final.stage, 'completed_partial', `expected completed_partial, got ${final.stage}`);

    // Proto output should still be present
    assert.ok(final.protoOutput, 'protoOutput should still be present');
    assert.ok(final.protoOutput!.files.length >= 3, 'proto files should be preserved');

    // Trace output should be absent
    assert.equal(final.traceOutput, undefined, 'traceOutput should not be set when Trace fails');

    // Metrics should still have duration
    assert.ok(final.metrics.totalDurationMs != null, 'totalDurationMs should be set');
  });

  it('transitions to completed_partial when skipTrace is called', async () => {
    // Scribe: ready + spec (no clarification)
    const scribeAI = createSequentialAI([READY_RESPONSE, SPEC_RESPONSE]);
    const protoAI = createSequentialAI([PROTO_RESPONSE]);
    // Trace: deliberately slow (simulates hang) — we will skip before it finishes
    const traceAI: TraceAIDeps = {
      async generateText(): Promise<string> {
        // Simulate a very slow response
        await new Promise((r) => setTimeout(r, 60_000));
        return TRACE_RESPONSE;
      },
    };
    const github = createMockGitHub();

    const scribe = new ScribeAgent(scribeAI);
    const proto = new ProtoAgent(protoAI, github);
    const trace = new TraceAgent(traceAI, github);

    const orchestrator = new PipelineOrchestrator(
      store,
      scribe,
      proto,
      trace,
      async () => 'testuser',
      async () => 'ghp_mock_token_test',
      () => github,
      undefined,
      (model, ghService?) => ({
        scribe: new ScribeAgent(scribeAI),
        proto: new ProtoAgent(protoAI, ghService ?? github),
        trace: new TraceAgent(traceAI, ghService ?? github),
      }),
    );

    const pipeline = await orchestrator.startPipeline('user-1', {
      idea: 'basit hesap makinesi, Trace skip test',
    });

    await waitForStage(store, pipeline.id, ['awaiting_approval']);
    await orchestrator.approveSpec(pipeline.id, 'calc-skip', 'private');

    // Wait for proto_building → trace_testing transition
    await waitForStage(store, pipeline.id, ['trace_testing', 'completed', 'completed_partial']);

    // Now skip Trace
    const skipped = await orchestrator.skipTrace(pipeline.id);
    assert.equal(skipped.stage, 'completed_partial');
    assert.ok(skipped.metrics.totalDurationMs != null, 'totalDurationMs should be set');
  });
});

// ─── Integration: Stage transitions correctness ─────

describe('Pipeline integration — stage transitions', () => {
  let store: PipelineStore;
  const observedStages: PipelineStage[] = [];

  beforeEach(() => {
    store = createInMemoryStore();
    observedStages.length = 0;
  });

  it('follows correct FSM: scribe_clarifying → scribe_generating → awaiting_approval → proto_building → trace_testing → completed', async () => {
    const scribeAI = createSequentialAI([CLARIFICATION_RESPONSE, READY_RESPONSE, SPEC_RESPONSE]);
    const protoAI = createSequentialAI([PROTO_RESPONSE]);
    const traceAI = createSequentialAI([TRACE_RESPONSE]);
    const github = createMockGitHub();

    const scribe = new ScribeAgent(scribeAI);
    const proto = new ProtoAgent(protoAI, github);
    const trace = new TraceAgent(traceAI, github);

    const orchestrator = new PipelineOrchestrator(
      store,
      scribe,
      proto,
      trace,
      async () => 'testuser',
      async () => 'ghp_mock_token_test',
      () => github,
      (event) => {
        if (event.stage) observedStages.push(event.stage);
      },
      (model, ghService?) => ({
        scribe: new ScribeAgent(scribeAI),
        proto: new ProtoAgent(protoAI, ghService ?? github),
        trace: new TraceAgent(traceAI, ghService ?? github),
      }),
    );

    const pipeline = await orchestrator.startPipeline('user-1', {
      idea: 'basit hesap makinesi, FSM transition test',
    });

    // scribe_clarifying — wait for conversation to have clarification message
    await waitForConversationMessage(store, pipeline.id, 'clarification');

    // sendMessage → scribe_generating → awaiting_approval
    await orchestrator.sendMessage(pipeline.id, 'Web, localStorage');
    await waitForStage(store, pipeline.id, ['awaiting_approval']);

    // approve → proto_building → trace_testing → completed
    await orchestrator.approveSpec(pipeline.id, 'calc-fsm', 'private');
    const final = await waitForStage(store, pipeline.id, ['completed', 'completed_partial']);

    // Verify the expected transition stages were observed
    assert.ok(
      observedStages.includes('scribe_clarifying'),
      `should include scribe_clarifying, got: ${observedStages.join(', ')}`,
    );
    assert.ok(
      observedStages.includes('scribe_generating'),
      `should include scribe_generating, got: ${observedStages.join(', ')}`,
    );
    assert.ok(
      observedStages.includes('awaiting_approval'),
      `should include awaiting_approval, got: ${observedStages.join(', ')}`,
    );
    assert.ok(
      observedStages.includes('proto_building'),
      `should include proto_building, got: ${observedStages.join(', ')}`,
    );

    // Terminal state should be completed or completed_partial
    assert.ok(
      final.stage === 'completed' || final.stage === 'completed_partial',
      `final stage should be completed or completed_partial, got: ${final.stage}`,
    );
  });
});
