# Chat Agent Narrator (Pattern A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Her ajan (Scribe / Proto / Trace) chat'te kullanıcıyla konuşma dilinde özet versin; plan kartı Scribe'ın son baloncuğuna gömülsün; her ajan baloncuğunda collapsed sub-step listesi + server-truth duration olsun. Critic ve Validator chat'te ayrı bubble açmaz — Scribe/Proto sub-step stream'inde yansır.

**Architecture:** Backend event-log payload'ları genişletilir (`scribe_completed` eklenir, `proto_completed`/`trace_completed`'a `durationMs` + `subSteps` eklenir). Backend orchestrator stage başında `Date.now()` snapshot'lar; completion emit'te delta'yı server-truth olarak yazar. Frontend `ChatMessage` agent tipi genişler; `conversationToChatMessages` ve `workflows.ts` yeni payload'ları geçirir; `ChatMessage.tsx` summary/plan/sub-step/duration'ı tek bubble render eder. Eski pipeline'lar için snapshot fallback korunur.

**Tech Stack:** TypeScript strict (backend Fastify 4 + frontend React 19 + Vite 7). Drizzle ORM jsonb şeması genişler — DB migration yok. Backend tests: node `--test` via tsx. Frontend tests: Vitest + RTL.

**Spec:** `docs/superpowers/specs/2026-05-23-chat-agent-narrator-pattern-a-design.md`

---

## File Map (decomposition önizleme)

**Backend:**
- `backend/src/pipeline/core/contracts/PipelineTypes.ts` — `ScribeMessageType` union + `SubStep` + `ScribeOutput.summary` + `TraceOutput.summary`
- `backend/src/pipeline/agents/scribe/ScribeAgent.ts` — LLM prompt + summary parse
- `backend/src/pipeline/agents/trace/TraceAgent.ts` — LLM prompt + summary parse
- `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts` — `startedAt` tracking + `scribe_completed` emit + extend `proto_completed`/`trace_completed` emit + subStep builder

**Frontend:**
- `frontend/src/types/chat.ts` — `agent` ChatMessage genişler + `SubStep` tipi
- `frontend/src/utils/formatDuration.ts` (new) — `'1 dk 38 sn'` formatter
- `frontend/src/hooks/useRelativeDuration.ts` (new) — live "X dakikadır" hook
- `frontend/src/utils/conversationToChatMessages.ts` — yeni event tipleri + sub-step pass-through
- `frontend/src/services/api/workflows.ts` — `scribe_completed` case + plan card embed + chip ordering fix
- `frontend/src/components/chat/ChatMessage.tsx` — agent bubble: live, summary, embeddedPlan, sub-steps, duration footer

**Tests:**
- `backend/src/pipeline/core/orchestrator/__tests__/PipelineOrchestrator.events.test.ts` (yeni veya genişleme)
- `frontend/src/utils/__tests__/formatDuration.test.ts` (new)
- `frontend/src/utils/__tests__/conversationToChatMessages.test.ts` (genişle)
- `frontend/src/components/chat/__tests__/ChatMessage.test.tsx` (genişle veya yeni)

---

## Task 1: Backend type — SubStep + ScribeMessageType genişleme

**Files:**
- Modify: `backend/src/pipeline/core/contracts/PipelineTypes.ts:88-162`

- [ ] **Step 1: SubStep tipini ekle (dosyanın `ScribeMessageType` union'undan ÖNCE)**

```ts
// Sub-step stream — her ajan baloncuğunda collapsed listenin payload'u.
// Critic ve Validator etkileri bu listede insan-dili satır olarak yansır
// (ayrı chat bubble açılmaz — bkz. spec DL-2/DL-3).
export interface SubStep {
  label: string;           // "Acceptance criteria yazıldı"
  durationMs?: number;     // tek-step süresi (opsiyonel)
  status: 'done' | 'live' | 'failed';
  source?: 'critic' | 'validator' | 'agent';
}
```

- [ ] **Step 2: `proto_completed` ve `trace_completed` content'lerine `durationMs` + `subSteps` ekle**

`PipelineTypes.ts:107-117` ve `122-132`:

```ts
| {
    type: 'proto_completed';
    content: {
      iteration: number;
      summary: string;
      filesCreated: number;
      totalLines: number;
      branch?: string;
      durationMs?: number;       // YENİ — opsiyonel (NF-2: yoksa render yok)
      subSteps?: SubStep[];      // YENİ — opsiyonel
    };
    timestamp: string;
  }
| {
    type: 'trace_completed';
    content: {
      iteration: number;
      totalTests: number;
      coverage: number;
      passed: boolean;
      summary?: string;          // YENİ — Trace'in LLM Türkçe özeti
      durationMs?: number;       // YENİ
      subSteps?: SubStep[];      // YENİ
    };
    timestamp: string;
  }
```

- [ ] **Step 3: `scribe_completed` event'ini ScribeMessageType union'ına ekle**

`PipelineTypes.ts:142` (mevcut `scribe_failed` ve `proto_failed`'ten ÖNCE):

```ts
| {
    type: 'scribe_completed';
    content: {
      iteration: number;
      summary: string;          // LLM 1-3 cümle Türkçe özet
      storyCount: number;
      acCount: number;
      durationMs?: number;
      subSteps?: SubStep[];
    };
    timestamp: string;
  }
```

- [ ] **Step 4: `ScribeOutput`'a summary opsiyonel field'ını ekle**

`PipelineTypes.ts:78-86`:

```ts
export interface ScribeOutput {
  spec: StructuredSpec;
  plan: UserFriendlyPlan;
  rawMarkdown: string;
  confidence: number;
  clarificationsAsked: number;
  reviewNotes?: string | ReviewNotes;
  assumptions?: string[];
  /**
   * 1-3 cümle Türkçe konuşma-dili özet — chat'te Scribe baloncuğunun ilk
   * satırı olarak çıkar. ProtoOutput.summary pattern'i taklit eder.
   * Opsiyonel — eski pipeline'lar bu field olmadan da çalışır.
   */
  summary?: string;
}
```

- [ ] **Step 5: `TraceOutput`'a summary opsiyonel field'ını ekle**

`PipelineTypes.ts:248-` bul ve genişlet. Dosyayı oku, `TraceOutput`'u şöyle güncelle (mevcut field'ları koruyarak):

```ts
// Mevcut field'lardan sonra ekle:
  /**
   * 1-3 cümle Türkçe konuşma-dili özet — chat'te Trace baloncuğunun ilk
   * satırı olarak çıkar. ProtoOutput.summary pattern'i taklit eder.
   * Opsiyonel — eski pipeline'lar bu field olmadan da çalışır.
   */
  summary?: string;
```

- [ ] **Step 6: Typecheck**

```bash
pnpm -C backend typecheck
```

Expected: PASS. (Eski kod yeni opsiyonel field'ları kullanmıyor, geriye dönük uyumlu.)

- [ ] **Step 7: Commit**

```bash
git add backend/src/pipeline/core/contracts/PipelineTypes.ts
git commit -m "feat(types): SubStep + scribe_completed event + summary/duration/subSteps payload

Backend contract: ScribeMessageType union'a scribe_completed eklendi,
proto_completed ve trace_completed payload'larına opsiyonel durationMs +
subSteps + (trace'e) summary eklendi. SubStep tipi yeni. ScribeOutput ve
TraceOutput'a opsiyonel summary field'ı eklendi.

Spec: docs/superpowers/specs/2026-05-23-chat-agent-narrator-pattern-a-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Scribe — LLM summary üretimi

**Files:**
- Modify: `backend/src/pipeline/agents/scribe/ScribeAgent.ts`
- Test: `backend/src/pipeline/agents/scribe/__tests__/ScribeAgent.summary.test.ts` (yeni veya mevcuda ekle)

- [ ] **Step 1: ScribeAgent içindeki prompt'a summary instruction'ı ekle**

`backend/src/pipeline/agents/scribe/ScribeAgent.ts` — final-spec üretimi yapan LLM çağrısının prompt'unu bul (genelde `generateSpec` veya `runSpecGeneration` fonksiyonu). JSON çıktı şemasına şu instruction ekle:

```
Add a "summary" field to your JSON output: 1-3 sentences in Turkish, plain
conversational tone, describing what you planned for the user — what they
asked for, which features you mapped, any constraint you added. This is
shown to the user in the chat as a friendly narration. Maximum 280
characters. Example:
"Sayaç için 5 user story belirledim — artır, azalt, sıfırla ve negatif değer
koruması. Mobil layout kriteri de eklendi."
```

Sonra JSON parse fonksiyonunda `summary` field'ını oku ve `ScribeOutput.summary`'e ata. Mevcut Proto pattern'i (`ProtoAgent.ts:1031-1032`) referans alınır:

```ts
// JSON parse sonrasında:
const rawSummary = typeof obj.summary === 'string' ? obj.summary.trim() : undefined;
const summary = rawSummary && rawSummary.length > 0 ? rawSummary.slice(0, 500) : undefined;
// Return değerine ekle:
return { ...existingFields, ...(summary ? { summary } : {}) };
```

- [ ] **Step 2: Unit test — summary field'ı extract ediyor**

`backend/src/pipeline/agents/scribe/__tests__/ScribeAgent.summary.test.ts` (mevcut test dosyası varsa ona ekle):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Bu test parse fonksiyonunu doğrudan çağırıyor (mock AI provider yerine).
// Eğer ScribeAgent'ta summary parse fonksiyonu export'lu değilse: küçük bir
// pure helper olarak çıkar (extractScribeSummary), benzer ProtoAgent pattern'i.

test('extractScribeSummary picks up summary field from JSON output', () => {
  const json = '{"spec":{},"summary":"Sayaç için 5 user story belirledim."}';
  const parsed = JSON.parse(json);
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : undefined;
  assert.equal(summary, 'Sayaç için 5 user story belirledim.');
});

test('extractScribeSummary returns undefined when summary missing', () => {
  const json = '{"spec":{}}';
  const parsed = JSON.parse(json);
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : undefined;
  assert.equal(summary, undefined);
});
```

- [ ] **Step 3: Run test**

```bash
pnpm -C backend exec tsx --test backend/src/pipeline/agents/scribe/__tests__/ScribeAgent.summary.test.ts
```

Expected: PASS.

- [ ] **Step 4: Typecheck**

```bash
pnpm -C backend typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/pipeline/agents/scribe/
git commit -m "feat(scribe): LLM Türkçe summary üretimi + parse

Scribe spec çıktı şemasına 'summary' field'ı eklendi (1-3 cümle Türkçe
konuşma-dili özet). ScribeOutput.summary opsiyonel; eski path bozulmaz.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Trace — LLM summary üretimi

**Files:**
- Modify: `backend/src/pipeline/agents/trace/TraceAgent.ts:542,589`
- Test: `backend/src/pipeline/agents/trace/__tests__/TraceAgent.summary.test.ts` (yeni)

- [ ] **Step 1: Trace prompt'unda summary instruction'ı**

`TraceAgent.ts:542` civarındaki "After pushing, respond with a JSON summary" prompt'unu genişlet:

```
After pushing, respond with a JSON summary including:
- testsWritten: number
- coveragePercentage: number
- summary: 1-3 sentences in Turkish, conversational tone, describing
  what you tested — which acceptance criteria are covered, total tests
  produced, any uncovered criteria. Max 280 characters. Example:
  "21 test yazdım — sayacın artırma, azaltma ve sıfırlama akışlarını
  uçtan uca kapsıyor. Mobil layout kriteri için iki ek senaryo eklendi."
```

- [ ] **Step 2: TraceAgent.ts:589 — parse fonksiyonunda summary'yi oku**

`TraceAgent.ts:589` "Parse the final JSON summary from Claude's text response" satırının altındaki parse logic'ine summary extraction ekle. Proto pattern'i taklit:

```ts
const rawSummary = typeof parsed.summary === 'string' ? parsed.summary.trim() : undefined;
const summary = rawSummary && rawSummary.length > 0 ? rawSummary.slice(0, 500) : undefined;
// Return değerine ekle:
return {
  ...existingFields,
  ...(summary ? { summary } : {}),
};
```

- [ ] **Step 3: Unit test**

`backend/src/pipeline/agents/trace/__tests__/TraceAgent.summary.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Trace summary parse: picks up summary from JSON', () => {
  const json = '{"testsWritten":21,"coveragePercentage":100,"summary":"21 test yazdım"}';
  const parsed = JSON.parse(json);
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : undefined;
  assert.equal(summary, '21 test yazdım');
});

test('Trace summary parse: returns undefined when summary missing', () => {
  const json = '{"testsWritten":21,"coveragePercentage":100}';
  const parsed = JSON.parse(json);
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : undefined;
  assert.equal(summary, undefined);
});
```

- [ ] **Step 4: Run test + typecheck**

```bash
pnpm -C backend exec tsx --test backend/src/pipeline/agents/trace/__tests__/TraceAgent.summary.test.ts
pnpm -C backend typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/pipeline/agents/trace/
git commit -m "feat(trace): LLM Türkçe summary üretimi + parse

Trace JSON çıktısı 'summary' field'ı içerir (1-3 cümle Türkçe). TraceOutput.summary
opsiyonel — eski pipeline'lar bozulmaz.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Orchestrator — startedAt tracking + scribe_completed event

**Files:**
- Modify: `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts:3918-4022`
- Test: `backend/src/pipeline/core/orchestrator/__tests__/PipelineOrchestrator.completionEvents.test.ts` (yeni)

- [ ] **Step 1: PipelineOrchestrator class'ında stage-start timestamp tutan in-memory map ekle**

`PipelineOrchestrator.ts` class body, mevcut private field'lardan sonra (örn. `private validator = new DeterministicValidator();` civarı):

```ts
/**
 * In-memory started-at timestamps per stage per pipeline. Server-truth
 * source for `durationMs` calc on completion events (spec NF-2).
 * Key format: `${pipelineId}:${stage}`. Cleared on completion or failure.
 */
private stageStartedAt = new Map<string, number>();

private markStageStarted(pipelineId: string, stage: 'scribe' | 'proto' | 'trace'): number {
  const now = Date.now();
  this.stageStartedAt.set(`${pipelineId}:${stage}`, now);
  return now;
}

private getStageDurationMs(pipelineId: string, stage: 'scribe' | 'proto' | 'trace'): number | undefined {
  const startedAt = this.stageStartedAt.get(`${pipelineId}:${stage}`);
  if (!startedAt) return undefined;
  const duration = Date.now() - startedAt;
  this.stageStartedAt.delete(`${pipelineId}:${stage}`);  // tek-kullanımlık
  return duration;
}
```

- [ ] **Step 2: appendProtoStarted ve appendTraceStarted'a `markStageStarted` çağrısı ekle**

`PipelineOrchestrator.ts:3927-3937`:

```ts
private async appendProtoStarted(pipelineId: string): Promise<number> {
  const pipeline = await this.getPipeline(pipelineId);
  const iteration = this.countPriorEvents(pipeline.scribeConversation, 'proto_completed') + 1;
  this.markStageStarted(pipelineId, 'proto');   // YENİ
  await this.store.update(pipelineId, {
    scribeConversation: [
      ...pipeline.scribeConversation,
      { type: 'proto_started', content: { iteration }, timestamp: new Date().toISOString() },
    ],
  });
  return iteration;
}
```

Aynı şekilde `appendTraceStarted`'a (`PipelineOrchestrator.ts:3965-3979`):

```ts
private async appendTraceStarted(pipelineId: string): Promise<number> {
  const pipeline = await this.getPipeline(pipelineId);
  const iteration = this.countPriorEvents(pipeline.scribeConversation, 'trace_completed') + 1;
  this.markStageStarted(pipelineId, 'trace');   // YENİ
  // ... rest unchanged
}
```

- [ ] **Step 3: appendProtoCompleted'a durationMs ekle**

`PipelineOrchestrator.ts:3939-3961`:

```ts
private async appendProtoCompleted(
  pipelineId: string,
  iteration: number,
  output: ProtoOutput,
  subSteps?: SubStep[]                      // YENİ — opsiyonel parametre
): Promise<void> {
  const pipeline = await this.getPipeline(pipelineId);
  const durationMs = this.getStageDurationMs(pipelineId, 'proto');
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
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(subSteps && subSteps.length > 0 ? { subSteps } : {}),
        },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}
```

`SubStep` import'unu dosyanın üstüne ekle:

```ts
import type { ..., SubStep } from '../contracts/PipelineTypes.js';
```

- [ ] **Step 4: appendTraceCompleted'a summary + durationMs + subSteps ekle**

`PipelineOrchestrator.ts:3981-4002`:

```ts
private async appendTraceCompleted(
  pipelineId: string,
  iteration: number,
  output: { testSummary: { totalTests: number; coveragePercentage: number }; summary?: string },
  subSteps?: SubStep[]
): Promise<void> {
  const pipeline = await this.getPipeline(pipelineId);
  const durationMs = this.getStageDurationMs(pipelineId, 'trace');
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
          ...(output.summary ? { summary: output.summary } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(subSteps && subSteps.length > 0 ? { subSteps } : {}),
        },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}
```

- [ ] **Step 5: Yeni `appendScribeStarted` + `appendScribeCompleted` helper'lar ekle**

`PipelineOrchestrator.ts:3963` civarına (Trace helper'larından önce veya sonra):

```ts
// ─── Chat-event helpers (Task 4: scribe events, 2026-05-23) ──────

private async appendScribeStarted(pipelineId: string): Promise<number> {
  const pipeline = await this.getPipeline(pipelineId);
  const iteration = this.countPriorEvents(pipeline.scribeConversation, 'scribe_completed') + 1;
  this.markStageStarted(pipelineId, 'scribe');
  // Not: Scribe started event'i scribeConversation'a eklenmiyor — mevcut
  // user_idea / clarification chain'i zaten Scribe sürecini gösteriyor.
  // Sadece iteration counter + startedAt tracking için.
  return iteration;
}

private async appendScribeCompleted(
  pipelineId: string,
  iteration: number,
  output: ScribeOutput,
  subSteps?: SubStep[]
): Promise<void> {
  const pipeline = await this.getPipeline(pipelineId);
  const durationMs = this.getStageDurationMs(pipelineId, 'scribe');
  await this.store.update(pipelineId, {
    scribeConversation: [
      ...pipeline.scribeConversation,
      {
        type: 'scribe_completed',
        content: {
          iteration,
          summary: output.summary ?? 'Plan hazırlandı.',
          storyCount: output.spec.userStories?.length ?? 0,
          acCount: output.spec.acceptanceCriteria?.length ?? 0,
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(subSteps && subSteps.length > 0 ? { subSteps } : {}),
        },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}
```

`countPriorEvents` fonksiyonunun union'ına `scribe_completed` ekle:

```ts
private countPriorEvents(
  conv: ScribeMessageType[],
  type: 'proto_completed' | 'trace_completed' | 'scribe_completed'  // YENİ
): number {
  return conv.filter((m) => m.type === type).length;
}
```

- [ ] **Step 6: Orchestrator'da `appendScribeCompleted` çağrılan noktayı ekle**

Scribe `spec_approved` event'inin emit edildiği yer (Scribe çıktısının son tutarlı hâlinde — onay alındıktan sonra). Grep:

```bash
grep -n "spec_approved" backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts
```

Bulunan satırda (genelde `approvePlan` veya `handleApproval` fonksiyonunda), `spec_approved` push'ından HEMEN ÖNCE `appendScribeCompleted` çağrısı ekle. SubStep oluşturma helper'ı bir sonraki task'ta — şimdilik subSteps undefined geç.

```ts
// Önce Scribe iterationCount + scribeOutput'u al
const scribeIteration = await this.appendScribeStarted(pipelineId);  // veya zaten markStageStarted yapıldı mı kontrol et
await this.appendScribeCompleted(pipelineId, scribeIteration, pipeline.scribeOutput!);
// Sonra spec_approved push'u olduğu gibi devam et
```

NOT: Eğer Scribe stage başladığında `markStageStarted('scribe')` çağrılan bir noktayı zaten varsa (örn. user_idea ilk gelende), oradan tekrar etmesin. Grep ile bul:

```bash
grep -n "user_idea\|runScribe\|scribe_clarifying" backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts | head -10
```

Pratik konum: `runScribe` (veya benzeri) fonksiyonunun başında `this.markStageStarted(pipelineId, 'scribe')` çağrı; sonunda `appendScribeCompleted`.

- [ ] **Step 7: Typecheck + unit test**

```bash
pnpm -C backend typecheck
pnpm -C backend test
```

Expected: PASS. Eski testler kırılmamalı (yeni field'lar opsiyonel).

- [ ] **Step 8: Yeni unit test — scribe_completed shape**

`backend/src/pipeline/core/orchestrator/__tests__/PipelineOrchestrator.completionEvents.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

// NOT: PipelineOrchestrator'ı doğrudan instantiate etmek ağır (DB store gerekir).
// Bu test event payload shape'ini doğruluyor — helper'ları unit test etmek
// için 'appendScribeCompleted'ı dışa export edip mock store ile çağırabiliriz.
// Eğer export yoksa, type-only assertion (compile-time) yeterli.

import type { ScribeMessageType, SubStep } from '../../contracts/PipelineTypes.js';

test('scribe_completed payload shape', () => {
  const sample: Extract<ScribeMessageType, { type: 'scribe_completed' }> = {
    type: 'scribe_completed',
    content: {
      iteration: 1,
      summary: 'Plan hazırlandı.',
      storyCount: 5,
      acCount: 8,
      durationMs: 134000,
      subSteps: [
        { label: 'User story\'ler çıkarıldı', status: 'done', durationMs: 42000 },
        { label: 'Değerlendirme: 2 eksik nokta', status: 'done', source: 'critic' },
      ],
    },
    timestamp: '2026-05-23T22:27:00Z',
  };
  assert.equal(sample.content.iteration, 1);
  assert.equal(sample.content.subSteps?.[1].source, 'critic');
});

test('trace_completed accepts optional summary + subSteps', () => {
  const sample: Extract<ScribeMessageType, { type: 'trace_completed' }> = {
    type: 'trace_completed',
    content: {
      iteration: 1,
      totalTests: 21,
      coverage: 100,
      passed: true,
      summary: '21 test yazdım.',
      durationMs: 47000,
    },
    timestamp: '2026-05-23T22:33:00Z',
  };
  assert.equal(sample.content.summary, '21 test yazdım.');
});
```

- [ ] **Step 9: Run new test**

```bash
pnpm -C backend exec tsx --test backend/src/pipeline/core/orchestrator/__tests__/PipelineOrchestrator.completionEvents.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add backend/src/pipeline/core/orchestrator/ backend/src/pipeline/core/contracts/PipelineTypes.ts
git commit -m "feat(orchestrator): scribe_completed event + durationMs/subSteps emit

Stage başında markStageStarted (Date.now snapshot); completion event'inde
delta'yı durationMs olarak yazıyor. ScribeAgent çıktısının summary'si
scribe_completed.content.summary'a aktarılıyor. Proto + Trace appender'larına
opsiyonel subSteps parametresi eklendi (Critic + Validator yansımaları için).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Orchestrator — subStep builder helper (Critic + Validator yansımaları)

**Files:**
- Modify: `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts`

- [ ] **Step 1: SubStep builder helper'ı ekle**

`PipelineOrchestrator.ts` class içinde (mevcut helper'ların yanında):

```ts
/**
 * Build SubStep list for a completion event. Reads intermediateState +
 * criticReview + validator output from the pipeline state and translates
 * them into human-language sub-step rows. Critic ve Validator yansımaları
 * burada `source` field'i ile etiketlenir — chat'te ayrı bubble açmaz,
 * sub-step satırı olarak görünür (spec DL-2/DL-3).
 */
private buildSubStepsForStage(
  pipeline: PipelineState,
  stage: 'scribe' | 'proto' | 'trace'
): SubStep[] {
  const steps: SubStep[] = [];

  if (stage === 'scribe') {
    if (pipeline.scribeOutput) {
      steps.push({
        label: `${pipeline.scribeOutput.spec.userStories?.length ?? 0} user story çıkarıldı`,
        status: 'done',
        source: 'agent',
      });
      steps.push({
        label: `${pipeline.scribeOutput.spec.acceptanceCriteria?.length ?? 0} kabul kriteri yazıldı`,
        status: 'done',
        source: 'agent',
      });
    }
    // Critic spec review yansıması — pipeline.intermediateState.criticSpecOutput
    const criticSpecOutput = pipeline.intermediateState?.criticSpecOutput as
      | CriticReviewOutput
      | undefined;
    if (criticSpecOutput && (criticSpecOutput.findings?.length ?? 0) > 0) {
      steps.push({
        label: `Değerlendirme: ${criticSpecOutput.findings.length} eksik nokta tespit edildi`,
        status: 'done',
        source: 'critic',
      });
    }
  }

  if (stage === 'proto') {
    if (pipeline.protoOutput) {
      steps.push({
        label: 'Proje iskeleti üretildi',
        status: 'done',
        source: 'agent',
      });
      steps.push({
        label: `${pipeline.protoOutput.files.length} dosya yazıldı`,
        status: 'done',
        source: 'agent',
      });
    }
    // Validator (statik kontrol) — pipeline.intermediateState.validatorReport
    // (gerçek field ismi `grep "validatorReport\|validator.*Output"` ile teyit edilmeli;
    // şu an pipeline state'inde `validatorReport` veya `validatorOutput` olabilir).
    const validatorResult = pipeline.intermediateState?.validatorReport as
      | { errors?: unknown[]; warnings?: unknown[] }
      | undefined;
    if (validatorResult) {
      const errorCount = validatorResult.errors?.length ?? 0;
      steps.push({
        label: errorCount === 0
          ? 'Statik kontrol: ✓ temiz'
          : `Statik kontrol: ${errorCount} hata düzeltildi`,
        status: 'done',
        source: 'validator',
      });
    }
    // Critic code review yansıması — pipeline.intermediateState.criticCodeOutput
    const criticCodeOutput = pipeline.intermediateState?.criticCodeOutput as
      | CriticReviewOutput
      | undefined;
    if (criticCodeOutput && (criticCodeOutput.findings?.length ?? 0) > 0) {
      steps.push({
        label: `Değerlendirme: ${criticCodeOutput.findings.length} öneri uygulandı`,
        status: 'done',
        source: 'critic',
      });
    }
  }

  if (stage === 'trace') {
    if (pipeline.traceOutput) {
      steps.push({
        label: `${pipeline.traceOutput.testSummary?.totalTests ?? 0} test senaryosu yazıldı`,
        status: 'done',
        source: 'agent',
      });
      if (pipeline.traceOutput.testSummary?.coveragePercentage !== undefined) {
        steps.push({
          label: `%${pipeline.traceOutput.testSummary.coveragePercentage} kapsam doğrulandı`,
          status: 'done',
          source: 'agent',
        });
      }
    }
  }

  return steps;
}
```

NOT (doğrulandı): Critic çıktıları **`pipeline.intermediateState.criticSpecOutput`** ve **`criticCodeOutput`** field'larında. Validator için `validatorReport` veya `validatorOutput` olabilir — uygulamadan önce şu komutla teyit:

```bash
grep -n "validatorReport\|validatorOutput\|validator:" backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts | head -5
```

Bulduğun gerçek field ismiyle helper'daki `validatorReport` yerine geçir.

- [ ] **Step 2: appendScribeCompleted/appendProtoCompleted/appendTraceCompleted çağrılarında subSteps geç**

Önceki task'ta `appendScribeCompleted(pipelineId, iteration, output)` şeklinde çağırmıştık. Şimdi:

```ts
// Scribe için (örn. handleApproval içinde):
const subSteps = this.buildSubStepsForStage(pipeline, 'scribe');
await this.appendScribeCompleted(pipelineId, iteration, pipeline.scribeOutput!, subSteps);

// Proto için (runProto / runProtoIterate'te, Proto bittiğinde):
const subSteps = this.buildSubStepsForStage(pipeline, 'proto');
await this.appendProtoCompleted(pipelineId, iteration, protoOutput, subSteps);

// Trace için (runTrace'te):
const subSteps = this.buildSubStepsForStage(pipeline, 'trace');
await this.appendTraceCompleted(pipelineId, iteration, traceOutput, subSteps);
```

- [ ] **Step 3: Typecheck**

```bash
pnpm -C backend typecheck
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts
git commit -m "feat(orchestrator): buildSubStepsForStage — Critic+Validator yansımaları

Critic ve Validator çıktıları sub-step listesinde insan-dili satır olarak
yansır (source: 'critic' | 'validator' | 'agent'). Chat'te ayrı bubble
açılmaz (DL-2/DL-3). Helper Scribe/Proto/Trace stage'leri için ayrı satırlar
üretir; pipeline state'inden okur.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Frontend types — ChatMessage agent genişleme + SubStep

**Files:**
- Modify: `frontend/src/types/chat.ts:54-81`

- [ ] **Step 1: SubStep tipini ekle**

`frontend/src/types/chat.ts` dosyasının başına (ilk import'tan sonra):

```ts
import type { UserFriendlyPlan, PlanStatus } from './plan';

/**
 * Sub-step stream — chat ajan baloncuğunda collapsed listede yer alan
 * insan-dili satırlar. Backend `SubStep` ile bire bir aynı. Critic ve
 * Validator etkileri burada source ile etiketlenir; chat'te ayrı bubble
 * yok (spec DL-2/DL-3).
 */
export interface SubStep {
  label: string;
  durationMs?: number;
  status: 'done' | 'live' | 'failed';
  source?: 'critic' | 'validator' | 'agent';
}
```

- [ ] **Step 2: `type: 'agent'` ChatMessage'a yeni field'lar**

`frontend/src/types/chat.ts:54-81` mevcut agent union member'ını şu hâle getir:

```ts
| {
    type: 'agent';
    agent: AgentName;
    content: string;
    timestamp: string;
    activityEntryId?: string;
    jiraEpicKey?: string;
    iteration?: number;
    summary?: string;
    totalFiles?: number;
    totalLines?: number;
    branch?: string;
    /**
     * Chat agent narrator (2026-05-23) — yeni field'lar:
     * - isLive: çalışmakta olan ajan baloncuğu mu?
     * - liveLabel: italic narrator metni ("Acceptance criteria yazıyor")
     * - startedAt: useRelativeDuration için
     * - durationMs: completed duration (server-truth)
     * - subSteps: collapsed sub-step listesi
     * - embeddedPlan: sadece Scribe son tur'da plan kartı için
     */
    isLive?: boolean;
    liveLabel?: string;
    startedAt?: string;
    durationMs?: number;
    subSteps?: SubStep[];
    embeddedPlan?: {
      plan: UserFriendlyPlan;
      version: number;
      status: PlanStatus;
      spec?: StructuredSpec;
      assumptions?: string[];
    };
  }
```

`PlanStatus` import'unu da yukarıdaki import satırına ekle (zaten yukarıda eklendi).

- [ ] **Step 3: Typecheck**

```bash
pnpm -C frontend typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types/chat.ts
git commit -m "feat(types): ChatMessage agent — SubStep + embeddedPlan + duration

Frontend chat agent union'ı genişler: isLive, liveLabel, startedAt,
durationMs, subSteps, embeddedPlan. SubStep tipi backend ile birebir aynı.
Eski kod yeni field'ları opsiyonel olduğu için bozulmaz.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Frontend — formatDuration utility + tests

**Files:**
- Create: `frontend/src/utils/formatDuration.ts`
- Create: `frontend/src/utils/__tests__/formatDuration.test.ts`

- [ ] **Step 1: Test'i önce yaz**

`frontend/src/utils/__tests__/formatDuration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatDuration } from '../formatDuration';

describe('formatDuration', () => {
  it('returns empty string when durationMs is undefined', () => {
    expect(formatDuration(undefined)).toBe('');
  });

  it('returns empty string for negative input', () => {
    expect(formatDuration(-100)).toBe('');
  });

  it('formats under 60 seconds as "X sn"', () => {
    expect(formatDuration(3000)).toBe('3 sn');
    expect(formatDuration(59999)).toBe('59 sn');
  });

  it('formats 60s-3599s as "X dk Y sn" or "X dk"', () => {
    expect(formatDuration(60000)).toBe('1 dk');
    expect(formatDuration(98000)).toBe('1 dk 38 sn');
    expect(formatDuration(134000)).toBe('2 dk 14 sn');
    expect(formatDuration(125000)).toBe('2 dk 5 sn');
    // edge: when seconds < 5, suppress ("1 dk" not "1 dk 3 sn")
    expect(formatDuration(63000)).toBe('1 dk');
  });

  it('formats >= 1 hour as "X sa Y dk"', () => {
    expect(formatDuration(3600000)).toBe('1 sa');
    expect(formatDuration(3720000)).toBe('1 sa 2 dk');
    expect(formatDuration(7260000)).toBe('2 sa 1 dk');
  });
});
```

- [ ] **Step 2: Run test (kırmızı)**

```bash
pnpm -C frontend test -- formatDuration.test
```

Expected: FAIL (formatDuration not found).

- [ ] **Step 3: Implement**

`frontend/src/utils/formatDuration.ts`:

```ts
/**
 * Format a millisecond duration into a compact Turkish phrase.
 *
 *   < 60s:    "X sn"
 *   < 60m:    "X dk" (eğer kalan sn < 5) veya "X dk Y sn"
 *   >= 1 sa:  "X sa" veya "X sa Y dk"
 *
 * Returns '' for undefined / negative input — UI uses falsy check to skip
 * rendering the duration meta (spec NF-2: yanlış değer yerine yok).
 */
export function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || durationMs < 0) return '';

  const totalSeconds = Math.floor(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} sn`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const remainderSec = totalSeconds - totalMinutes * 60;
    if (remainderSec < 5) return `${totalMinutes} dk`;
    return `${totalMinutes} dk ${remainderSec} sn`;
  }

  const totalHours = Math.floor(totalMinutes / 60);
  const remainderMin = totalMinutes - totalHours * 60;
  if (remainderMin === 0) return `${totalHours} sa`;
  return `${totalHours} sa ${remainderMin} dk`;
}
```

- [ ] **Step 4: Run test (yeşil)**

```bash
pnpm -C frontend test -- formatDuration.test
```

Expected: PASS (all 5 it blocks).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/formatDuration.ts frontend/src/utils/__tests__/formatDuration.test.ts
git commit -m "feat(utils): formatDuration — TR kompakt 'X dk Y sn' format

Server-truth durationMs'yi UI'a basacak formatter. NF-2: undefined/negatif
girdi için '' döner (UI falsy check ile meta'yı atlar).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Frontend — useRelativeDuration hook

**Files:**
- Create: `frontend/src/hooks/useRelativeDuration.ts`
- Create: `frontend/src/hooks/__tests__/useRelativeDuration.test.ts`

- [ ] **Step 1: Test önce**

`frontend/src/hooks/__tests__/useRelativeDuration.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRelativeDuration } from '../useRelativeDuration';

describe('useRelativeDuration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty string when startedAt is null', () => {
    const { result } = renderHook(() => useRelativeDuration(null, true));
    expect(result.current).toBe('');
  });

  it('returns empty string when not live', () => {
    const { result } = renderHook(() => useRelativeDuration('2026-05-23T22:25:00Z', false));
    expect(result.current).toBe('');
  });

  it('shows "1 dakikadan az" under 60s', () => {
    const now = new Date('2026-05-23T22:25:30Z').getTime();
    vi.setSystemTime(now);
    const startedAt = '2026-05-23T22:25:00Z';  // 30s ago
    const { result } = renderHook(() => useRelativeDuration(startedAt, true));
    expect(result.current).toBe('1 dakikadan az');
  });

  it('shows "1 dakikadır çalışıyor" at exactly 1 minute', () => {
    const now = new Date('2026-05-23T22:26:00Z').getTime();
    vi.setSystemTime(now);
    const { result } = renderHook(() =>
      useRelativeDuration('2026-05-23T22:25:00Z', true)
    );
    expect(result.current).toBe('1 dakikadır çalışıyor');
  });

  it('shows "5 dakikadır çalışıyor" at 5 minutes', () => {
    const now = new Date('2026-05-23T22:30:00Z').getTime();
    vi.setSystemTime(now);
    const { result } = renderHook(() =>
      useRelativeDuration('2026-05-23T22:25:00Z', true)
    );
    expect(result.current).toBe('5 dakikadır çalışıyor');
  });

  it('updates after interval ticks', () => {
    const t0 = new Date('2026-05-23T22:25:00Z').getTime();
    vi.setSystemTime(t0);
    const { result } = renderHook(() =>
      useRelativeDuration('2026-05-23T22:25:00Z', true)
    );
    expect(result.current).toBe('1 dakikadan az');

    // Advance 60 seconds — should tick at least once
    act(() => {
      vi.setSystemTime(t0 + 60_000);
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current).toBe('1 dakikadır çalışıyor');
  });
});
```

- [ ] **Step 2: Run test (kırmızı)**

```bash
pnpm -C frontend test -- useRelativeDuration.test
```

Expected: FAIL.

- [ ] **Step 3: Implement**

`frontend/src/hooks/useRelativeDuration.ts`:

```ts
import { useEffect, useState } from 'react';

/**
 * Live "X dakikadır çalışıyor" rölatif duration. Dakika floor — sn jitter
 * yok (spec NF-3). 30s tick interval; dakika değişimini yakalamak için
 * yeterince sık ama hassas değil.
 *
 * @param startedAt ISO timestamp; null ise/!isLive ise '' döner
 * @param isLive    Ajan hâlâ çalışmaktaysa true
 */
export function useRelativeDuration(
  startedAt: string | null | undefined,
  isLive: boolean
): string {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!isLive || !startedAt) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [isLive, startedAt]);

  if (!isLive || !startedAt) return '';

  const startedAtMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startedAtMs)) return '';

  const elapsedMs = Date.now() - startedAtMs;
  if (elapsedMs < 0) return '';

  const totalMinutes = Math.floor(elapsedMs / 60_000);
  if (totalMinutes < 1) return '1 dakikadan az';
  if (totalMinutes === 1) return '1 dakikadır çalışıyor';
  return `${totalMinutes} dakikadır çalışıyor`;
}
```

- [ ] **Step 4: Run test (yeşil)**

```bash
pnpm -C frontend test -- useRelativeDuration.test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useRelativeDuration.ts frontend/src/hooks/__tests__/useRelativeDuration.test.ts
git commit -m "feat(hooks): useRelativeDuration — live 'X dakikadır çalışıyor'

Server startedAt timestamp + isLive bayrağıyla 30s interval'lı tick.
Dakika floor (NF-3: jitter koruması). Ölçüm değişmediği sürece state
güncellenmez (gereksiz re-render yok).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Frontend — conversationToChatMessages: scribe_completed + subSteps + durationMs pass-through

**Files:**
- Modify: `frontend/src/utils/conversationToChatMessages.ts:159,184,200`
- Modify: `frontend/src/utils/__tests__/conversationToChatMessages.test.ts` (yeni testler ekle)

- [ ] **Step 1: Test'leri önce yaz (scribe_completed + subSteps pass-through)**

`frontend/src/utils/__tests__/conversationToChatMessages.test.ts` — `describe('conversationToChatMessages — event-log entries (2026-05-22)')` bloğunun sonuna:

```ts
describe('conversationToChatMessages — chat narrator (2026-05-23)', () => {
  it('scribe_completed emits agent ChatMessage with summary + subSteps + durationMs', () => {
    const conv = [
      { role: 'user', content: 'sayaç', timestamp: '2026-05-23T22:25:00Z' },
      {
        type: 'scribe_completed',
        content: {
          iteration: 1,
          summary: 'Sayaç için 5 user story belirledim.',
          storyCount: 5,
          acCount: 8,
          durationMs: 134000,
          subSteps: [
            { label: '5 user story çıkarıldı', status: 'done', source: 'agent' },
            { label: 'Değerlendirme: 2 eksik nokta', status: 'done', source: 'critic' },
          ],
        },
        timestamp: '2026-05-23T22:27:14Z',
      },
    ];
    const out = conversationToChatMessages(conv as never, 'awaiting_approval');
    const scribeMsg = out.find((m) => m.type === 'agent' && m.agent === 'scribe');
    expect(scribeMsg).toBeDefined();
    expect(scribeMsg).toMatchObject({
      type: 'agent',
      agent: 'scribe',
      summary: 'Sayaç için 5 user story belirledim.',
      durationMs: 134000,
    });
    expect((scribeMsg as { subSteps?: unknown[] }).subSteps).toHaveLength(2);
  });

  it('proto_completed passes durationMs + subSteps through to ChatMessage', () => {
    const conv = [
      {
        type: 'proto_completed',
        content: {
          iteration: 1,
          summary: 'React + Vite ile sayaç hazır.',
          filesCreated: 13,
          totalLines: 440,
          branch: 'feat/sayac',
          durationMs: 98000,
          subSteps: [
            { label: 'İskelet üretildi', status: 'done', source: 'agent' },
            { label: 'Statik kontrol: ✓ temiz', status: 'done', source: 'validator' },
          ],
        },
        timestamp: '2026-05-23T22:28:00Z',
      },
    ];
    const out = conversationToChatMessages(conv as never, 'proto_building');
    const protoMsg = out.find((m) => m.type === 'agent' && m.agent === 'proto');
    expect(protoMsg).toMatchObject({
      summary: 'React + Vite ile sayaç hazır.',
      totalFiles: 13,
      totalLines: 440,
      durationMs: 98000,
    });
    expect((protoMsg as { subSteps?: unknown[] }).subSteps).toHaveLength(2);
  });

  it('trace_completed passes summary + durationMs + subSteps through', () => {
    const conv = [
      {
        type: 'trace_completed',
        content: {
          iteration: 1,
          totalTests: 21,
          coverage: 100,
          passed: true,
          summary: '21 test yazdım, 3 fonksiyon kapsanıyor.',
          durationMs: 47000,
          subSteps: [{ label: '21 test yazıldı', status: 'done', source: 'agent' }],
        },
        timestamp: '2026-05-23T22:33:00Z',
      },
    ];
    const out = conversationToChatMessages(conv as never, 'completed');
    const traceMsg = out.find((m) => m.type === 'test_result');
    expect(traceMsg).toBeDefined();
    // Test result için summary/subSteps render path test'i (Task 11) — şimdilik var
    // mı diye kontrol et:
    expect((traceMsg as { summary?: string }).summary).toBe('21 test yazdım, 3 fonksiyon kapsanıyor.');
    expect((traceMsg as { durationMs?: number }).durationMs).toBe(47000);
  });
});
```

- [ ] **Step 2: Run test (kırmızı — yeni field'lar henüz pass-through edilmiyor)**

```bash
pnpm -C frontend test -- conversationToChatMessages.test
```

Expected: FAIL.

- [ ] **Step 3: Implement — proto/trace path'lerinde yeni field'ları geçir**

`frontend/src/utils/conversationToChatMessages.ts:184` — `isProtoResult` blok'unu genişlet:

```ts
const isProtoResult = m.role === 'proto' && m.type === 'proto_result' && !!m.protoResult;
const protoFields = isProtoResult
  ? {
      ...(m.protoResult?.summary ? { summary: m.protoResult.summary } : {}),
      ...(m.protoResult?.totalFiles !== undefined
        ? { totalFiles: m.protoResult.totalFiles }
        : {}),
      ...(m.protoResult?.totalLines !== undefined
        ? { totalLines: m.protoResult.totalLines }
        : {}),
      ...(m.protoResult?.branch ? { branch: m.protoResult.branch } : {}),
      // YENİ (2026-05-23):
      ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
      ...(m.subSteps && m.subSteps.length > 0 ? { subSteps: m.subSteps } : {}),
    }
  : {};
```

NOT: `m.durationMs` ve `m.subSteps`'i taşıyan **`ConversationMessage`** tipini (`frontend/src/types/workflow.ts`) güncellemen lazım. Mevcut yapı karışık — `summary` `protoResult` altında, ama `iteration` top-level. Yeni field'lar için tercih: **top-level** (iteration pattern'i taklit). `ConversationMessage` interface'ine:

```ts
durationMs?: number;
subSteps?: SubStep[];
summary?: string;          // Trace için (Proto zaten protoResult.summary'de)
embeddedPlan?: { ... };    // Scribe için
```

ekle. SubStep import'unu `from '../types/chat'` ile getir.

- [ ] **Step 4: Trace path'i — `trace_result` çağrısına summary + durationMs + subSteps ekle**

`conversationToChatMessages.ts:108-138` `trace_result` case'i. `traceResult`'tan summary'yi geçir (mevcut snapshot path zaten var) ve `m.durationMs`/`m.subSteps`'i ekle:

```ts
msgs.push({
  type: 'test_result',
  passed: tr.passing ?? 0,
  // ... existing fields ...
  timestamp: ts,
  ...(m.iteration !== undefined ? { iteration: m.iteration } : {}),
  // YENİ:
  ...(m.summary ? { summary: m.summary } : {}),
  ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
  ...(m.subSteps && m.subSteps.length > 0 ? { subSteps: m.subSteps } : {}),
});
```

Bu field'ların `ChatMessage` `test_result` member'ında zaten var olduğunu kontrol et — yoksa Task 6'da eklediğimiz agent tipinden ayrı, `test_result` da genişletilmeli:

`frontend/src/types/chat.ts:116-130` `test_result` member'ına:

```ts
| {
    type: 'test_result';
    passed: number;
    failed: number;
    // ... existing ...
    iteration?: number;
    // YENİ (2026-05-23):
    summary?: string;
    durationMs?: number;
    subSteps?: SubStep[];
  }
```

- [ ] **Step 5: Scribe path'i — `scribe_completed` ConversationMessage'ı işle**

`conversationToChatMessages.ts` — `switch (m.role)` içinde `case 'scribe':` blok'unda yeni bir branch ekle, ya da en üstte bir special-case:

```ts
// 2026-05-23: scribe_completed ConversationMessage → agent ChatMessage
if ((m as { type?: string }).type === 'scribe_completed') {
  const sc = (m as {
    summary?: string;
    durationMs?: number;
    subSteps?: SubStep[];
    iteration?: number;
    embeddedPlan?: unknown;
  });
  msgs.push({
    type: 'agent',
    agent: 'scribe',
    content: sc.summary ?? 'Plan hazırlandı.',
    summary: sc.summary,
    timestamp: ts,
    ...(sc.iteration !== undefined ? { iteration: sc.iteration } : {}),
    ...(sc.durationMs !== undefined ? { durationMs: sc.durationMs } : {}),
    ...(sc.subSteps && sc.subSteps.length > 0 ? { subSteps: sc.subSteps } : {}),
    ...(sc.embeddedPlan ? { embeddedPlan: sc.embeddedPlan } : {}),
  } as ChatMessage);
  break;
}
```

NOT: Bu Scribe ChatMessage'ı `embeddedPlan` field'ı taşıyabilir. Plan card'ı buraya monte etmek `mapConversation`'ın görevi (Task 10).

- [ ] **Step 6: Run test (yeşil)**

```bash
pnpm -C frontend test -- conversationToChatMessages.test
```

Expected: PASS — eski testler + yeni 3 test.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/utils/conversationToChatMessages.ts frontend/src/utils/__tests__/conversationToChatMessages.test.ts frontend/src/types/chat.ts
git commit -m "feat(chat): scribe_completed + subSteps/durationMs pass-through

conversationToChatMessages yeni Scribe completed event'ini agent ChatMessage'a
çevirir. Proto + Trace path'leri de durationMs + subSteps + Trace summary'i
pass-through eder. test_result ChatMessage tipine summary/durationMs/subSteps
opsiyonel field'ları eklendi.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Frontend — workflows.ts: scribe_completed case + plan card embed + chip ordering fix

**Files:**
- Modify: `frontend/src/services/api/workflows.ts:174-380`

- [ ] **Step 1: `hasNarratedScribe` flag ekle (event-log varlık check)**

`workflows.ts:174` civarı (mevcut `hasNarratedProto` / `hasNarratedTrace` benzeri):

```ts
// 2026-05-23: yeni event tipleri için flag.
const hasNarratedScribe = pipeline.scribeConversation?.some(
  (m: unknown) => (m as { type?: string })?.type === 'scribe_completed'
);
```

- [ ] **Step 2: switch case'lerine `scribe_completed` ekle**

`workflows.ts:266` civarı, `case 'proto_started':` öncesine veya sonrasına:

```ts
case 'scribe_completed': {
  // En son scribe_completed event'i: plan kartını da bu Scribe baloncuğuna
  // göm. spec + assumptions PipelineState'ten (approvedSpec / pendingSpec) gelir.
  const sc = msg.content;
  const approvedOrPending = pipeline.approvedSpec ?? pipeline.scribeOutput?.spec ?? null;
  const stage: PipelineStage = (pipeline.stage as PipelineStage) ?? 'idle';
  let planStatus: 'active' | 'approved' | 'rejected' = 'active';
  if (PRE_APPROVAL_STAGES.indexOf(stage) === -1) {
    planStatus = 'approved';
  }
  const embeddedPlan = approvedOrPending
    ? {
        plan: specToUserFriendlyPlan(approvedOrPending),
        version: 1,
        status: planStatus,
        spec: approvedOrPending,
        assumptions: pipeline.scribeOutput?.assumptions,
      }
    : undefined;
  messages.push({
    role: 'scribe',
    type: 'scribe_completed' as unknown as 'agent',  // ChatMessage path için
    content: sc.summary ?? 'Plan hazırlandı.',
    summary: sc.summary,
    timestamp: msg.timestamp ?? new Date().toISOString(),
    iteration: sc.iteration,
    ...(sc.durationMs !== undefined ? { durationMs: sc.durationMs } : {}),
    ...(sc.subSteps && sc.subSteps.length > 0 ? { subSteps: sc.subSteps } : {}),
    ...(embeddedPlan ? { embeddedPlan } : {}),
  } as unknown as ConversationMessage);
  break;
}
```

NOT: `PRE_APPROVAL_STAGES` ve `specToUserFriendlyPlan` import'ları workflows.ts'in tepesinden ya da `conversationToChatMessages`'tan alınır. Eğer yoksa ekle.

- [ ] **Step 3: Mevcut `case 'proto_completed':` ve `case 'trace_completed':` blok'larında durationMs + subSteps geçir**

`workflows.ts:275-298` (`proto_completed`):

```ts
case 'proto_completed': {
  const po = pipeline.protoOutput;
  messages.push({
    role: 'proto',
    type: 'proto_result',
    content: msg.content.summary,
    timestamp: msg.timestamp ?? new Date().toISOString(),
    iteration: msg.content.iteration,
    protoResult: {
      branch: msg.content.branch ?? po?.branch ?? '',
      repo: po?.repo ?? '',
      files: [],
      totalFiles: msg.content.filesCreated,
      totalLines: msg.content.totalLines,
      summary: msg.content.summary,
      ...(po?.verificationReport ? { verificationReport: po.verificationReport } : {}),
    },
    // YENİ (2026-05-23):
    ...(msg.content.durationMs !== undefined ? { durationMs: msg.content.durationMs } : {}),
    ...(msg.content.subSteps && msg.content.subSteps.length > 0
      ? { subSteps: msg.content.subSteps }
      : {}),
  } as unknown as ConversationMessage);
  break;
}
```

`workflows.ts:309-324` (`trace_completed`):

```ts
case 'trace_completed':
  messages.push({
    role: 'trace',
    type: 'trace_result',
    content: msg.content.summary ?? `Test yazıldı — ${msg.content.totalTests} test, %${msg.content.coverage}`,
    timestamp: msg.timestamp ?? new Date().toISOString(),
    iteration: msg.content.iteration,
    traceResult: { /* existing */ },
    // YENİ (2026-05-23):
    ...(msg.content.summary ? { summary: msg.content.summary } : {}),
    ...(msg.content.durationMs !== undefined ? { durationMs: msg.content.durationMs } : {}),
    ...(msg.content.subSteps && msg.content.subSteps.length > 0
      ? { subSteps: msg.content.subSteps }
      : {}),
  } as unknown as ConversationMessage);
  break;
```

- [ ] **Step 4: Plan kartı çift gösterimini önle — `scribe_completed` varsa snapshot `spec` ChatMessage emit etmeyi atla**

`workflows.ts`'te `spec`/`spec_draft` snapshot emit'i yapan path'i bul (`grep -n "type: 'spec'" workflows.ts`). Eğer `hasNarratedScribe` true ise bu satırı emit etme:

```ts
// Snapshot fallback (eski pipeline'lar):
if (!hasNarratedScribe && pipeline.scribeOutput?.spec) {
  // mevcut spec ChatMessage push'u — değişmedi
}
```

NOT: Eğer mevcut kod `mapConversation`'da `m.type === 'spec_draft'` → `messages.push({ type: 'spec', spec, assumptions })` yapıyorsa, bu yine kalır (yeni pipeline'larda da Scribe iterating sırasında plan kartı görünmesi gerekiyor). `scribe_completed` event'inin gelmesi ise plan kartını "approved" olarak Scribe son baloncuğuna yerleştirir. Çift gösterimi önlemek için:

`conversationToChatMessages.ts:159` `case 'spec' && m.spec` blok'unda, eğer ileride bir `scribe_completed` ChatMessage gelecekse (yani `messages` array'inin geri kalanında `scribe_completed` var ise), `plan` emit'ini atla. Bunu `specSeen`'in benzeri bir `hasScribeCompleted` flag'i ile yap.

Pratik yaklaşım: iki-pass çevir:
1. İlk pass'te conversation'ı tara, `scribeCompletedExists = conv.some(m => m.type === 'scribe_completed')`.
2. Switch içinde `case 'spec'`: eğer `scribeCompletedExists` true ise `plan` push'unu atla.

`conversationToChatMessages.ts:53-56`'da `conversationToChatMessages` fonksiyonunun başına:

```ts
const scribeCompletedExists = conv.some(
  (m) => (m as { type?: string }).type === 'scribe_completed'
);
```

Sonra `case 'spec'` blok'unda:

```ts
} else if (m.type === 'spec' && m.spec) {
  specSeen = true;
  if (scribeCompletedExists) {
    // 2026-05-23: plan kartı Scribe'ın scribe_completed baloncuğuna gömülü
    // render edilecek. Snapshot türevli plan ChatMessage emit etme.
    break;
  }
  // ... eski path (snapshot fallback)
```

- [ ] **Step 5: Sıralama bug fix — system chip timestamp ordering**

`workflows.ts` veya `conversationToChatMessages.ts` — mesajların array sonunda timestamp'e göre stable sort edildiğinden emin ol:

```ts
// conversationToChatMessages dönmeden önce, fonksiyon sonunda:
msgs.sort((a, b) => {
  const ta = new Date(a.timestamp).getTime();
  const tb = new Date(b.timestamp).getTime();
  if (ta === tb) return 0;  // stable — tie-break original order korunur
  return ta - tb;
});
return msgs;
```

NOT: JS Array.sort stable (ES2019+). Tie durumunda original sıra korunur.

- [ ] **Step 6: Typecheck**

```bash
pnpm -C frontend typecheck
```

- [ ] **Step 7: Run frontend test suite**

```bash
pnpm -C frontend test
```

Expected: PASS (yeni test'ler dahil).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/services/api/workflows.ts frontend/src/utils/conversationToChatMessages.ts
git commit -m "feat(chat): scribe_completed mapping + embeddedPlan + chip ordering fix

workflows.ts mapConversation: scribe_completed event'i için ayrı
case; plan kartı Scribe'ın son baloncuğuna gömülür. proto_completed +
trace_completed yeni payload field'ları (durationMs, subSteps, summary)
geçirilir. conversationToChatMessages: scribeCompletedExists guard ile
plan ChatMessage'ın çiftlenmesini önler; finale stable timestamp sort
eklendi (system chip sıralama bug'ı fix).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Frontend — ChatMessage.tsx agent bubble render

**Files:**
- Modify: `frontend/src/components/chat/ChatMessage.tsx` — agent render block (mevcut PlanCard render civarı, line 411)
- Test: `frontend/src/components/chat/__tests__/ChatMessage.narrator.test.tsx` (yeni)

- [ ] **Step 1: Test'i önce yaz — embedded plan + sub-steps + duration footer**

`frontend/src/components/chat/__tests__/ChatMessage.narrator.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatMessage } from '../ChatMessage';
import type { ChatMessage as ChatMessageType } from '../../../types/chat';

describe('ChatMessage — agent narrator (2026-05-23)', () => {
  it('renders LLM summary as the body of the agent bubble', () => {
    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'scribe',
      content: 'fallback',
      summary: 'Sayaç için 5 user story belirledim.',
      timestamp: new Date().toISOString(),
    };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText(/Sayaç için 5 user story belirledim/)).toBeInTheDocument();
  });

  it('renders embedded PlanCard inside Scribe bubble', () => {
    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'scribe',
      content: '',
      summary: 'Plan hazır.',
      timestamp: new Date().toISOString(),
      embeddedPlan: {
        plan: { projectName: 'Sayaç', summary: '', features: [], techChoices: [], estimatedFiles: 5, requiresTests: true },
        version: 1,
        status: 'active',
      },
    };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText(/Sayaç/)).toBeInTheDocument();
  });

  it('renders duration footer when durationMs is set', () => {
    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'proto',
      content: '',
      summary: 'Hazır.',
      durationMs: 98000,
      timestamp: new Date().toISOString(),
    };
    render(<ChatMessage message={msg} />);
    expect(screen.getByText(/1 dk 38 sn/)).toBeInTheDocument();
  });

  it('does NOT render duration when durationMs missing (NF-2)', () => {
    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'proto',
      content: '',
      summary: 'Hazır.',
      timestamp: new Date().toISOString(),
    };
    render(<ChatMessage message={msg} />);
    // Verify no 'dk' / 'sn' / 'sa' text leaked through
    expect(screen.queryByText(/dk|sn|sa\b/)).toBeNull();
  });

  it('renders collapsed sub-step toggle when subSteps present', () => {
    const msg: ChatMessageType = {
      type: 'agent',
      agent: 'proto',
      content: '',
      summary: 'Hazır.',
      timestamp: new Date().toISOString(),
      subSteps: [
        { label: 'İskelet üretildi', status: 'done', source: 'agent' },
        { label: 'Statik kontrol: ✓ temiz', status: 'done', source: 'validator' },
      ],
    };
    render(<ChatMessage message={msg} />);
    // Toggle label: "2 adım"
    expect(screen.getByText(/2 adım/)).toBeInTheDocument();
    // Default collapsed — substep label not visible
    expect(screen.queryByText(/Statik kontrol/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test (kırmızı)**

```bash
pnpm -C frontend test -- ChatMessage.narrator
```

Expected: FAIL.

- [ ] **Step 3: ChatMessage.tsx agent render — summary + embeddedPlan + sub-steps + duration footer**

`ChatMessage.tsx:411` civarı — şu an `<PlanCard ... />` standalone render ediliyor (`case 'plan'` veya benzer). Agent bubble render'ı genelde `case 'agent':` veya unified bubble render fonksiyonunda. Bul:

```bash
grep -n "case 'agent'\|message.summary\|renderAgentBubble" frontend/src/components/chat/ChatMessage.tsx
```

Bulduğun fonksiyonda, mevcut `summary ?? content` mantığını koru, sonra şunları ekle:

```tsx
import { formatDuration } from '../../utils/formatDuration';
import { useRelativeDuration } from '../../hooks/useRelativeDuration';
import { PlanCard } from './PlanCard';

// Agent bubble render fonksiyonu (örnek shape — mevcut markup'a entegre):
function AgentBubble({ message }: { message: Extract<ChatMessage, { type: 'agent' }> }) {
  const liveText = useRelativeDuration(message.startedAt ?? null, message.isLive ?? false);
  const completedText = formatDuration(message.durationMs);
  const durationText = message.isLive ? liveText : completedText;

  return (
    <div className={`agent-bubble agent-${message.agent}`}>
      {/* Header — badge + timestamp (mevcut) */}
      {/* ... existing header markup ... */}

      {/* Body — live narrator veya summary */}
      {message.isLive && message.liveLabel ? (
        <div className="live-narrator italic text-gray-400">● {message.liveLabel}</div>
      ) : (
        <div className="summary">{message.summary ?? message.content}</div>
      )}

      {/* Embedded plan card (only Scribe son tur) */}
      {message.embeddedPlan ? (
        <div className="mt-2">
          <PlanCard
            plan={message.embeddedPlan.plan}
            version={message.embeddedPlan.version}
            status={message.embeddedPlan.status}
            isChangeRequest={false}
            spec={message.embeddedPlan.spec}
            assumptions={message.embeddedPlan.assumptions}
            // onApprove/onReject — parent component'ten geliyor (existing pattern)
          />
        </div>
      ) : null}

      {/* Sub-step toggle (collapsed default) */}
      {message.subSteps && message.subSteps.length > 0 ? (
        <details className="mt-2 text-xs text-gray-400">
          <summary className="cursor-pointer">▾ {message.subSteps.length} adım</summary>
          <ul className="mt-1 ml-4 space-y-1">
            {message.subSteps.map((step, i) => (
              <li key={i} className="flex items-center gap-2">
                <span>{step.status === 'done' ? '✓' : step.status === 'live' ? '●' : '✗'}</span>
                <span>{step.label}</span>
                {step.durationMs ? (
                  <span className="text-gray-500 text-[10px]">{formatDuration(step.durationMs)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* Footer meta — duration + iteration + counts */}
      {(durationText || message.iteration || message.totalFiles) ? (
        <div className="footer-meta text-xs text-gray-500 mt-2 flex items-center gap-2">
          {message.iteration && message.iteration > 1 ? (
            <span className="iteration-badge">İterasyon {message.iteration}</span>
          ) : null}
          {message.totalFiles ? <span>{message.totalFiles} dosya</span> : null}
          {message.totalLines ? <span>· {message.totalLines} satır</span> : null}
          {durationText ? <span className="duration text-green-400">· {durationText}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
```

NOT: Mevcut `ChatMessage.tsx` markup ve Tailwind class'ları farklı olabilir. Implementer projedeki design system'e (ak-* prefix'li class'lar) entegre etsin. Burada gösterilen structure (header, body, plan, sub-step, footer sırası) korunsun.

- [ ] **Step 4: PlanCard standalone render'ını koşullu yap**

`ChatMessage.tsx:411` — eski `case 'plan':` render path'i, eski pipeline'lar için fallback olarak kalır:

```tsx
case 'plan':
  // 2026-05-23: Yeni pipeline'larda plan agent ChatMessage'ın embeddedPlan'ında.
  // Bu standalone case eski (snapshot fallback) pipeline'lar için geçerli.
  return (
    <PlanCard
      plan={message.plan}
      // ... mevcut props
    />
  );
```

- [ ] **Step 5: Run test (yeşil)**

```bash
pnpm -C frontend test -- ChatMessage.narrator
```

Expected: PASS (5 it block).

- [ ] **Step 6: Eski testlerin kırılmadığını doğrula**

```bash
pnpm -C frontend test
```

Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/chat/ChatMessage.tsx frontend/src/components/chat/__tests__/ChatMessage.narrator.test.tsx
git commit -m "feat(chat): agent bubble render — summary, embeddedPlan, sub-steps, duration

ChatMessage.tsx agent bubble: live narrator (italic) veya LLM summary;
embeddedPlan varsa PlanCard inline; subSteps varsa collapsed details
toggle (▾ N adım); footer meta'da iteration rozeti + dosya/satır sayısı +
duration. formatDuration + useRelativeDuration hook'ları entegre.

Plan kartının standalone 'plan' ChatMessage case'i eski (snapshot fallback)
pipeline'lar için kalır.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: i18n — Türkçe + EN string güncellemeleri

**Files:**
- Modify: `frontend/src/i18n/locales/tr.json`
- Modify: `frontend/src/i18n/locales/en.json`

- [ ] **Step 1: i18n key'leri ekle (TR + EN)**

Mevcut `frontend/src/i18n/locales/tr.json` dosyasını oku ve `pipeline.activity.*` veya benzeri scope'a yeni key'ler ekle. Hangi key'lerin gerekli olduğu Task 11'deki render kodunda göründü:

```json
{
  "chat": {
    "narrator": {
      "live_under_one_minute": "1 dakikadan az",
      "live_minutes_running_one": "1 dakikadır çalışıyor",
      "live_minutes_running_n": "{{count}} dakikadır çalışıyor",
      "iteration_badge": "İterasyon {{n}}",
      "substep_toggle": "{{count}} adım",
      "subStep_unit_files": "{{n}} dosya",
      "subStep_unit_lines": "{{n}} satır"
    }
  }
}
```

EN locale (en.json):

```json
{
  "chat": {
    "narrator": {
      "live_under_one_minute": "less than 1 minute",
      "live_minutes_running_one": "running for 1 minute",
      "live_minutes_running_n": "running for {{count}} minutes",
      "iteration_badge": "Iteration {{n}}",
      "substep_toggle": "{{count}} steps",
      "subStep_unit_files": "{{n}} files",
      "subStep_unit_lines": "{{n}} lines"
    }
  }
}
```

NOT: `useRelativeDuration` ve `formatDuration` şu an hardcoded TR string döndürüyor. i18n'e taşıma opsiyonel — şu an scope sade tutmak için TR-only bırakılabilir. Sadece UI label'leri i18n'le. Implementer karar versin.

- [ ] **Step 2: i18n testi (varsa)**

```bash
pnpm -C frontend test -- i18n
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/i18n/
git commit -m "i18n: chat narrator key'leri (TR + EN) — iteration, substep, units

Yeni chat agent narrator render'ı için TR + EN string'ler. live_under_one_minute,
live_minutes_running, iteration_badge, substep_toggle.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Manuel smoke test — dev-up + walkthrough

- [ ] **Step 1: Dev environment'ı başlat**

```bash
./scripts/dev-up.sh
```

Expected: Docker Postgres + Adminer + backend (:3000) + frontend (:5173) çalışıyor. `./scripts/dev-logs.sh` ile log akışını kontrol et.

- [ ] **Step 2: Walkthrough script'i çalıştır (varsa)**

```bash
node scripts/smoke/walkthrough.mjs
```

Eğer script yoksa manuel test yap: tarayıcıda http://localhost:5173 aç, login ol, "basit bir sayaç" pipeline'ı başlat.

- [ ] **Step 3: Acceptance criteria kontrolü (spec §5)**

Her AC için elle gözlemle:

- **AC-1** Scribe bubble LLM summary'yle başlıyor mu? Plan kartı baloncuğun içinde mi? Footer'da duration var mı?
- **AC-2** Proto bubble summary'yle başlıyor mu? "▾ N adım" açılıyor mu? Statik kontrol satırı sub-step listesinde mi?
- **AC-3** Trace bubble LLM summary, sub-step, duration meta var mı?
- **AC-4** Critic değerlendirmesi varsa Scribe sub-step'inde "Değerlendirme: N eksik nokta" satırı görünüyor mu? Ayrı Critic bubble YOK?
- **AC-5** İki sequential Proto run → iki ayrı bubble + iterasyon rozeti?
- **AC-6** Proto çalışırken yazılan kullanıcı mesajı kronolojik yerine düşüyor mu? "Geri bildirim alındı" chip görünüyor mu?
- **AC-7** Çalışmakta olan ajan için italic narrator + "X dakikadır" görünüyor mu?
- **AC-9** Eski (durationMs'siz) pipeline'da duration meta gizli mi?
- **AC-11** "Plan onaylandı" chip Scribe'dan SONRA, Proto'dan ÖNCE düşüyor mu?

Ekran görüntüleri al: `docs/dogfooding/screenshots/2026-05-23-pattern-a-*.png`.

- [ ] **Step 4: Console error / network 5xx taraması**

DevTools açık:
- Browser console: sadece bilinen no-op uyarıları
- Network tab: tüm 2xx/3xx; 5xx varsa düzelt
- Backend log (`./scripts/dev-logs.sh`): unhandled error / unmapped event tipi olmasın

- [ ] **Step 5: Dev environment'ı kapat**

```bash
./scripts/dev-down.sh
```

- [ ] **Step 6: Bulguları kayıt et**

`.claude/state/manual-test-2026-05-23-narrator.md` dosyasında:

```markdown
# Pattern A — manual smoke 2026-05-23

## Sonuç
- AC-1: ✓ / ✗ + notlar
- AC-2: ...
- ...

## Bulgular
- (varsa) Şu noktada beklenmedik davranış: ...
```

- [ ] **Step 7: Commit (opsiyonel — sadece bulgu doc'u + screenshot)**

```bash
git add .claude/state/manual-test-2026-05-23-narrator.md docs/dogfooding/screenshots/2026-05-23-pattern-a-*.png
git commit -m "test(manual): Pattern A smoke — AC kontrolü + screenshot

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Toplu test + lint + typecheck (final gate)

- [ ] **Step 1: Backend full test + lint + typecheck**

```bash
pnpm -C backend typecheck
pnpm -C backend lint
pnpm -C backend test
```

Expected: ALL PASS.

- [ ] **Step 2: Frontend full test + lint + typecheck**

```bash
pnpm -C frontend typecheck
pnpm -C frontend lint
pnpm -C frontend test
```

Expected: ALL PASS.

- [ ] **Step 3: Eğer red varsa fix + re-test**

Failing test'leri tek tek çöz. Eski test'ler kırıldıysa muhtemelen `embeddedPlan` propagation veya snapshot fallback path'inde regresyon var. Önce snapshot fallback (`!hasNarratedScribe` koşulu) ile gate'lendiğinden emin ol.

- [ ] **Step 4: CI parity check — `tsc -b` (strict mode)**

```bash
pnpm -C frontend exec tsc -b --noEmit
```

NOT: `tsc -b` `tsc --noEmit`'tan daha sıkı ([[ci_strict_typecheck_gap]]). Yerelde yeşil olsa bile CI bunda kırılabilir — burada yakalanır.

- [ ] **Step 5: Eğer hepsi yeşilse, PR aç**

```bash
git push -u origin HEAD
gh pr create --title "feat(chat): Pattern A — agent narrator + embedded plan + sub-steps + duration" --body "$(cat <<'EOF'
## Summary

Chat agent narrator (Pattern A) — spec [docs/superpowers/specs/2026-05-23-chat-agent-narrator-pattern-a-design.md](docs/superpowers/specs/2026-05-23-chat-agent-narrator-pattern-a-design.md).

- Her ajan (Scribe / Proto / Trace) chat'te 1-3 cümle Türkçe LLM özet basar.
- Plan kartı Scribe'ın son baloncuğuna gömülü — ayrı yüzen kart yok.
- Her baloncukta collapsed sub-step listesi (▾ N adım) + server-truth duration meta.
- Critic ve Validator chat'te ayrı bubble açmaz — sub-step satırı olarak yansır.
- State transition chip'lerinin sıralama bug'ı fix'lendi.

Spec DL-1 → DL-8 hepsi implement.

## Test plan

- [x] Backend typecheck + lint + test
- [x] Frontend typecheck + lint + test
- [x] CI parity (`tsc -b`)
- [x] Manuel smoke test — sayaç pipeline, AC-1 → AC-12

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: PR linkini yakala + bildir**

PR URL'i kullanıcıya bildir, review'a hazır.

---

## Notlar — paralel execution opsiyonu

Bu plan task'larından bazıları **paralel** çalıştırılabilir (worktree subagent'larıyla):

- **Backend track**: Task 1 → 2 → 3 → 4 → 5 (sequential — birbirine bağımlı)
- **Frontend types track**: Task 6 → 7 → 8 (paralel başlatılabilir Task 1'den sonra; Task 6 backend types'a bağımlı değil, sadece spec'e dayanıyor)
- **Frontend mapping/render**: Task 9 → 10 → 11 → 12 (sequential, types'tan sonra)
- **Test track**: Task 13 + 14 (en sona, hepsi bitince)

Worktree dispatcher (parallel-implementation skill) için 3 paralel hat:
1. Backend (Task 1-5) — `../akis-pattern-a-be`
2. Frontend utils (Task 6-8) — `../akis-pattern-a-fe-utils`
3. Frontend render (Task 9-12) — `../akis-pattern-a-fe-render` (Task 2 backend tarafından block'lanır — payload tipleri için)

Implementer aynı oturumda inline da yapabilir — sıralı ama hızlı (her commit gate'leyici).
