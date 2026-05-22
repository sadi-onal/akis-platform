# Failed-State Holistic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** PR #609'un üzerine A1-A4 paketi: reconciler scribe_failed/proto_failed event'leri + banner technicalDetail render + stage-aware timeout copy + canlı failed pipeline e2e doğrulaması.

**Architecture:** Tek branch, ardışık 9 task. Backend tipler önce, sonra reconciler, sonra frontend tip mirror + workflows mapper, sonra banner UI + stage-aware copy helper, en sonda live e2e screenshot.

**Tech Stack:** TypeScript strict, Drizzle, Fastify (backend); React 19, Vite, Vitest, Tailwind v4 (frontend); node --test runner backend, Playwright MCP for e2e.

---

## Task 1: ScribeMessageType union extension (backend)

**Files:**
- Modify: `backend/src/pipeline/core/contracts/PipelineTypes.ts:88-142`
- Test: `backend/test/unit/pipeline-orchestrator-chat-events.test.ts` (extend existing)

- [ ] **Step 1: Extend ScribeMessageType with scribe_failed + proto_failed**

```ts
| {
    type: 'scribe_failed';
    content: {
      stageStuck: PipelineStage;
      errorCode: 'PIPELINE_TIMEOUT' | string;
      errorMessage: string;
      recoveryAction?: 'retry';
    };
    timestamp?: string;
  }
| {
    type: 'proto_failed';
    content: {
      iteration?: number;
      errorCode: 'PIPELINE_TIMEOUT' | string;
      errorMessage: string;
      recoveryAction?: 'retry';
    };
    timestamp?: string;
  }
```

Mevcut `trace_failed` ile aynı şekil. Position: trace_failed'ın altına, comment'le ayrılmış halde.

- [ ] **Step 2: typecheck**

Run: `pnpm -C backend typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add backend/src/pipeline/core/contracts/PipelineTypes.ts
git commit -m "feat(types): scribe_failed + proto_failed ScribeMessageType variants"
```

---

## Task 2: Reconciler — emit stage-mapped failure event

**Files:**
- Modify: `backend/src/pipeline/core/PipelineReconciler.ts:91-117`
- Test: `backend/test/unit/pipeline-reconciler-chat-event.test.ts` (extend with 3 new tests)

- [ ] **Step 1: Write failing tests for scribe + proto stuck**

```ts
// Test (a) scribe_generating stuck → scribe_failed event
it('appends scribe_failed event when scribe_generating times out', async () => {
  const store = makeStuckStore('scribe_generating');
  const reconciler = new PipelineReconciler(store as unknown as PipelineStore);
  await reconciler.sweep();
  const updated = store.states.get(store.stuck.id)!;
  assert.equal(updated.stage, 'failed');
  const failed = updated.scribeConversation.find((m) => m.type === 'scribe_failed');
  assert.ok(failed, 'scribe_failed expected');
  if (failed && failed.type === 'scribe_failed') {
    assert.equal(failed.content.stageStuck, 'scribe_generating');
    assert.equal(failed.content.recoveryAction, 'retry');
  }
});

// Test (b) proto_building stuck → proto_failed event
it('appends proto_failed event when proto_building times out', async () => { ... });

// Test (c) scribe_clarifying stuck → scribe_failed event with stageStuck=scribe_clarifying
it('marks stageStuck=scribe_clarifying when that stage times out', async () => { ... });
```

`makeStuckStore`'a opsiyonel stage parametresi eklenir (default `'trace_testing'`).

- [ ] **Step 2: Verify tests fail**

Run: `pnpm -C backend exec tsx --test test/unit/pipeline-reconciler-chat-event.test.ts`
Expected: 3 new tests FAIL (current code only handles trace_testing)

- [ ] **Step 3: Implement stage→event mapping**

`PipelineReconciler.ts:92-117` içindeki block'u şu şekilde değiştir:

```ts
type StuckEventMap = {
  [K in PipelineStage]?:
    | { type: 'trace_failed' }
    | { type: 'scribe_failed' }
    | { type: 'proto_failed' };
};
const eventTypeByStage: StuckEventMap = {
  trace_testing: { type: 'trace_failed' },
  scribe_generating: { type: 'scribe_failed' },
  scribe_clarifying: { type: 'scribe_failed' },
  proto_building: { type: 'proto_failed' },
};
const eventSpec = eventTypeByStage[p.stage];

const conversation = eventSpec
  ? [
      ...full.scribeConversation,
      buildStuckEvent(eventSpec.type, p.stage, full.scribeConversation, stuckMinutes),
    ]
  : full.scribeConversation;
```

Helper (aynı dosyada, dosya altı):

```ts
function buildStuckEvent(
  type: 'trace_failed' | 'scribe_failed' | 'proto_failed',
  stage: PipelineStage,
  conv: ScribeMessageType[],
  stuckMinutes: number
): ScribeMessageType {
  const stageLabel = stageLabelTR(stage); // see Task 6
  const errorMessage = `${stageLabel} ${stuckMinutes} dakika boyunca yanıt vermedi. Otomatik olarak durduruldu.`;
  const base = {
    errorCode: 'PIPELINE_TIMEOUT',
    errorMessage,
    recoveryAction: 'retry' as const,
    timestamp: new Date().toISOString(),
  };
  if (type === 'trace_failed') {
    const iteration = conv.filter((m: ScribeMessageType) => m.type === 'trace_completed').length + 1;
    return { type, content: { iteration, ...base } };
  }
  if (type === 'proto_failed') {
    const iteration = conv.filter((m: ScribeMessageType) => m.type === 'proto_completed').length + 1;
    return { type, content: { iteration, ...base } };
  }
  return { type, content: { stageStuck: stage, ...base }, timestamp: base.timestamp };
}
```

Not: stageLabelTR fonksiyonu Task 6'da yazılacak; bu task'ta inline placeholder ("scribe_generating" gibi raw string) ile başla, Task 6'da swap edilir. **Inline ile başla:**

```ts
const stageLabel: Record<PipelineStage, string> = {
  scribe_clarifying: 'Fikir analiz adımı',
  scribe_generating: 'Fikir analiz adımı',
  proto_building: 'Kod üretim adımı',
  trace_testing: 'Test üretim adımı',
  critic_reviewing_spec: 'İnceleme adımı',
  critic_reviewing_code: 'İnceleme adımı',
  awaiting_approval: 'Onay bekleme',
  awaiting_critic_resolution: 'İnceleme sonrası karar',
  awaiting_push_confirm: 'Gönderim onayı',
  fix_loop_iteration: 'Düzeltme döngüsü',
  ci_running: 'CI kontrol',
  completed: 'Tamamlandı',
  completed_partial: 'Kısmen tamamlandı',
  failed: 'Başarısız',
  cancelled: 'İptal edildi',
};
```

- [ ] **Step 4: Verify tests pass**

Run: `pnpm -C backend exec tsx --test test/unit/pipeline-reconciler-chat-event.test.ts`
Expected: ALL tests PASS (1 existing + 3 new)

- [ ] **Step 5: Commit**

```bash
git add backend/src/pipeline/core/PipelineReconciler.ts backend/test/unit/pipeline-reconciler-chat-event.test.ts
git commit -m "feat(reconciler): emit scribe_failed/proto_failed on stage timeout"
```

---

## Task 3: Frontend ScribeMessageType + ConversationMessage mirror

**Files:**
- Modify: `frontend/src/types/pipeline.ts` (ScribeMessageType union)
- Modify: `frontend/src/types/workflow.ts:78-138` (ConversationMessage union)

- [ ] **Step 1: Extend frontend ScribeMessageType to match backend**

Backend'le aynı `scribe_failed` + `proto_failed` variant'larını ekle.

- [ ] **Step 2: Extend ConversationMessage with new variants**

`workflow.ts:78-138` ConversationMessage union'a:

```ts
| {
    type: 'scribe_failed';
    content: { stageStuck: string; errorCode: string; errorMessage: string; recoveryAction?: 'retry' };
    timestamp?: string;
  }
| {
    type: 'proto_failed';
    content: { iteration?: number; errorCode: string; errorMessage: string; recoveryAction?: 'retry' };
    timestamp?: string;
  }
```

- [ ] **Step 3: typecheck**

Run: `pnpm -C frontend typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types/pipeline.ts frontend/src/types/workflow.ts
git commit -m "feat(types/frontend): mirror scribe_failed/proto_failed unions"
```

---

## Task 4: workflows.ts mapper — new event types

**Files:**
- Modify: `frontend/src/services/api/workflows.ts` (mapConversation function)
- Test: `frontend/src/services/api/__tests__/workflows.test.ts` (add 2 cases)

- [ ] **Step 1: Add failing tests**

```ts
it('maps scribe_failed event to ConversationMessage', () => {
  const result = mapConversation([
    {
      type: 'scribe_failed',
      content: { stageStuck: 'scribe_generating', errorCode: 'PIPELINE_TIMEOUT', errorMessage: 'Fikir analiz adımı 15 dakika boyunca yanıt vermedi.', recoveryAction: 'retry' },
      timestamp: '2026-05-22T10:00:00Z',
    },
  ]);
  expect(result).toHaveLength(1);
  expect(result[0].type).toBe('scribe_failed');
});

it('maps proto_failed event to ConversationMessage', () => { ... });
```

- [ ] **Step 2: Implement mapping**

`mapConversation`'da yeni case'leri PR #609'un trace_failed pattern'ini takip ederek ekle:

```ts
if (m.type === 'scribe_failed') {
  return {
    type: 'scribe_failed',
    content: m.content,
    timestamp: m.timestamp ?? new Date().toISOString(),
  };
}
if (m.type === 'proto_failed') {
  return {
    type: 'proto_failed',
    content: m.content,
    timestamp: m.timestamp ?? new Date().toISOString(),
  };
}
```

- [ ] **Step 3: Verify tests pass**

Run: `pnpm -C frontend test --run workflows.test.ts`

- [ ] **Step 4: Commit**

```bash
git add frontend/src/services/api/workflows.ts frontend/src/services/api/__tests__/workflows.test.ts
git commit -m "feat(workflows): map scribe_failed/proto_failed events"
```

---

## Task 5: PipelineErrorBanner — render technicalDetail

**Files:**
- Modify: `frontend/src/components/chat/PipelineErrorBanner.tsx:79,115-119`
- Test: `frontend/src/components/chat/__tests__/PipelineErrorBanner.test.tsx` (add 3 cases)

- [ ] **Step 1: Add failing tests**

```ts
it('renders error.technicalDetail when set', () => {
  const error = {
    code: 'PIPELINE_TIMEOUT',
    message: 'İşlem beklenenden uzun sürdü.',
    technicalDetail: 'Test üretim adımı 15 dakika yanıt vermedi.',
    retryable: true,
    recoveryAction: 'retry' as const,
  };
  render(<PipelineErrorBanner error={error} />);
  expect(screen.getByTestId('banner-stage-detail')).toHaveTextContent(/Test üretim adımı 15 dakika/);
});

it('omits banner-stage-detail when technicalDetail is undefined', () => { ... });

it('omits banner-stage-detail when technicalDetail equals message (no dup)', () => { ... });
```

- [ ] **Step 2: Implement**

`PipelineErrorBanner.tsx` içinde, mevcut `banner-technical-detail` span'inin ALTINDA:

```tsx
{error.technicalDetail && error.technicalDetail !== error.message && (
  <span className="text-[11px] text-ak-text-muted" data-testid="banner-stage-detail">
    {error.technicalDetail}
  </span>
)}
```

`PipelineError` tipini doğrula (`frontend/src/types/pipeline.ts:169` — zaten var).

- [ ] **Step 3: Verify**

Run: `pnpm -C frontend test --run PipelineErrorBanner.test.tsx`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/chat/PipelineErrorBanner.tsx frontend/src/components/chat/__tests__/PipelineErrorBanner.test.tsx
git commit -m "feat(banner): render error.technicalDetail as stage-detail line"
```

---

## Task 6: Stage-aware copy helper (backend + frontend shared concept)

**Files:**
- Create: `backend/src/pipeline/core/utils/stageLabels.ts`
- Modify: `backend/src/pipeline/core/PipelineReconciler.ts` (swap inline map → helper)
- Test: `backend/test/unit/stage-labels.test.ts` (new)

- [ ] **Step 1: Write helper test**

```ts
import { stageLabelTR } from '../../src/pipeline/core/utils/stageLabels.js';

describe('stageLabelTR', () => {
  it('maps known stages to Turkish work labels', () => {
    assert.equal(stageLabelTR('scribe_generating'), 'Fikir analiz adımı');
    assert.equal(stageLabelTR('proto_building'), 'Kod üretim adımı');
    assert.equal(stageLabelTR('trace_testing'), 'Test üretim adımı');
  });
  it('falls back to "İşlem" for unmapped stages', () => {
    assert.equal(stageLabelTR('completed'), 'İşlem');
  });
});
```

- [ ] **Step 2: Implement helper**

```ts
import type { PipelineStage } from '../contracts/PipelineTypes.js';

const STAGE_LABELS_TR: Partial<Record<PipelineStage, string>> = {
  scribe_clarifying: 'Fikir analiz adımı',
  scribe_generating: 'Fikir analiz adımı',
  proto_building: 'Kod üretim adımı',
  trace_testing: 'Test üretim adımı',
  critic_reviewing_spec: 'İnceleme adımı',
  critic_reviewing_code: 'İnceleme adımı',
  fix_loop_iteration: 'Düzeltme döngüsü',
};

export function stageLabelTR(stage: PipelineStage): string {
  return STAGE_LABELS_TR[stage] ?? 'İşlem';
}
```

- [ ] **Step 3: Refactor Reconciler to use helper**

Inline map'i sil; `stageLabelTR(stage)` çağrısına swap et.

- [ ] **Step 4: Verify**

Run: `pnpm -C backend exec tsx --test test/unit/stage-labels.test.ts test/unit/pipeline-reconciler-chat-event.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/pipeline/core/utils/stageLabels.ts backend/src/pipeline/core/PipelineReconciler.ts backend/test/unit/stage-labels.test.ts
git commit -m "refactor(reconciler): extract stageLabelTR helper"
```

---

## Task 7: Frontend errorMessages.ts — kısaltılmış PIPELINE_TIMEOUT detail

**Files:**
- Modify: `frontend/src/utils/errorMessages.ts:98-103`
- Modify: `frontend/src/utils/__tests__/errorMessages.test.ts:62-67`

- [ ] **Step 1: Update test to match new copy**

```ts
it('maps PIPELINE_TIMEOUT to a timeout title with stage-aware detail expectation', () => {
  const friendly = errorCodeToFriendlyMessage('PIPELINE_TIMEOUT');
  expect(friendly.title).toContain('zaman aşımına');
  expect(friendly.detail).toContain('teknik detay'); // points to technicalDetail line
});
```

- [ ] **Step 2: Update copy**

```ts
PIPELINE_TIMEOUT: {
  title: 'İşlem zaman aşımına uğradı',
  detail:
    'Bir adım yanıt vermedi. Aşağıdaki teknik detay hangi adımın ne kadar süredir durduğunu gösterir.',
  severity: 'warn',
},
```

- [ ] **Step 3: Verify**

Run: `pnpm -C frontend test --run errorMessages.test.ts`

- [ ] **Step 4: Commit**

```bash
git add frontend/src/utils/errorMessages.ts frontend/src/utils/__tests__/errorMessages.test.ts
git commit -m "feat(error-copy): PIPELINE_TIMEOUT detail points to technicalDetail line"
```

---

## Task 8: Backend PipelineErrors.ts — kısaltılmış default message

**Files:**
- Modify: `backend/src/pipeline/core/contracts/PipelineErrors.ts:178-182`

- [ ] **Step 1: Update message**

```ts
[PipelineErrorCode.PIPELINE_TIMEOUT]: {
  message: 'Bir adım yanıt vermedi. Teknik detay aşağıdaki satırda.',
  retryable: true,
  recoveryAction: 'retry',
},
```

NF-2 garanti: bu yeni mesaj, reconciler'ın technicalDetail'a yazdığı stage-spesific string'le **eşit değil** → banner çift gösterimi tetiklemez.

- [ ] **Step 2: Verify backend tests**

Run: `pnpm -C backend test:unit`
Expected: PASS (varsa mesaj string'ine assert eden test'leri update et)

- [ ] **Step 3: Commit**

```bash
git add backend/src/pipeline/core/contracts/PipelineErrors.ts
git commit -m "feat(errors): shorten PIPELINE_TIMEOUT default message"
```

---

## Task 9: Live failed pipeline e2e

**Files:**
- Create: `docs/dogfooding/screenshots/failed-state-2026-05-22-{1..4}.png`
- Modify: `docs/superpowers/plans/2026-05-22-failed-state-holistic.md` (this file — visual confirm bullet)

- [ ] **Step 1: Trace timeout zorla**

`STAGE_TIMEOUT_MS_OVERRIDE=10000` veya kod yolu: orchestrator runTrace'te early throw. Tercih: env override yoksa, bir test fixture pipeline kullan, AI provider'ı `mock`'a çek ve mock'tan timeout simüle et.

En basit: backend `.env`'de `AI_PROVIDER=mock` + mock'a `MOCK_TRACE_TIMEOUT=true` flag'i. Yoksa, Reconciler'ı manuel tetikle: pipeline'ı `trace_testing` state'inde bırak, `updated_at`'ı 20 dk öncesi olarak update et, sweep çağır.

```bash
PGPASSWORD=postgres psql -h localhost -p 5433 -U postgres -d akis_v2 -c \
  "UPDATE pipelines SET updated_at = now() - interval '20 minutes' WHERE id = '<test-pipeline-id>';"
# sonra sweep tetikleyici route'u varsa hit et, yoksa SWEEP_INTERVAL_MS'i bekle (5 dk)
```

- [ ] **Step 2: Screenshot'ları al**

Playwright MCP üzerinden:
1. Cinema rail rose-themed Trace ✗ kartı — `failed-state-2026-05-22-cinema.png`
2. Chat'te TraceFailureMessage (Tekrar Dene/Skip butonlu) — `failed-state-2026-05-22-trace-failure.png`
3. PipelineErrorBanner (title + detail + technical + stage-detail satırları) — `failed-state-2026-05-22-banner.png`
4. Rail auto-expanded full view — `failed-state-2026-05-22-rail.png`

- [ ] **Step 3: Bu plan dosyasının "Visual confirm" bölümünü doldur**

Plan dosyasının altına:

```markdown
## Visual confirm (2026-05-22)

- [x] Cinema rose Trace ✗ kart → `docs/dogfooding/screenshots/failed-state-2026-05-22-cinema.png`
- [x] TraceFailureMessage butonlu → `failed-state-2026-05-22-trace-failure.png`
- [x] Banner 4 satır → `failed-state-2026-05-22-banner.png`
- [x] Rail auto-expand → `failed-state-2026-05-22-rail.png`
```

- [ ] **Step 4: Commit**

```bash
git add docs/dogfooding/screenshots/failed-state-2026-05-22-*.png docs/superpowers/plans/2026-05-22-failed-state-holistic.md
git commit -m "test(e2e): live failed pipeline visual confirms"
```

---

## After all tasks

Branch için `gh pr create`. PR title önerisi:

> `feat(failed-state): reconciler scribe/proto events + banner stage-detail + stage-aware timeout copy`

PR body 4 bölüm: Background (PR #609 üzerine), Changes (A1-A4 madde madde), Screenshots (A4 outputs), Test plan.
