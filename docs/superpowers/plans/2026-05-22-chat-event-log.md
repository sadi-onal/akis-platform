# Chat Timeline Event-Log + Failed-State UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sayaç session'ında gördüğümüz UX bulgularını gider — chat timeline'a Proto/Trace başlama+bitirme+timeout event'leri persist edilir, iterasyon mesajları override yerine append edilir, üst panel `failed` durumunu doğru gösterir, 5 hardcoded "Claude AI ile..." string'i provider-agnostic + bakkalca Türkçe ile değiştirilir.

**Architecture:** Backend `scribe_conversation` jsonb'a yeni event tipleri (`proto_started`, `proto_completed`, `trace_started`, `trace_completed`, `trace_failed`) atomik append edilir. Frontend `mapPipelineToConversation` yeni event'leri ConversationMessage'a proxy eder; varsa snapshot-türevli mesaj üretimi bypass edilir (eski pipeline'lar için fallback korunur). `conversationToChatMessages` yeni event'leri ChatMessage tiplerine map eder. Üst panel `mapStageStatus` failed stage'i errorCode'a göre etiketler.

**Tech Stack:** Backend: Fastify 4 + TypeScript (strict) + node `--test` + Drizzle ORM. Frontend: React 19 + Vitest + i18next.

**Spec:** `docs/superpowers/specs/2026-05-22-chat-timeline-event-log-design.md`
**Branch:** `feat/chat-event-log` (zaten oluşturuldu; main'den ayrıldı, üzerinde sadece spec commit'i var)

---

## File Structure

### Backend — değişecek dosyalar

| Dosya | Sorumluluk | Etki |
|---|---|---|
| `backend/src/pipeline/core/contracts/PipelineTypes.ts` | `ScribeMessageType` union — yeni event tipleri | Task 1 |
| `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts` | `runProto`/`retryProto`/`runTrace`/`retryTrace` — event append'leri | Task 2, 3 |
| `backend/src/pipeline/core/PipelineReconciler.ts` | `sweep()` — timeout durumunda trace_failed append | Task 4 |
| `backend/src/pipeline/agents/scribe/ScribeAgent.ts` | Hardcoded "Claude AI ile fikir analiz ediliyor..." string'i | Task 5 |
| `backend/src/pipeline/agents/proto/ProtoAgent.ts` | 3 hardcoded "Claude AI ile..." string'i | Task 5 |
| `backend/src/pipeline/agents/trace/TraceAgent.ts` | "Claude AI ile Playwright testleri oluşturuluyor..." | Task 5 |

### Backend — yeni testler

| Dosya | Test odağı |
|---|---|
| `backend/test/unit/pipeline-orchestrator-chat-events.test.ts` | Orchestrator scribe_conversation'a proto/trace event'leri append eder mi |
| `backend/test/unit/pipeline-reconciler-chat-event.test.ts` | Reconciler timeout'ta trace_failed event'i append eder mi |
| `backend/test/unit/agent-activity-strings.test.ts` | "Claude AI" + jargon string'leri kaynak kodda hiçbir agent dosyasında geçmez (regex) |

### Frontend — değişecek dosyalar

| Dosya | Sorumluluk | Etki |
|---|---|---|
| `frontend/src/types/workflow.ts` | `ConversationMessage.type` union — yeni tipler | Task 6 |
| `frontend/src/services/api/workflows.ts` | `mapPipelineToConversation` — yeni event proxy + snapshot fallback gate + failed stage map | Task 6, 7, 9 |
| `frontend/src/types/chat.ts` | `ChatMessage` union — `trace_failure` tipi (yeni) | Task 7 |
| `frontend/src/utils/conversationToChatMessages.ts` | Yeni ConversationMessage tiplerini ChatMessage'a map | Task 7 |
| `frontend/src/components/chat/ChatPanel.tsx` (veya alt-component) | `trace_failure` mesajı için UI + action buton'ları | Task 8 |
| `frontend/src/components/chat/MessageList.tsx` veya ProtoMessage | Proto row'da `summary` öne çıkarma | Task 10 |
| `frontend/src/i18n/locales/tr.json` | 3 key TR değer güncellemesi | Task 5 |
| `frontend/src/i18n/locales/en.json` | 3 key EN değer güncellemesi | Task 5 |

### Frontend — yeni / genişleyen testler

| Dosya | Test odağı |
|---|---|
| `frontend/src/utils/__tests__/conversationToChatMessages.test.ts` | Yeni event tiplerinin doğru ChatMessage'a map'lenmesi |
| `frontend/src/services/api/__tests__/workflows.test.ts` | mapPipelineToConversation — event-log varsa snapshot bypass, yoksa fallback. Failed stage label. |

---

## Test Strategy

- **Backend:** Node built-in test runner (`node --test`) via `tsx`. Unit tests use mock `PipelineStore` (in-memory map), mock agents (function stubs). Reference: mevcut `pipeline-orchestrator-chat-memory.test.ts` template.
- **Frontend:** Vitest. Component tests with `@testing-library/react`. `conversationToChatMessages` saf fonksiyon — input → output assert.
- **TDD:** Her task önce failing test → minimal implementation → test pass → commit.
- **Backward compat:** Her task içinde "eski pipeline (event-log'suz)" case'i için ayrı test → fallback hâlâ çalışmalı.

---

## Task 1: Backend — ScribeMessageType union extension

**Files:**
- Modify: `backend/src/pipeline/core/contracts/PipelineTypes.ts:88-98`

- [ ] **Step 1: Read current type definition**

Run: `sed -n '88,98p' backend/src/pipeline/core/contracts/PipelineTypes.ts`
Expected: see existing union `user_idea | clarification | user_answer | spec_draft | spec_approved | spec_rejected | user_note | user_feedback`

- [ ] **Step 2: Extend the union**

Edit `backend/src/pipeline/core/contracts/PipelineTypes.ts`, replace lines 88-98 with:

```ts
export type ScribeMessageType =
  | { type: 'user_idea'; content: string; timestamp?: string }
  | { type: 'clarification'; content: ScribeClarification; timestamp?: string }
  | { type: 'user_answer'; content: string; timestamp?: string }
  | { type: 'spec_draft'; content: ScribeOutput; timestamp?: string }
  | { type: 'spec_approved'; content: StructuredSpec; timestamp?: string }
  | { type: 'spec_rejected'; content: { feedback: string }; timestamp?: string }
  | { type: 'user_note'; content: string; timestamp?: string }
  // B5 — user correction request from the push-confirm gate. Triggers
  // `iterateProtoFromFeedback` which re-runs Proto in dryRun mode.
  | { type: 'user_feedback'; content: string; timestamp?: string }
  // Chat event-log (2026-05-22): persisted pipeline events for the chat
  // timeline. Rendered by frontend `conversationToChatMessages`; iteration
  // counter = (count of prior matching events) + 1.
  | {
      type: 'proto_started';
      content: { iteration: number };
      timestamp: string;
    }
  | {
      type: 'proto_completed';
      content: {
        iteration: number;
        summary: string;
        filesCreated: number;
        totalLines: number;
        branch?: string;
      };
      timestamp: string;
    }
  | {
      type: 'trace_started';
      content: { iteration: number };
      timestamp: string;
    }
  | {
      type: 'trace_completed';
      content: {
        iteration: number;
        totalTests: number;
        coverage: number;
        passed: boolean;
      };
      timestamp: string;
    }
  | {
      type: 'trace_failed';
      content: {
        iteration: number;
        errorCode: string;
        errorMessage: string;
        recoveryAction?: 'retry' | 'skip';
      };
      timestamp: string;
    };
```

- [ ] **Step 3: Verify backend typechecks**

Run: `pnpm -C backend typecheck`
Expected: PASS — `tsc --noEmit` clean.

- [ ] **Step 4: Commit**

```bash
git add backend/src/pipeline/core/contracts/PipelineTypes.ts
git commit -m "feat(types): extend ScribeMessageType with chat event-log types

Adds proto_started, proto_completed, trace_started, trace_completed,
trace_failed for persisted chat timeline events. Existing types get an
optional timestamp field. Non-breaking — JSONB tolerates extra fields."
```

---

## Task 2: Backend — Orchestrator persists proto events

**Files:**
- Modify: `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts` — `runProto` + iterate paths
- Test: `backend/test/unit/pipeline-orchestrator-chat-events.test.ts` (new)

- [ ] **Step 1: Find the Proto run entry point**

Run: `grep -n "async runProto\|private async runProto\|runProto\(" backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts | head -5`
Expected: line numbers for `runProto`, `retryProto`, or similar wrappers.

- [ ] **Step 2: Identify the wrapper that triggers proto agent**

Read 30 lines around the entry point. Locate where `protoOutput` gets persisted via `this.store.update(id, { protoOutput, ... })`. That is the "Proto completed" boundary. The "Proto started" boundary is just before the agent runs.

- [ ] **Step 3: Add helper to count prior events for iteration**

In `PipelineOrchestrator.ts`, add private helper just below class field declarations:

```ts
private countPriorEvents(
  conv: import('../contracts/PipelineTypes.js').ScribeMessageType[],
  type: 'proto_completed' | 'trace_completed'
): number {
  return conv.filter((m) => m.type === type).length;
}
```

- [ ] **Step 4: Write failing test for proto_started append**

Create `backend/test/unit/pipeline-orchestrator-chat-events.test.ts`:

```ts
// Ensure env.ts can parse — worktree test runs may not have a local .env
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';
process.env.AUTH_JWT_SECRET ??= 'test-jwt-secret-at-least-32-chars-long-for-zod';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  PipelineOrchestrator,
  type PipelineStore,
  type PipelineStateUpdate,
} from '../../src/pipeline/core/orchestrator/PipelineOrchestrator.js';
import type {
  PipelineState,
  ScribeOutput,
  StructuredSpec,
  ProtoOutput,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';
import type { ScribeAgent } from '../../src/pipeline/agents/scribe/ScribeAgent.js';
import type { ProtoAgent } from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type { TraceAgent } from '../../src/pipeline/agents/trace/TraceAgent.js';

function makeStore(initial?: PipelineState): PipelineStore & {
  states: Map<string, PipelineState>;
} {
  const states = new Map<string, PipelineState>();
  if (initial) states.set(initial.id, initial);
  return {
    states,
    async get(id) {
      return states.get(id) ?? null;
    },
    async update(id, patch: PipelineStateUpdate) {
      const cur = states.get(id);
      if (!cur) throw new Error('not found');
      const next: PipelineState = {
        ...cur,
        ...patch,
        stageVersion: cur.stageVersion + 1,
        updatedAt: new Date(),
      } as PipelineState;
      states.set(id, next);
      return next;
    },
    async listByUser() {
      return [];
    },
    async create(_userId, _patch) {
      throw new Error('create not used in this test');
    },
  };
}

const SPEC: StructuredSpec = {
  title: 'Test',
  problemStatement: 'p',
  userStories: [],
  acceptanceCriteria: [],
  outOfScope: [],
  technicalConstraints: { stack: '', integrations: [], nonFunctional: [] },
};

const PROTO_OUT: ProtoOutput = {
  ok: true,
  files: [],
  branch: 'main',
  repo: 'owner/repo',
  metadata: { filesCreated: 5, totalLinesOfCode: 100, committed: true },
  summary: 'Sayaç hazır.',
} as ProtoOutput;

describe('PipelineOrchestrator — chat event-log: proto', () => {
  it('appends proto_started + proto_completed to scribeConversation when Proto runs', async () => {
    const initial: PipelineState = {
      id: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      stage: 'awaiting_approval',
      title: 'Test',
      scribeConversation: [
        { type: 'spec_approved', content: SPEC },
      ],
      scribeOutput: null,
      approvedSpec: SPEC,
      protoOutput: null,
      traceOutput: null,
      traceEnabled: true,
      repoContext: null,
      protoConfig: null,
      jiraConfig: null,
      metrics: {},
      error: null,
      intermediateState: null,
      attemptCount: 0,
      stageVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      model: null,
      modelLockedAt: null,
    } as PipelineState;
    const store = makeStore(initial);

    const proto: Pick<ProtoAgent, 'process'> = {
      async process() {
        return { ok: true, output: PROTO_OUT };
      },
    } as Pick<ProtoAgent, 'process'> as ProtoAgent;

    const scribe = {} as ScribeAgent;
    const trace = {} as TraceAgent;
    const orchestrator = new PipelineOrchestrator(
      store,
      { scribe, proto, trace } as any,
      { explainability: { addReasoning() {} } } as any
    );

    await orchestrator.approveSpec(initial.id);

    // Wait a tick for the background runProto to complete
    await new Promise((r) => setTimeout(r, 50));

    const final = store.states.get(initial.id)!;
    const types = final.scribeConversation.map((m) => m.type);
    assert.ok(types.includes('proto_started'), `expected proto_started, got ${types.join(', ')}`);
    assert.ok(types.includes('proto_completed'), `expected proto_completed, got ${types.join(', ')}`);

    const started = final.scribeConversation.find((m) => m.type === 'proto_started');
    assert.equal((started as any).content.iteration, 1);

    const completed = final.scribeConversation.find((m) => m.type === 'proto_completed');
    assert.equal((completed as any).content.iteration, 1);
    assert.equal((completed as any).content.summary, 'Sayaç hazır.');
    assert.equal((completed as any).content.filesCreated, 5);
  });
});
```

- [ ] **Step 5: Run failing test**

Run: `pnpm -C backend exec tsx --test test/unit/pipeline-orchestrator-chat-events.test.ts 2>&1 | tail -10`
Expected: FAIL — `proto_started` / `proto_completed` not in scribeConversation.

- [ ] **Step 6: Implement proto_started append**

In `PipelineOrchestrator.ts`, find the Proto run starting point (`runProto` body, before `agents.proto.process(...)` is called). Add:

```ts
// Persist proto_started chat event before the agent runs.
const protoStartIteration = this.countPriorEvents(pipeline.scribeConversation, 'proto_completed') + 1;
await this.store.update(pipelineId, {
  scribeConversation: [
    ...pipeline.scribeConversation,
    {
      type: 'proto_started',
      content: { iteration: protoStartIteration },
      timestamp: new Date().toISOString(),
    },
  ],
});
// Re-fetch to keep our local reference fresh.
pipeline = await this.getPipeline(pipelineId);
```

- [ ] **Step 7: Implement proto_completed append**

After the success-path `this.store.update(pipelineId, { protoOutput, stage: ... })` in the same `runProto` body, append:

```ts
const updatedAfterProto = await this.getPipeline(pipelineId);
await this.store.update(pipelineId, {
  scribeConversation: [
    ...updatedAfterProto.scribeConversation,
    {
      type: 'proto_completed',
      content: {
        iteration: protoStartIteration,
        summary: protoResult.output.summary ?? 'Proje dosyaları hazır.',
        filesCreated: protoResult.output.metadata.filesCreated,
        totalLines: protoResult.output.metadata.totalLinesOfCode,
        branch: protoResult.output.branch,
      },
      timestamp: new Date().toISOString(),
    },
  ],
});
```

- [ ] **Step 8: Run test, expect PASS**

Run: `pnpm -C backend exec tsx --test test/unit/pipeline-orchestrator-chat-events.test.ts 2>&1 | tail -10`
Expected: PASS — 1 test, 0 fail.

- [ ] **Step 9: Add second test for iteration (2nd Proto run)**

Append to the same test file:

```ts
it('proto_completed iteration counter increments across runs', async () => {
  const id = crypto.randomUUID();
  const initial: PipelineState = {
    id,
    userId: crypto.randomUUID(),
    stage: 'critic_reviewing_code',
    title: 'Test',
    scribeConversation: [
      { type: 'spec_approved', content: SPEC },
      { type: 'proto_started', content: { iteration: 1 }, timestamp: new Date().toISOString() },
      {
        type: 'proto_completed',
        content: { iteration: 1, summary: 'v1', filesCreated: 3, totalLines: 50 },
        timestamp: new Date().toISOString(),
      },
    ],
    scribeOutput: null,
    approvedSpec: SPEC,
    protoOutput: PROTO_OUT,
    traceOutput: null,
    traceEnabled: true,
    repoContext: null,
    protoConfig: null,
    jiraConfig: null,
    metrics: {},
    error: null,
    intermediateState: { iterationHistory: [{ iteration: 1, accepted: false }] },
    attemptCount: 0,
    stageVersion: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
    model: null,
    modelLockedAt: null,
  } as PipelineState;
  const store = makeStore(initial);

  const proto = {
    async process() {
      return { ok: true, output: { ...PROTO_OUT, summary: 'v2' } };
    },
  } as unknown as ProtoAgent;
  const orchestrator = new PipelineOrchestrator(
    store,
    { scribe: {} as any, proto, trace: {} as any } as any,
    { explainability: { addReasoning() {} } } as any
  );

  // Use the iterate-with-feedback path so the orchestrator re-runs Proto.
  await orchestrator.iterateWithFeedback(id, 'rebuild it cleaner');
  await new Promise((r) => setTimeout(r, 50));

  const final = store.states.get(id)!;
  const completedEvents = final.scribeConversation.filter((m) => m.type === 'proto_completed');
  assert.equal(completedEvents.length, 2);
  assert.equal((completedEvents[1] as any).content.iteration, 2);
  assert.equal((completedEvents[1] as any).content.summary, 'v2');
});
```

- [ ] **Step 10: Apply the same event-append logic to the iterate-with-feedback path**

In `PipelineOrchestrator.ts`, find `iterateWithFeedback` or `iterateProtoFromFeedback` (whichever re-runs Proto). Apply the same `countPriorEvents → append proto_started → run → append proto_completed` pattern. Extract a helper if duplication is heavy:

```ts
private async appendProtoStarted(pipelineId: string): Promise<number> {
  const pipeline = await this.getPipeline(pipelineId);
  const iteration = this.countPriorEvents(pipeline.scribeConversation, 'proto_completed') + 1;
  await this.store.update(pipelineId, {
    scribeConversation: [
      ...pipeline.scribeConversation,
      { type: 'proto_started', content: { iteration }, timestamp: new Date().toISOString() },
    ],
  });
  return iteration;
}

private async appendProtoCompleted(pipelineId: string, iteration: number, output: ProtoOutput): Promise<void> {
  const pipeline = await this.getPipeline(pipelineId);
  await this.store.update(pipelineId, {
    scribeConversation: [
      ...pipeline.scribeConversation,
      {
        type: 'proto_completed',
        content: {
          iteration,
          summary: output.summary ?? 'Proje dosyaları hazır.',
          filesCreated: output.metadata.filesCreated,
          totalLines: output.metadata.totalLinesOfCode,
          branch: output.branch,
        },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}
```

Replace the inline appends from Steps 6-7 with calls to these helpers. Apply to the iterate path too.

- [ ] **Step 11: Run both tests**

Run: `pnpm -C backend exec tsx --test test/unit/pipeline-orchestrator-chat-events.test.ts 2>&1 | tail -10`
Expected: PASS — 2 tests, 0 fail.

- [ ] **Step 12: Run full unit suite to check for regressions**

Run: `pnpm -C backend test 2>&1 | tail -10`
Expected: PASS — all tests green (no new failures).

- [ ] **Step 13: Commit**

```bash
git add backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts \
        backend/test/unit/pipeline-orchestrator-chat-events.test.ts
git commit -m "feat(orchestrator): persist proto_started + proto_completed events

Each Proto run appends a started/completed pair to scribe_conversation.
Iteration counter derived from prior proto_completed count. Used by chat
timeline for historical iteration display (no more snapshot override)."
```

---

## Task 3: Backend — Orchestrator persists trace events

**Files:**
- Modify: `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts` — `runTrace`/`retryTrace`
- Test: `backend/test/unit/pipeline-orchestrator-chat-events.test.ts` (extend)

- [ ] **Step 1: Find runTrace entry point**

Run: `grep -n "async runTrace\|private async runTrace\|runTrace\(\|retryTrace" backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts | head -5`

- [ ] **Step 2: Add appendTrace* helpers**

Below the Proto helpers from Task 2, add:

```ts
private async appendTraceStarted(pipelineId: string): Promise<number> {
  const pipeline = await this.getPipeline(pipelineId);
  const iteration = this.countPriorEvents(pipeline.scribeConversation, 'trace_completed') + 1;
  await this.store.update(pipelineId, {
    scribeConversation: [
      ...pipeline.scribeConversation,
      { type: 'trace_started', content: { iteration }, timestamp: new Date().toISOString() },
    ],
  });
  return iteration;
}

private async appendTraceCompleted(
  pipelineId: string,
  iteration: number,
  output: { testSummary: { totalTests: number; coveragePercentage: number } }
): Promise<void> {
  const pipeline = await this.getPipeline(pipelineId);
  await this.store.update(pipelineId, {
    scribeConversation: [
      ...pipeline.scribeConversation,
      {
        type: 'trace_completed',
        content: {
          iteration,
          totalTests: output.testSummary.totalTests,
          coverage: output.testSummary.coveragePercentage,
          passed: true,
        },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

private async appendTraceFailed(
  pipelineId: string,
  iteration: number,
  errorCode: string,
  errorMessage: string,
  recoveryAction?: 'retry' | 'skip'
): Promise<void> {
  const pipeline = await this.getPipeline(pipelineId);
  await this.store.update(pipelineId, {
    scribeConversation: [
      ...pipeline.scribeConversation,
      {
        type: 'trace_failed',
        content: { iteration, errorCode, errorMessage, recoveryAction },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}
```

- [ ] **Step 3: Write failing test for trace_started + trace_completed**

Append to `pipeline-orchestrator-chat-events.test.ts`:

```ts
import type { TraceOutput } from '../../src/pipeline/core/contracts/PipelineTypes.js';

const TRACE_OUT: TraceOutput = {
  testFiles: [{ filePath: 'a.test.ts', testCount: 3, content: '' }],
  testSummary: { totalTests: 3, coveragePercentage: 80 },
  traceability: [],
} as TraceOutput;

describe('PipelineOrchestrator — chat event-log: trace', () => {
  it('appends trace_started + trace_completed when Trace succeeds', async () => {
    const id = crypto.randomUUID();
    const initial: PipelineState = {
      id,
      userId: crypto.randomUUID(),
      stage: 'awaiting_push_confirm',
      title: 'Test',
      scribeConversation: [
        { type: 'spec_approved', content: SPEC },
        { type: 'proto_started', content: { iteration: 1 }, timestamp: new Date().toISOString() },
        { type: 'proto_completed', content: { iteration: 1, summary: 'v1', filesCreated: 1, totalLines: 10 }, timestamp: new Date().toISOString() },
      ],
      scribeOutput: null,
      approvedSpec: SPEC,
      protoOutput: { ...PROTO_OUT, metadata: { ...PROTO_OUT.metadata, committed: false } },
      traceOutput: null,
      traceEnabled: true,
      repoContext: null,
      protoConfig: null,
      jiraConfig: null,
      metrics: {},
      error: null,
      intermediateState: null,
      attemptCount: 0,
      stageVersion: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
      model: null,
      modelLockedAt: null,
    } as PipelineState;
    const store = makeStore(initial);

    const trace = {
      async process() {
        return { ok: true, output: TRACE_OUT };
      },
    } as unknown as TraceAgent;
    const proto = {
      async pushScaffoldFiles() {
        return { ok: true, output: { ...PROTO_OUT, metadata: { ...PROTO_OUT.metadata, committed: true } } };
      },
    } as unknown as ProtoAgent;
    const orchestrator = new PipelineOrchestrator(
      store,
      { scribe: {} as any, proto, trace } as any,
      { explainability: { addReasoning() {} } } as any
    );

    await orchestrator.confirmPush(id);
    await new Promise((r) => setTimeout(r, 50));

    const final = store.states.get(id)!;
    const types = final.scribeConversation.map((m) => m.type);
    assert.ok(types.includes('trace_started'), `got ${types.join(', ')}`);
    assert.ok(types.includes('trace_completed'), `got ${types.join(', ')}`);
    const completed = final.scribeConversation.find((m) => m.type === 'trace_completed');
    assert.equal((completed as any).content.totalTests, 3);
    assert.equal((completed as any).content.coverage, 80);
  });

  it('appends trace_failed when Trace throws', async () => {
    const id = crypto.randomUUID();
    const initial: PipelineState = {
      id,
      userId: crypto.randomUUID(),
      stage: 'awaiting_push_confirm',
      title: 'Test',
      scribeConversation: [
        { type: 'spec_approved', content: SPEC },
        { type: 'proto_completed', content: { iteration: 1, summary: 'v1', filesCreated: 1, totalLines: 10 }, timestamp: new Date().toISOString() },
      ],
      scribeOutput: null,
      approvedSpec: SPEC,
      protoOutput: { ...PROTO_OUT, metadata: { ...PROTO_OUT.metadata, committed: false } },
      traceOutput: null,
      traceEnabled: true,
      repoContext: null,
      protoConfig: null,
      jiraConfig: null,
      metrics: {},
      error: null,
      intermediateState: null,
      attemptCount: 0,
      stageVersion: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
      model: null,
      modelLockedAt: null,
    } as PipelineState;
    const store = makeStore(initial);

    const trace = {
      async process() {
        return { ok: false, error: { code: 'AI_PROVIDER_ERROR', message: 'rate limit' } };
      },
    } as unknown as TraceAgent;
    const proto = {
      async pushScaffoldFiles() {
        return { ok: true, output: { ...PROTO_OUT, metadata: { ...PROTO_OUT.metadata, committed: true } } };
      },
    } as unknown as ProtoAgent;
    const orchestrator = new PipelineOrchestrator(
      store,
      { scribe: {} as any, proto, trace } as any,
      { explainability: { addReasoning() {} } } as any
    );

    await orchestrator.confirmPush(id);
    await new Promise((r) => setTimeout(r, 50));

    const final = store.states.get(id)!;
    const failed = final.scribeConversation.find((m) => m.type === 'trace_failed');
    assert.ok(failed, `expected trace_failed in ${final.scribeConversation.map((m) => m.type).join(', ')}`);
    assert.equal((failed as any).content.errorCode, 'AI_PROVIDER_ERROR');
    assert.equal((failed as any).content.recoveryAction, 'retry');
  });
});
```

- [ ] **Step 4: Run failing tests**

Run: `pnpm -C backend exec tsx --test test/unit/pipeline-orchestrator-chat-events.test.ts 2>&1 | tail -10`
Expected: FAIL on the 2 new trace tests.

- [ ] **Step 5: Wire helpers into runTrace**

In `PipelineOrchestrator.ts`, locate where Trace is invoked in `runTrace` / `confirmPush` / `retryTrace`. Wrap the invocation:

```ts
// Before the Trace agent runs
const traceIteration = await this.appendTraceStarted(pipelineId);

try {
  const result = await agents.trace.process(traceInput);
  if (result.ok && result.output) {
    // persist traceOutput
    await this.store.update(pipelineId, { traceOutput: result.output, stage: '...', ... });
    await this.appendTraceCompleted(pipelineId, traceIteration, result.output);
  } else {
    const code = result.error?.code ?? 'UNKNOWN';
    const msg = result.error?.message ?? 'Trace failed';
    await this.appendTraceFailed(pipelineId, traceIteration, code, msg, 'retry');
    // existing error-path code: set stage failed etc.
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  await this.appendTraceFailed(pipelineId, traceIteration, 'AI_PROVIDER_ERROR', msg, 'retry');
  throw err;
}
```

- [ ] **Step 6: Run tests, expect PASS**

Run: `pnpm -C backend exec tsx --test test/unit/pipeline-orchestrator-chat-events.test.ts 2>&1 | tail -10`
Expected: PASS — 4 tests, 0 fail.

- [ ] **Step 7: Run full unit suite**

Run: `pnpm -C backend test 2>&1 | tail -10`
Expected: PASS, no regressions.

- [ ] **Step 8: Commit**

```bash
git add backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts \
        backend/test/unit/pipeline-orchestrator-chat-events.test.ts
git commit -m "feat(orchestrator): persist trace_started/completed/failed events

Trace runs now append a started event, then either trace_completed or
trace_failed (with errorCode + recoveryAction) to scribe_conversation.
Iteration counter mirrors Proto's logic."
```

---

## Task 4: Backend — Reconciler chat event on timeout

**Files:**
- Modify: `backend/src/pipeline/core/PipelineReconciler.ts:69-82`
- Test: `backend/test/unit/pipeline-reconciler-chat-event.test.ts` (new)

- [ ] **Step 1: Write failing test**

Create `backend/test/unit/pipeline-reconciler-chat-event.test.ts`:

```ts
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';
process.env.AUTH_JWT_SECRET ??= 'test-jwt-secret-at-least-32-chars-long-for-zod';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { PipelineReconciler } from '../../src/pipeline/core/PipelineReconciler.js';
import type { PipelineState, PipelineStage } from '../../src/pipeline/core/contracts/PipelineTypes.js';

function makeStuckStore() {
  const stuck: PipelineState = {
    id: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    stage: 'trace_testing',
    title: 'Sayaç',
    scribeConversation: [
      { type: 'trace_started', content: { iteration: 1 }, timestamp: new Date(Date.now() - 16 * 60_000).toISOString() },
    ],
    scribeOutput: null,
    approvedSpec: null,
    protoOutput: null,
    traceOutput: null,
    traceEnabled: true,
    repoContext: null,
    protoConfig: null,
    jiraConfig: null,
    metrics: {},
    error: null,
    intermediateState: null,
    attemptCount: 0,
    stageVersion: 1,
    createdAt: new Date(Date.now() - 30 * 60_000),
    updatedAt: new Date(Date.now() - 16 * 60_000),
    model: null,
    modelLockedAt: null,
  } as PipelineState;
  const states = new Map([[stuck.id, stuck]]);
  return {
    states,
    stuck,
    async get(id: string) {
      return states.get(id) ?? null;
    },
    async update(id: string, patch: Partial<PipelineState>) {
      const cur = states.get(id)!;
      const next = { ...cur, ...patch, stageVersion: cur.stageVersion + 1, updatedAt: new Date() } as PipelineState;
      states.set(id, next);
      return next;
    },
    async listByUser() {
      return [];
    },
    async create() {
      throw new Error('unused');
    },
    async listStuck(stages: PipelineStage[], olderThan: Date) {
      return [...states.values()]
        .filter((p) => stages.includes(p.stage) && p.updatedAt < olderThan)
        .map((p) => ({ id: p.id, stage: p.stage, updatedAt: p.updatedAt }));
    },
  };
}

describe('PipelineReconciler — chat event on timeout', () => {
  it('appends trace_failed event when a pipeline times out in trace_testing', async () => {
    const store = makeStuckStore();
    const reconciler = new PipelineReconciler(store as any);
    const recovered = await reconciler.sweep();
    assert.equal(recovered, 1);

    const updated = store.states.get(store.stuck.id)!;
    assert.equal(updated.stage, 'failed');
    const failed = updated.scribeConversation.find((m) => m.type === 'trace_failed');
    assert.ok(failed, `expected trace_failed in ${updated.scribeConversation.map((m) => m.type).join(', ')}`);
    assert.equal((failed as any).content.errorCode, 'PIPELINE_TIMEOUT');
    assert.equal((failed as any).content.recoveryAction, 'retry');
    assert.match((failed as any).content.errorMessage, /dakika/);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `pnpm -C backend exec tsx --test test/unit/pipeline-reconciler-chat-event.test.ts 2>&1 | tail -10`
Expected: FAIL — no trace_failed event.

- [ ] **Step 3: Modify Reconciler.sweep**

In `backend/src/pipeline/core/PipelineReconciler.ts`, replace the `for (const p of stuckPipelines)` block (lines 69-82) with:

```ts
for (const p of stuckPipelines) {
  try {
    const stuckMinutes = Math.round((now - p.updatedAt.getTime()) / 60_000);
    const error = createPipelineError(
      PipelineErrorCode.PIPELINE_TIMEOUT,
      `Pipeline ${p.stage} aşamasında ${stuckMinutes} dakikadır yanıt vermiyor. Otomatik olarak durduruldu.`,
    );
    // Re-fetch full state so we can append the chat event atomically with the failure transition.
    const full = await this.store.get(p.id);
    if (!full) continue;

    const eventTypeByStage: Partial<Record<typeof p.stage, 'trace_failed'>> = {
      trace_testing: 'trace_failed',
    };
    const eventType = eventTypeByStage[p.stage];

    const conversation = eventType
      ? [
          ...full.scribeConversation,
          {
            type: eventType,
            content: {
              iteration: full.scribeConversation.filter((m: any) => m.type === 'trace_completed').length + 1,
              errorCode: 'PIPELINE_TIMEOUT',
              errorMessage: `Test yazımı ${stuckMinutes} dakika yanıt vermedi. Otomatik olarak durduruldu.`,
              recoveryAction: 'retry' as const,
            },
            timestamp: new Date().toISOString(),
          },
        ]
      : full.scribeConversation;

    await this.store.update(p.id, { stage: 'failed', error, scribeConversation: conversation });
    recovered++;
    logger.warn(`[Reconciler] Recovered stuck pipeline ${p.id} (was ${p.stage} for ${stuckMinutes}min)`);
  } catch (err) {
    logger.error({ err, pipelineId: p.id }, '[Reconciler] Failed to recover pipeline');
  }
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `pnpm -C backend exec tsx --test test/unit/pipeline-reconciler-chat-event.test.ts 2>&1 | tail -10`
Expected: PASS — 1 test.

- [ ] **Step 5: Run full backend test suite**

Run: `pnpm -C backend test 2>&1 | tail -10`
Expected: no regressions.

- [ ] **Step 6: Commit**

```bash
git add backend/src/pipeline/core/PipelineReconciler.ts \
        backend/test/unit/pipeline-reconciler-chat-event.test.ts
git commit -m "feat(reconciler): chat event when sweeping stuck trace_testing

Appends trace_failed event with errorCode=PIPELINE_TIMEOUT + recoveryAction=retry
alongside the existing stage→failed transition, atomic via single store.update."
```

---

## Task 5: Drop "Claude AI" + IT jargon strings (backend + i18n)

**Files:**
- Modify: `backend/src/pipeline/agents/scribe/ScribeAgent.ts:476`
- Modify: `backend/src/pipeline/agents/proto/ProtoAgent.ts:348,618,848`
- Modify: `backend/src/pipeline/agents/trace/TraceAgent.ts:358`
- Modify: `frontend/src/i18n/locales/tr.json`
- Modify: `frontend/src/i18n/locales/en.json`
- Test: `backend/test/unit/agent-activity-strings.test.ts` (new)

- [ ] **Step 1: Write failing regression-guard test**

Create `backend/test/unit/agent-activity-strings.test.ts`:

```ts
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';
process.env.AUTH_JWT_SECRET ??= 'test-jwt-secret-at-least-32-chars-long-for-zod';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const AGENT_FILES = [
  'backend/src/pipeline/agents/scribe/ScribeAgent.ts',
  'backend/src/pipeline/agents/proto/ProtoAgent.ts',
  'backend/src/pipeline/agents/trace/TraceAgent.ts',
];

describe('Agent activity strings — provider-agnostic + bakkalca', () => {
  it('no "Claude AI" appears in any emit() activity string', () => {
    for (const f of AGENT_FILES) {
      const src = readFileSync(resolve(process.cwd(), f), 'utf-8');
      // Match only inside emit() string literals — code comments OK.
      const matches = src.match(/emit\?\.\(['"]ai_call['"],\s*['"`][^'"`]*Claude AI[^'"`]*['"`]/g);
      assert.equal(matches, null, `${f}: found "Claude AI" in emit() string: ${matches?.join('\n')}`);
    }
  });

  it('no "iskelet" appears in any emit() activity string', () => {
    for (const f of AGENT_FILES) {
      const src = readFileSync(resolve(process.cwd(), f), 'utf-8');
      const matches = src.match(/emit\?\.\(['"]ai_call['"],\s*['"`][^'"`]*iskelet[^'"`]*['"`]/g);
      assert.equal(matches, null, `${f}: found "iskelet" in emit() string: ${matches?.join('\n')}`);
    }
  });

  it('no "Playwright" appears in any emit() activity string', () => {
    for (const f of AGENT_FILES) {
      const src = readFileSync(resolve(process.cwd(), f), 'utf-8');
      const matches = src.match(/emit\?\.\(['"]ai_call['"],\s*['"`][^'"`]*Playwright[^'"`]*['"`]/g);
      assert.equal(matches, null, `${f}: found "Playwright" in emit() string: ${matches?.join('\n')}`);
    }
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `pnpm -C backend exec tsx --test test/unit/agent-activity-strings.test.ts 2>&1 | tail -10`
Expected: FAIL — 3 tests fail with file paths listed.

- [ ] **Step 3: Update ScribeAgent.ts:476**

Run: `sed -n '475,478p' backend/src/pipeline/agents/scribe/ScribeAgent.ts`
Replace `'Claude AI ile fikir analiz ediliyor...'` → `'Fikrini detaylandırıyor...'`

- [ ] **Step 4: Update ProtoAgent.ts (3 lines)**

| Line | Old | New |
|---|---|---|
| 348 | `'Claude AI ile MVP iskeleti oluşturuluyor...'` | `'Proje dosyalarını oluşturuyor...'` |
| 618 | `'Claude AI tool_use ile iskelet oluşturuluyor...'` | `'Proje dosyalarını oluşturuyor...'` |
| 848 | `'Claude AI ile MVP iskeleti oluşturuluyor (fallback)...'` | `'Proje dosyalarını oluşturuyor (yedek yol)...'` |

- [ ] **Step 5: Update TraceAgent.ts:358**

Old (template literal with file count + KB):

```ts
`Claude AI ile Playwright testleri oluşturuluyor (${files.length} dosya, ${Math.round(totalChars / 1024)}KB)...`
```

New:

```ts
`Test senaryolarını hazırlıyor (${files.length} dosya, ${Math.round(totalChars / 1024)}KB)...`
```

Also update line 774 + 778 in TraceAgent.ts (other "Playwright testleri oluşturuluyor (deneme X)..."):

| Line | Old | New |
|---|---|---|
| 774 | `Playwright testleri oluşturuluyor (deneme ${attempt + 1})...` | `Test senaryolarını hazırlıyor (deneme ${attempt + 1})...` |
| 778 | `Playwright testleri oluşturuluyor (deneme ${attempt + 1})...` | `Test senaryolarını hazırlıyor (deneme ${attempt + 1})...` |

- [ ] **Step 6: Run test, expect PASS**

Run: `pnpm -C backend exec tsx --test test/unit/agent-activity-strings.test.ts 2>&1 | tail -10`
Expected: PASS — 3 tests.

- [ ] **Step 7: Update frontend i18n keys**

Run: `grep -nE "scribe\.writing_spec|proto\.creating_scaffold|trace\.writing_scenarios" frontend/src/i18n/locales/tr.json frontend/src/i18n/locales/en.json`

Then update each (TR):

| key | new TR value |
|---|---|
| `pipeline.activity.scribe.writing_spec` | `"Fikrini detaylandırıyor"` |
| `pipeline.activity.proto.creating_scaffold` | `"Proje dosyalarını oluşturuyor"` |
| `pipeline.activity.trace.writing_scenarios` | `"Test senaryolarını hazırlıyor"` |

And (EN):

| key | new EN value |
|---|---|
| `pipeline.activity.scribe.writing_spec` | `"Detailing your idea"` |
| `pipeline.activity.proto.creating_scaffold` | `"Creating project files"` |
| `pipeline.activity.trace.writing_scenarios` | `"Preparing test scenarios"` |

- [ ] **Step 8: Run frontend i18n validity**

Run: `pnpm -C frontend typecheck`
Expected: PASS — i18n type union still satisfied.

- [ ] **Step 9: Commit**

```bash
git add backend/src/pipeline/agents/scribe/ScribeAgent.ts \
        backend/src/pipeline/agents/proto/ProtoAgent.ts \
        backend/src/pipeline/agents/trace/TraceAgent.ts \
        backend/test/unit/agent-activity-strings.test.ts \
        frontend/src/i18n/locales/tr.json \
        frontend/src/i18n/locales/en.json
git commit -m "chore(strings): drop 'Claude AI' + IT jargon from activity copy

5 backend emit() strings + 3 i18n keys. Multi-provider (Claude/OpenAI/
Gemini/OpenRouter) durumda 'Claude AI' yanıltıcı. 'iskelet' ve 'Playwright'
bakkal personası için anlamsız jargon. Yeni:
- Scribe → 'Fikrini detaylandırıyor'
- Proto  → 'Proje dosyalarını oluşturuyor'
- Trace  → 'Test senaryolarını hazırlıyor'

Regex regression guard test added (agent-activity-strings.test.ts)."
```

---

## Task 6: Frontend — extend ConversationMessage + map new events

**Files:**
- Modify: `frontend/src/types/workflow.ts:78-138`
- Modify: `frontend/src/services/api/workflows.ts` (`mapPipelineToConversation`)
- Test: `frontend/src/services/api/__tests__/workflows.test.ts` (extend)

- [ ] **Step 1: Extend ConversationMessage type union**

In `frontend/src/types/workflow.ts:80`, replace the `type` enum to add new values:

```ts
type:
  | 'message'
  | 'clarification'
  | 'spec'
  | 'proto_result'
  | 'trace_result'
  | 'error'
  | 'proto_started'      // NEW
  | 'trace_started'      // NEW
  | 'trace_failed';      // NEW
```

Add new optional fields below the existing `traceResult?: { ... }`:

```ts
  // Chat event-log
  iteration?: number;
  errorCode?: string;
  errorMessage?: string;
  recoveryAction?: 'retry' | 'skip';
```

- [ ] **Step 2: Write failing test for mapPipelineToConversation**

In `frontend/src/services/api/__tests__/workflows.test.ts`, add:

```ts
describe('mapPipelineToConversation — chat event-log proxy', () => {
  it('maps proto_started/proto_completed/trace_started/trace_completed/trace_failed from scribeConversation', () => {
    const pipeline = {
      id: 'p1',
      stage: 'failed',
      scribeConversation: [
        { type: 'user_idea', content: 'idea' },
        { type: 'spec_approved', content: { title: 'X', userStories: [] } },
        { type: 'proto_started', content: { iteration: 1 }, timestamp: '2026-05-22T10:00:00Z' },
        { type: 'proto_completed', content: { iteration: 1, summary: 'Done.', filesCreated: 5, totalLines: 100, branch: 'main' }, timestamp: '2026-05-22T10:01:00Z' },
        { type: 'trace_started', content: { iteration: 1 }, timestamp: '2026-05-22T10:02:00Z' },
        { type: 'trace_failed', content: { iteration: 1, errorCode: 'PIPELINE_TIMEOUT', errorMessage: 'Test yazımı 15 dakika yanıt vermedi.', recoveryAction: 'retry' }, timestamp: '2026-05-22T10:17:00Z' },
      ],
      error: { code: 'PIPELINE_TIMEOUT', message: 'X', retryable: true },
      metrics: {},
    } as any;

    const { mapPipelineToConversation } = require('../workflows');
    const msgs = mapPipelineToConversation(pipeline);
    const types = msgs.map((m: any) => m.type);
    assert(types.includes('proto_started'));
    assert(types.includes('proto_result'));
    assert(types.includes('trace_started'));
    assert(types.includes('trace_failed'));

    const failed = msgs.find((m: any) => m.type === 'trace_failed');
    expect(failed.errorCode).toBe('PIPELINE_TIMEOUT');
    expect(failed.recoveryAction).toBe('retry');
  });
});
```

(Adjust to use vitest's `expect` rather than node assert if the file uses vitest — check existing test imports.)

- [ ] **Step 3: Run failing test**

Run: `pnpm -C frontend test -- --run src/services/api/__tests__/workflows.test.ts 2>&1 | tail -15`
Expected: FAIL on the new test.

- [ ] **Step 4: Implement mapping in workflows.ts**

In `frontend/src/services/api/workflows.ts`, inside `mapPipelineToConversation`, add cases inside the `for (const msg of scribeConv)` loop:

```ts
case 'proto_started':
  messages.push({
    role: 'system',
    type: 'proto_started',
    content: '',
    timestamp: msg.timestamp ?? new Date().toISOString(),
    iteration: msg.content.iteration,
  });
  break;
case 'proto_completed':
  messages.push({
    role: 'proto',
    type: 'proto_result',
    content: msg.content.summary,
    timestamp: msg.timestamp ?? new Date().toISOString(),
    iteration: msg.content.iteration,
    protoResult: {
      branch: msg.content.branch ?? '',
      repo: '',
      files: [],
      totalFiles: msg.content.filesCreated,
      totalLines: msg.content.totalLines,
      summary: msg.content.summary,
    },
  });
  break;
case 'trace_started':
  messages.push({
    role: 'system',
    type: 'trace_started',
    content: '',
    timestamp: msg.timestamp ?? new Date().toISOString(),
    iteration: msg.content.iteration,
  });
  break;
case 'trace_completed':
  messages.push({
    role: 'trace',
    type: 'trace_result',
    content: `Test yazıldı — ${msg.content.totalTests} test, %${msg.content.coverage}`,
    timestamp: msg.timestamp ?? new Date().toISOString(),
    iteration: msg.content.iteration,
    traceResult: {
      testCount: msg.content.totalTests,
      passing: msg.content.totalTests,
      failing: 0,
      coverage: `${msg.content.coverage}%`,
      duration: '',
      testFiles: [],
    },
  });
  break;
case 'trace_failed':
  messages.push({
    role: 'system',
    type: 'trace_failed',
    content: msg.content.errorMessage,
    timestamp: msg.timestamp ?? new Date().toISOString(),
    iteration: msg.content.iteration,
    errorCode: msg.content.errorCode,
    errorMessage: msg.content.errorMessage,
    recoveryAction: msg.content.recoveryAction,
  });
  break;
```

- [ ] **Step 5: Run test, expect PASS**

Run: `pnpm -C frontend test -- --run src/services/api/__tests__/workflows.test.ts 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 6: Run full frontend test suite**

Run: `pnpm -C frontend test 2>&1 | tail -10`
Expected: existing snapshot-based tests still pass (no regression — snapshot fallback still runs at Task 7).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/types/workflow.ts \
        frontend/src/services/api/workflows.ts \
        frontend/src/services/api/__tests__/workflows.test.ts
git commit -m "feat(frontend): proxy chat event-log types in mapPipelineToConversation

proto_started, proto_completed, trace_started, trace_completed, trace_failed
from scribe_conversation jsonb become ConversationMessage entries with the
iteration counter + errorCode/recoveryAction surfaced as new optional fields."
```

---

## Task 7: Frontend — gate snapshot fallback + render new ChatMessage types

**Files:**
- Modify: `frontend/src/services/api/workflows.ts` (snapshot fallback gate)
- Modify: `frontend/src/types/chat.ts` (extend ChatMessage union)
- Modify: `frontend/src/utils/conversationToChatMessages.ts`
- Test: `frontend/src/services/api/__tests__/workflows.test.ts` (snapshot gating)
- Test: `frontend/src/utils/__tests__/conversationToChatMessages.test.ts` (new types)

- [ ] **Step 1: Find ChatMessage type definition**

Run: `grep -n "export type ChatMessage\|export interface ChatMessage" frontend/src/types/chat.ts | head -5`

- [ ] **Step 2: Extend ChatMessage union**

Add a new variant to `ChatMessage`:

```ts
| {
    type: 'trace_failure';
    errorCode: string;
    errorMessage: string;
    recoveryAction?: 'retry' | 'skip';
    iteration?: number;
    timestamp: string;
  }
```

(`proto_started`/`trace_started` reuse existing `agent_started` ChatMessage variant — no new type needed there.)

- [ ] **Step 3: Write failing tests for conversationToChatMessages**

In `frontend/src/utils/__tests__/conversationToChatMessages.test.ts`, add:

```ts
describe('chat event-log mapping', () => {
  it('maps proto_started ConversationMessage to agent_started ChatMessage', () => {
    const msgs = conversationToChatMessages(
      [
        { role: 'system', type: 'proto_started', content: '', timestamp: 't1', iteration: 1 },
      ] as any,
      'proto_building',
    );
    const started = msgs.find((m) => m.type === 'agent_started' && (m as any).agent === 'proto');
    expect(started).toBeDefined();
  });

  it('maps trace_failed ConversationMessage to trace_failure ChatMessage with errorCode', () => {
    const msgs = conversationToChatMessages(
      [
        { role: 'system', type: 'trace_failed', content: 'timeout',
          timestamp: 't1', iteration: 1, errorCode: 'PIPELINE_TIMEOUT',
          errorMessage: 'Test yazımı 15 dakika yanıt vermedi.',
          recoveryAction: 'retry' },
      ] as any,
      'failed',
    );
    const fail = msgs.find((m) => m.type === 'trace_failure');
    expect(fail).toBeDefined();
    expect((fail as any).errorCode).toBe('PIPELINE_TIMEOUT');
    expect((fail as any).recoveryAction).toBe('retry');
  });

  it('renders proto_completed iterations as separate proto_result rows (no override)', () => {
    const msgs = conversationToChatMessages(
      [
        { role: 'proto', type: 'proto_result', content: 'v1', timestamp: 't1', iteration: 1,
          protoResult: { branch: 'main', repo: '', files: [], totalFiles: 3, totalLines: 50, summary: 'v1' } },
        { role: 'proto', type: 'proto_result', content: 'v2', timestamp: 't2', iteration: 2,
          protoResult: { branch: 'main', repo: '', files: [], totalFiles: 5, totalLines: 80, summary: 'v2' } },
      ] as any,
      'completed',
    );
    const results = msgs.filter((m) => m.type === 'test_result' || m.type === 'plan' || (m as any).agent === 'proto');
    // Both turns survive — no override
    const protoTurns = msgs.filter((m) => (m as any).type === 'agent' && (m as any).agent === 'proto')
      .concat(msgs.filter((m) => (m as any).type === 'plan'));
    // Adjust assertion based on actual mapping: at minimum 2 messages mention v1 and v2
    const summaries = msgs.map((m) => JSON.stringify(m)).filter((s) => s.includes('v1') || s.includes('v2'));
    expect(summaries.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 4: Run failing tests**

Run: `pnpm -C frontend test -- --run src/utils/__tests__/conversationToChatMessages.test.ts 2>&1 | tail -15`
Expected: FAIL on new tests.

- [ ] **Step 5: Add mapping cases in conversationToChatMessages.ts**

In the `for (const m of conv)` loop, add cases at the appropriate `switch` branches:

```ts
case 'system':
  // ... existing handling
  if (m.type === 'proto_started') {
    pushAgentStarted('proto', 'started', ts);
    break;
  }
  if (m.type === 'trace_started') {
    pushAgentStarted('trace', 'started', ts);
    break;
  }
  if (m.type === 'trace_failed') {
    msgs.push({
      type: 'trace_failure',
      errorCode: m.errorCode ?? 'UNKNOWN',
      errorMessage: m.errorMessage ?? m.content,
      recoveryAction: m.recoveryAction,
      iteration: m.iteration,
      timestamp: ts,
    });
    break;
  }
  // ... existing info-content fallback
  msgs.push({ type: 'info', content: m.content, timestamp: ts });
  break;
```

For `proto_result` rows: the existing `case 'proto'` already handles them; iteration counter is now on the ConversationMessage so attach it onto the plan / agent message metadata (one-line addition where `msgs.push({...})` is built for proto_result rendering).

- [ ] **Step 6: Gate snapshot fallback in workflows.ts**

In `frontend/src/services/api/workflows.ts` — around line 256 where `pipeline.protoOutput?.ok` synthesizes a proto_result message — wrap the block:

```ts
const hasProtoEventLog = scribeConv.some((m: any) => m.type === 'proto_completed');
if (!hasProtoEventLog && pipeline.protoOutput?.ok) {
  // ... existing snapshot synthesis (NF-1 backward compat)
}

const hasTraceEventLog = scribeConv.some((m: any) => m.type === 'trace_completed' || m.type === 'trace_failed');
if (!hasTraceEventLog && pipeline.traceOutput) {
  // ... existing trace snapshot synthesis
} else if (!hasTraceEventLog && /* existing fallback condition for awaiting_push_confirm etc. */ ...) {
  // ... existing "Trace test üretimi tamamlanamadı" synthesis
}
```

- [ ] **Step 7: Run all related tests, expect PASS**

Run: `pnpm -C frontend test -- --run src/utils/__tests__/conversationToChatMessages.test.ts src/services/api/__tests__/workflows.test.ts 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/types/chat.ts \
        frontend/src/utils/conversationToChatMessages.ts \
        frontend/src/services/api/workflows.ts \
        frontend/src/utils/__tests__/conversationToChatMessages.test.ts \
        frontend/src/services/api/__tests__/workflows.test.ts
git commit -m "feat(frontend): render chat event-log types + gate snapshot fallback

- ChatMessage gains 'trace_failure' variant
- conversationToChatMessages maps proto_started/trace_started/trace_failed
- mapPipelineToConversation skips snapshot synthesis when event-log is present
  (NF-1: eski pipeline'lar için fallback korunur)
- Iterasyon mesajları artık override edilmiyor — her tur ayrı satır olarak
  scribe_conversation'da persist ediliyor"
```

---

## Task 8: Frontend — render TraceFailure chat row with action buttons

**Files:**
- Locate: `frontend/src/components/chat/ChatPanel.tsx` (or the file that switch-renders ChatMessage types)
- Create: `frontend/src/components/chat/TraceFailureMessage.tsx`
- Modify: ChatPanel switch / dispatcher
- Test: `frontend/src/components/chat/__tests__/TraceFailureMessage.test.tsx` (new)

- [ ] **Step 1: Find the switch that dispatches ChatMessage types**

Run: `grep -rn "type === 'agent_started'\|type === 'plan'\|type === 'test_result'" frontend/src/components/chat/ | head -5`
Expected: a file containing a switch/conditional block per ChatMessage.type.

- [ ] **Step 2: Write failing component test**

Create `frontend/src/components/chat/__tests__/TraceFailureMessage.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TraceFailureMessage } from '../TraceFailureMessage';

describe('TraceFailureMessage', () => {
  it('shows error message + Tekrar Dene + Trace olmadan devam et buttons when recoveryAction=retry', () => {
    const onRetry = vi.fn();
    const onSkipTrace = vi.fn();
    render(
      <TraceFailureMessage
        errorCode="PIPELINE_TIMEOUT"
        errorMessage="Test yazımı 15 dakika yanıt vermedi."
        recoveryAction="retry"
        onRetry={onRetry}
        onSkipTrace={onSkipTrace}
      />
    );
    expect(screen.getByText(/15 dakika yanıt vermedi/)).toBeInTheDocument();
    expect(screen.getByText(/Tekrar Dene/i)).toBeInTheDocument();
    expect(screen.getByText(/Trace.*devam/i)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/Tekrar Dene/i));
    expect(onRetry).toHaveBeenCalled();

    fireEvent.click(screen.getByText(/Trace.*devam/i));
    expect(onSkipTrace).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run failing test**

Run: `pnpm -C frontend test -- --run src/components/chat/__tests__/TraceFailureMessage.test.tsx 2>&1 | tail -10`
Expected: FAIL — module not found.

- [ ] **Step 4: Create the component**

Create `frontend/src/components/chat/TraceFailureMessage.tsx`:

```tsx
import { useTranslation } from 'react-i18next';

export interface TraceFailureMessageProps {
  errorCode: string;
  errorMessage: string;
  recoveryAction?: 'retry' | 'skip';
  onRetry: () => void;
  onSkipTrace: () => void;
}

export function TraceFailureMessage({
  errorCode,
  errorMessage,
  recoveryAction,
  onRetry,
  onSkipTrace,
}: TraceFailureMessageProps) {
  const { t } = useTranslation();
  const isTimeout = errorCode === 'PIPELINE_TIMEOUT';
  return (
    <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50">
      <div className="text-amber-600 dark:text-amber-400" aria-hidden>⚠</div>
      <div className="flex-1 space-y-2">
        <div className="text-sm font-medium text-amber-900 dark:text-amber-100">
          {isTimeout ? t('chat.trace_failure.timeout_title') : t('chat.trace_failure.error_title')}
        </div>
        <div className="text-sm text-amber-800 dark:text-amber-200">{errorMessage}</div>
        {recoveryAction === 'retry' && (
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onRetry}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-amber-600 text-white hover:bg-amber-700"
            >
              {t('chat.trace_failure.retry')}
            </button>
            <button
              type="button"
              onClick={onSkipTrace}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-white border border-amber-300 text-amber-800 hover:bg-amber-50 dark:bg-amber-950/50 dark:text-amber-100"
            >
              {t('chat.trace_failure.skip')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

Add i18n keys to `frontend/src/i18n/locales/tr.json`:

```json
"chat.trace_failure.timeout_title": "İşlem zaman aşımına uğradı",
"chat.trace_failure.error_title": "Test yazımı tamamlanamadı",
"chat.trace_failure.retry": "Tekrar Dene",
"chat.trace_failure.skip": "Trace'siz devam et"
```

And `en.json`:

```json
"chat.trace_failure.timeout_title": "Operation timed out",
"chat.trace_failure.error_title": "Test generation failed",
"chat.trace_failure.retry": "Retry",
"chat.trace_failure.skip": "Continue without Trace"
```

Add these key strings to `frontend/src/i18n/i18n.types.ts` union too (find the existing string union and add the new keys).

- [ ] **Step 5: Wire into ChatPanel switch**

In the ChatPanel (or wherever the message dispatcher lives), add:

```tsx
case 'trace_failure':
  return (
    <TraceFailureMessage
      key={idx}
      errorCode={m.errorCode}
      errorMessage={m.errorMessage}
      recoveryAction={m.recoveryAction}
      onRetry={onRetry}
      onSkipTrace={onSkipTrace}
    />
  );
```

`onRetry` / `onSkipTrace` already exist on the pipeline-controls hook (`usePipelineControls`). Pass them through if not already in scope.

- [ ] **Step 6: Run component test, expect PASS**

Run: `pnpm -C frontend test -- --run src/components/chat/__tests__/TraceFailureMessage.test.tsx 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 7: Run typecheck**

Run: `pnpm -C frontend typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/chat/TraceFailureMessage.tsx \
        frontend/src/components/chat/__tests__/TraceFailureMessage.test.tsx \
        frontend/src/components/chat/ChatPanel.tsx \
        frontend/src/i18n/locales/tr.json \
        frontend/src/i18n/locales/en.json \
        frontend/src/i18n/i18n.types.ts
git commit -m "feat(chat): TraceFailureMessage with Tekrar Dene + Trace'siz devam et

Inline chat row that surfaces trace_failed events with recovery actions
(retry vs skip-trace). Renders only when recoveryAction is set; otherwise
just the error message. Wired into ChatPanel dispatcher."
```

---

## Task 9: Frontend — failed-state stage card label (F-1)

**Files:**
- Modify: `frontend/src/services/api/workflows.ts` (`mapPipelineToWorkflow` failed-state branch around line 394-409)
- Test: `frontend/src/services/api/__tests__/workflows.test.ts` (extend)

- [ ] **Step 1: Write failing test**

In `frontend/src/services/api/__tests__/workflows.test.ts`:

```ts
describe('mapPipelineToWorkflow — failed-state stage labels', () => {
  it('marks trace stage failed with timeout label when pipeline.stage=failed + errorCode=PIPELINE_TIMEOUT and protoOutput exists', () => {
    const pipeline = {
      id: 'p1',
      stage: 'failed',
      scribeConversation: [],
      protoOutput: { ok: true, files: [], branch: 'main', repo: '', metadata: { filesCreated: 5, totalLinesOfCode: 100 } },
      traceOutput: null,
      error: { code: 'PIPELINE_TIMEOUT', message: 'X', retryable: true },
      traceEnabled: true,
      metrics: {},
    } as any;
    const { mapPipelineToWorkflow } = require('../workflows');
    const w = mapPipelineToWorkflow(pipeline);
    expect(w.stages.trace.status).toBe('failed');
    expect(w.stages.trace.error).toMatch(/zaman aşımı/i);
  });

  it('marks proto stage failed when no protoOutput and pipeline.stage=failed', () => {
    const pipeline = {
      id: 'p1',
      stage: 'failed',
      scribeConversation: [],
      approvedSpec: { title: 'X', userStories: [] },
      protoOutput: null,
      traceOutput: null,
      error: { code: 'AI_PROVIDER_ERROR', message: 'rate limit', retryable: true },
      traceEnabled: true,
      metrics: {},
    } as any;
    const { mapPipelineToWorkflow } = require('../workflows');
    const w = mapPipelineToWorkflow(pipeline);
    expect(w.stages.proto.status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `pnpm -C frontend test -- --run src/services/api/__tests__/workflows.test.ts 2>&1 | tail -10`
Expected: FAIL on new tests.

- [ ] **Step 3: Extend mapPipelineToWorkflow failed-state mapping**

In `frontend/src/services/api/workflows.ts` around line 394-409, extend the `if (pipeline.error)` block to include `pipeline.stage === 'failed'`:

```ts
if (pipeline.error) {
  if (pipeline.stage === 'failed') {
    // Determine which stage failed from cumulative outputs (event-log truthier than stage name).
    const isTimeout = pipeline.error.code === 'PIPELINE_TIMEOUT';
    const label = isTimeout
      ? 'Zaman aşımı'
      : (pipeline.error.message ?? 'Hata');
    if (pipeline.protoOutput && !pipeline.traceOutput) {
      stages.trace.status = 'failed';
      stages.trace.error = label;
    } else if (pipeline.approvedSpec && !pipeline.protoOutput) {
      stages.proto.status = 'failed';
      stages.proto.error = label;
    } else {
      stages.scribe.status = 'failed';
      stages.scribe.error = label;
    }
  } else if (pipeline.stage === 'completed_partial') {
    stages.trace.status = 'failed';
    stages.trace.error = pipeline.error.message;
  } else if (stages.trace.status === 'running' || pipeline.stage === 'trace_testing') {
    stages.trace.status = 'failed';
    stages.trace.error = pipeline.error.message;
  } else if (stages.proto.status === 'running' || pipeline.stage === 'proto_building') {
    stages.proto.status = 'failed';
    stages.proto.error = pipeline.error.message;
  } else if (stages.scribe.status === 'running') {
    stages.scribe.status = 'failed';
    stages.scribe.error = pipeline.error.message;
  }
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm -C frontend test -- --run src/services/api/__tests__/workflows.test.ts 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Run full frontend suite**

Run: `pnpm -C frontend test 2>&1 | tail -10`
Expected: PASS, no regressions (existing failed-stage tests for trace_testing/proto_building still hit the unchanged else-if branches).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/services/api/workflows.ts \
        frontend/src/services/api/__tests__/workflows.test.ts
git commit -m "fix(chat): map failed stage card with errorCode-based label (F-1)

When pipeline.stage='failed' and pipeline.error is set, the upper panel
3-card view now marks the correct stage as failed with 'Zaman aşımı' (for
PIPELINE_TIMEOUT) or the error message (for other codes). Previously the
failed branch was missing from mapPipelineToWorkflow's error mapping, so
the Trace card kept showing 'Claude AI ile Playwright testleri oluşturuluyor'."
```

---

## Task 10: Frontend — Proto chat row leads with summary (F-6)

**Files:**
- Locate: the file that renders `ChatMessage.type === 'plan'` or proto's content card
- Test: existing snapshot test in `frontend/src/components/chat/__tests__/ChatMessage.test.tsx` or similar

- [ ] **Step 1: Find Proto row renderer**

Run: `grep -rn "Scaffold oluşturuldu\|protoResult\|metadata.filesCreated" frontend/src/components/chat/ | head -10`

- [ ] **Step 2: Write failing test**

In the located file's __tests__ directory, add:

```tsx
it('Proto row leads with summary text and shows file/line count as secondary metadata', () => {
  render(
    <ProtoMessageRow
      content="Sayaç için React projesi hazırladım. Artırma/azaltma/sıfırla butonları çalışıyor."
      filesCreated={15}
      totalLines={552}
    />
  );
  const summary = screen.getByText(/Sayaç için React projesi/);
  expect(summary).toBeInTheDocument();
  // Metadata should be present but lower visual weight (look for the joined string)
  expect(screen.getByText(/15 dosya/)).toBeInTheDocument();
  expect(screen.getByText(/552 satır/)).toBeInTheDocument();
  // Summary appears BEFORE the metadata in DOM order
  const order = screen.getByText(/Sayaç için/).compareDocumentPosition(screen.getByText(/15 dosya/));
  expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
```

- [ ] **Step 3: Run failing test**

Run: `pnpm -C frontend test -- --run src/components/chat/__tests__/<file>.test.tsx 2>&1 | tail -10`
Expected: FAIL (component currently leads with metadata).

- [ ] **Step 4: Update Proto row component**

Refactor the existing Proto message renderer:

```tsx
<div className="space-y-2">
  <div className="text-sm text-zinc-700 dark:text-zinc-200">
    {content || 'Proje dosyaları hazır.'}
  </div>
  <div className="text-xs text-zinc-500 dark:text-zinc-400">
    {filesCreated} dosya · {totalLines} satır
    {branch ? ` · ${branch}` : ''}
    {previewAvailable && (
      <>
        {' · '}
        <button onClick={onOpenPreview} className="underline">
          Önizle
        </button>
      </>
    )}
  </div>
</div>
```

- [ ] **Step 5: Run test, expect PASS**

Run: `pnpm -C frontend test -- --run src/components/chat/__tests__/<file>.test.tsx 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/chat/<file>.tsx \
        frontend/src/components/chat/__tests__/<file>.test.tsx
git commit -m "feat(chat): Proto row leads with summary, metadata secondary (F-6)

Non-developer kullanıcı için '15 dosya, 552 satır' yerine
protoOutput.summary ('Sayaç için React projesi hazırladım. Artırma...')
öne çıkar; teknik metadata altta küçük puntoyla."
```

---

## Task 11: Manual e2e verification

**Files:** None (Playwright session).

- [ ] **Step 1: Restart dev stack with clean state**

Run: `./scripts/dev-down.sh && ./scripts/dev-up.sh`
Wait until: `tail -1 backend.log` shows `Server listening on :3000`.

- [ ] **Step 2: Run a Sayaç-style pipeline that will time out (or simulate)**

Open the app via Playwright as `admin1@admin.com`, start a "basit sayaç uygulaması" idea. Approve the spec. Let Proto complete.

To simulate a Trace timeout fast (avoid waiting 15 min), connect to DB and manually invoke the reconciler with shortened threshold (Or: temporarily set the env `STUCK_THRESHOLD_MS=10_000` in code, restart, wait 15s; revert).

Alternative: run an existing failed pipeline by querying:

```sql
SELECT id FROM pipelines WHERE stage='failed' AND error->>'code'='PIPELINE_TIMEOUT' LIMIT 1;
```

Open that conversation in the app.

- [ ] **Step 3: Verify AC-1**

Pipeline detail panel shows 3 cards: Scribe ✓, Proto ✓, **Trace ✗ Zaman aşımı**. Take screenshot.

- [ ] **Step 4: Verify AC-2, AC-3, AC-4**

Scroll the chat timeline. Verify:
- "Proto başlatıldı" satırı görünür (between spec approval and Proto result)
- "Trace başlatıldı" satırı görünür (after Proto result)
- "Test yazımı 15 dakika yanıt vermedi. Otomatik olarak durduruldu." with [Tekrar Dene] + [Trace'siz devam et] buttons

- [ ] **Step 5: Verify AC-5 (run iteration)**

In a fresh conversation, after Proto completes, send a "geri bildirim" type message that triggers iterate-with-feedback. Verify second Proto row appears with "(2. tur)" label and the first row is still visible.

- [ ] **Step 6: Verify AC-6 (mid-pipeline user message)**

While Proto is running, send a message. Verify it lands in the timeline with its own timestamp (not at the bottom of the eventual snapshot, but between the Proto events).

- [ ] **Step 7: Verify AC-7 (summary leads)**

Inspect a Proto message — the human-language summary appears first; "X dosya · Y satır" is below in smaller type.

- [ ] **Step 8: Verify AC-8 (backward compat)**

Open an older pipeline (one that completed before this PR). Verify chat still renders with the old snapshot-derived messages (Proto + Trace results visible normally).

- [ ] **Step 9: Verify AC-9 (provider-agnostic strings)**

In an in-flight Proto run, verify the activity line reads "Proto — Proje dosyalarını oluşturuyor..." (no "Claude AI", no "iskelet"). Same check for Trace ("Test senaryolarını hazırlıyor", not "Playwright").

- [ ] **Step 10: Create PR**

```bash
git push -u origin feat/chat-event-log
gh pr create --title "feat(chat): timeline event-log + failed-state UX + provider-agnostic copy" \
  --body "$(cat <<'EOF'
## Summary

Sayaç session bulgularına yanıt — chat timeline artık event-log driven:

- Proto/Trace başlama, tamamlanma, timeout/failure event'leri scribe_conversation jsonb'a persist ediliyor (F-2/F-3)
- Iterasyon mesajları override edilmiyor; her tur ayrı satır (F-4)
- Üst panelde pipeline `failed` ise hata yapan stage kartı doğru etiketle gösteriliyor (F-1)
- Mid-pipeline user notu chat'te kronolojik sırada görünüyor (F-5)
- Proto satırı human-language summary ile başlıyor (F-6)
- 5 hardcoded "Claude AI ile..." string'i + IT jargonu (iskelet, Playwright) provider-agnostik bakkalca Türkçe ile değiştirildi (F-7)

Spec: docs/superpowers/specs/2026-05-22-chat-timeline-event-log-design.md

## Test plan

- [ ] Backend unit tests green (`pnpm -C backend test`)
- [ ] Frontend unit tests green (`pnpm -C frontend test`)
- [ ] Manual e2e: Sayaç-style timeout pipeline → upper panel + chat events doğru
- [ ] Manual e2e: iterasyon → eski Proto satırı silinmiyor
- [ ] Manual e2e: mid-pipeline mesaj → kronolojik sırada
- [ ] Eski pipeline (event-log'suz) backward compat çalışıyor
EOF
)"
```

---

## Self-Review Notes

**Spec coverage check** (her gereksinim için task var mı?):

| Req | Task | Status |
|---|---|---|
| F-1 Failed stage card | Task 9 | ✓ |
| F-2 Proto/Trace started events | Tasks 2, 3 + Task 7 (render) | ✓ |
| F-3 Trace timeout chat row + actions | Tasks 4 + 7 + 8 | ✓ |
| F-4 Iteration messages append | Tasks 2, 3 (backend) + Task 7 (frontend gating) | ✓ |
| F-5 Mid-pipeline user note visible | Already works via user_note → user message render. Verified in Task 11 step 6. | ✓ |
| F-6 Proto summary leads | Task 10 | ✓ |
| F-7 Provider-agnostic strings | Task 5 | ✓ |
| NF-1 Backward compat | Task 7 (snapshot gate) + Task 11 step 8 verification | ✓ |
| NF-2 Atomic appends | All backend tasks use single `store.update` call | ✓ |
| NF-3 Integrated render | Tasks 6, 7 (event + snapshot in same pipeline) | ✓ |
| AC-1..AC-9 | All mapped to verification in Task 11 | ✓ |

**Placeholder scan:** Task 8 step 5 says `usePipelineControls` already exposes onRetry/onSkipTrace — confirm before implementation. Task 10 steps 1, 4, 5 use `<file>` placeholder because the renderer file location is grep'd at runtime. Implementer should resolve via Task 10 step 1.

**Type consistency:** `iteration` field is `number` everywhere. `recoveryAction` is `'retry' | 'skip'` everywhere. `errorCode` is `string` everywhere. Helper names `appendProtoStarted` / `appendProtoCompleted` / `appendTrace*` consistent across Tasks 2, 3.

---

## Execution

**Branch already exists:** `feat/chat-event-log` (main'den ayrıldı, üzerinde 2 commit var — spec + F-7 ekleme).

**Branching strategy:** Tasks 1-11 hepsi aynı branch'e commit'lenir, sonra tek PR (Task 11 step 10).

**Estimated effort:** 11 task × ~15-25 dk = ~3-4 saat (AI-assisted hızla). Backend tasks (1-5) bağımsız, paralel subagent'larla hızlandırılabilir; frontend (6-10) sıralı çünkü 7 ↔ 6 bağımlı, 8 ↔ 7 bağımlı, 9 bağımsız ama aynı dosyaya dokunduğu için 6-7'den sonra.
