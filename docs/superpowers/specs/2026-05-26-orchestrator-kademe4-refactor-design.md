# PipelineOrchestrator Kademe 4 — Structural Refactor Design Spec

**Date:** 2026-05-26
**Author:** AKIS (Claude + Ömer)
**Status:** Draft
**Scope:** Backend-only refactor. Single atomic PR. No behavioral change — pure structural improvement with compile-time safety gains.
**Prerequisite:** Kademe 3 (PR #634) outcome-driven state machine already merged.

---

## 1. Findings — Mevcut Durumun Problemleri

### F-1: Untyped IntermediateState (Risk: High)

`PipelineState.intermediateState` tipi `Record<string, unknown>` olarak tanımlanmış. Codebase genelinde **31 ayrı key** bu bag'e yazılıp okunuyor. Her access noktası `as Record<string, unknown>` veya `as X | undefined` cast'i gerektiriyor.

**Etki:**
- **60+ unsafe cast** backend ve frontend genelinde
- Yanlış key adı (typo) derleme zamanında yakalanamıyor
- Frontend component'leri (`PushConfirmGate`, `ExplanationPanel`, `PipelineCinema`) intermediateState key'lerine doğrudan bağımlı — key rename'i sessizce UI'ı kırıyor
- `writeCheckpoint` metodu `agent`, `startedAt`, `status`, `inputSummary` key'lerini yazıyor ama bunlar critic/trace key'leriyle aynı namespace'i paylaşıyor

**Kanıt:** Exhaustive key inventory (31 key, 9 domain group):

| Domain | Keys | Write Locations | Read Locations |
|---|---|---|---|
| Origin | parentPipelineId, existingRepo, iterationRequest, attachmentContext, imageBlocks, cucumberEnabled | Orchestrator startPipeline, _sendMessage | Orchestrator runScribe/runIteration, unifiedPipelineContext, DrizzlePipelineStore |
| Checkpoint | agent, startedAt, status, inputSummary | Orchestrator writeCheckpoint | (internal only) |
| Validation | validationResult | Orchestrator runProtoAndTrace | activityHelpers |
| Critic | criticSpecOutput, criticCodeOutput, criticBlock, criticIterateRetryCount, iterationHistory | Orchestrator handleScribeResult, runProtoAndTrace; iterateDispatchers | activityHelpers, frontend workflows/mapPipelineEvent |
| TraceLoop | traceIterateRetryCount, traceIterateLastFeedback, traceIterateLastAt, traceDryRunStatus, traceDryRunErrorCode, traceDryRunErrorAt, traceDryRunCompletedAt, lastFailedTraceResponse, traceSkipReason | Orchestrator runTrace, _criticOverride; iterateDispatchers; TraceOutcome handler | frontend workflows, retryHandlers |
| AutoApprove | autoApproved, autoApproveScore | Orchestrator handleScribeResult | (internal only) |
| CI | ciResult | Orchestrator runCiPolling | frontend workflows, pipeline types |
| Coverage | acCoverage | reasoningHelpers | frontend workflows, activityHelpers |
| Explainability | explainabilityDegraded, explainabilityDegradedAt | reasoningHelpers | frontend workflows |

### F-2: Excessive getPipeline Calls (Risk: Medium)

Tek bir `runProtoAndTrace` çağrısında pipeline **en az 6 kez** DB'den okunuyor:
- L1544: protoKnowledge context
- L1665: traceEnabled, scribeOutput, jiraConfig
- L1758: validation intermediateState merge
- L1868: critic intermediateState merge
- L2052: protoConfig sync

`runTrace` metodu da **8+ kez** pipeline okuyor. `runScribeAnalysis` 3 kez (L807, L870, L881) aynı pipeline'ı okuyor.

**Toplam:** ~50 call site, **7 confirmed redundant** (aynı method scope'unda zaten yüklenmiş pipeline'ın tekrar okunması).

**Etki:**
- Her `getPipeline` = 1 DB round trip (~2-5ms)
- `runProtoAndTrace` tek başına ~30-40ms gereksiz DB latency
- Full pipeline run (Scribe→Proto→Trace) ~100ms+ gereksiz DB yükü
- `updatePipelineConfig` (L2854) pipeline'ı okuyup hiç kullanmıyor — ölü çağrı

### F-3: runProtoAndTrace Mega-Method (Risk: Medium)

560 satır, 8 return path. Kademe 3 outcome pattern'ı side-effect'leri `handleProtoTraceOutcome`'a taşıdı, ama **karar ağacının kendisi** hâlâ bu method'da:
- Proto execute + cancellation check
- Artifact injection
- Deterministic Validator run + intermediateState write
- Critic code review + iterationHistory append
- Critic iterate loop evaluation
- Outcome construction (7 varyant)
- Post-handler Trace execution (dryRun vs auto-push)

**Etki:** Method'un cognitive complexity'si yüksek. Yeni bir Validator kuralı veya Critic davranışı eklemek 560 satırın ortasında navigasyon gerektiriyor.

### F-4: Thin Wrapper Inflation (Risk: Low)

Kademe 1+2 helper extraction'ı sonrası ana dosyada **15 thin wrapper** method kaldı. Her biri 2-4 satır — helper'ı çağırıp `this.store`, `this.explainability` gibi instance field'ları iletiyor. Toplam ~120 satır.

**Etki:** Kozmetik. Okunabilirliği düşürüyor ama runtime davranışı etkilemiyor. Stage extraction (F-3 çözümü) bu wrapper'ların çoğunu doğal olarak ortadan kaldıracak.

### F-5: FSM Transition Guard Eksikliği (Risk: Medium)

16 stage, 40+ transition. Geçerli transition'lar sadece `assertStage` guard'larıyla korunuyor (5 noktada). Geri kalan transition'lar implicit — `store.update({ stage: 'X' })` herhangi bir kaynak stage'den çağrılabilir.

**Kanıt:** PR #623'te `emitStageCompleted` çağrısı unutulmuş, cinema boş kalmıştı. Kademe 3 outcome handler bu sınıfı ortadan kaldırdı, ama yeni stage eklendiğinde transition tablosunun bütünlüğü yine garanti değil.

**Etki:** Geçersiz bir transition (ör: `completed` → `proto_building`) runtime'da sessizce gerçekleşebilir. Pipeline stuck-in-wrong-state bug'ları sadece production'da ortaya çıkar.

### F-6: process.env Doğrudan Erişim (Risk: Low)

`runProtoAndTrace` L1591'de `process.env.AUTO_PUSH_AFTER_PROTO` doğrudan okunuyor. Comment'te gerekçe var (test'lerde `getEnv()` zod validation'ı patlar), ama bu orchestrator'daki tek env erişim noktası ve pattern'den sapma.

**Etki:** Düşük. Ama stage extraction sırasında bu erişim deps interface'ine taşınacak, sorun doğal olarak çözülecek.

---

## 2. Requirements

### 2.1 Functional

| ID | Gereksinim | Kaynak |
|---|---|---|
| FR-K4-1 | `intermediateState` tipi `PipelineIntermediateState` typed interface olmalı | F-1 |
| FR-K4-2 | Type 9 domain group olarak organize edilmeli (intersection type) | F-1 domain tablosu |
| FR-K4-3 | Tüm `as Record<string, unknown>` cast'leri kaldırılmalı, doğru property access'e çevrilmeli | F-1 |
| FR-K4-4 | Stage runner method'ları (`runProtoAndTrace`, `runTrace`, `runScribeAnalysis`, `runScribeContinuation`, `runConfirmedPush`, `runCiPolling`, `runIterationProtoAndTrace`) standalone function'lara çıkarılmalı | F-3, F-4 |
| FR-K4-5 | Her stage runner bir `deps` interface almalı (Kademe 2+3 pattern'ıyla tutarlı) | F-3 |
| FR-K4-6 | `PipelineExecutionContext` scoped cache sınıfı eklenecek, stage runner'lara parametre olarak geçilecek | F-2 |
| FR-K4-7 | `VALID_TRANSITIONS` compile-time transition tablosu tanımlanacak | F-5 |
| FR-K4-8 | `transitionTo()` guard fonksiyonu her `store.update({ stage })` çağrısından önce çağrılmalı | F-5 |
| FR-K4-9 | Ana `PipelineOrchestrator` class'ı refactor sonrası ≤1200 satır olmalı | F-3, F-4 |
| FR-K4-10 | `process.env.AUTO_PUSH_AFTER_PROTO` erişimi deps interface'ine `previewGateEnabled: boolean` olarak taşınmalı | F-6 |

### 2.2 Non-Functional

| ID | Gereksinim |
|---|---|
| NFR-K4-1 | Sıfır davranış değişikliği — tüm mevcut testler (backend unit + integration) yeşil kalmalı |
| NFR-K4-2 | `pnpm -C backend typecheck` sıfır hata |
| NFR-K4-3 | `pnpm -C backend lint` sıfır hata |
| NFR-K4-4 | Frontend'de hiçbir değişiklik yok — `intermediateState` type'ı backend-only, frontend kendi cast'lerini korur (frontend type sync ayrı concern) |
| NFR-K4-5 | Migration yok — DB schema değişmez, JSONB column aynen kalır |
| NFR-K4-6 | Import cycle oluşmamalı — yeni dosyalar mevcut dependency graph'ına uyumlu |
| NFR-K4-7 | Kademe 1+2+3'te kurulan pattern'lar (helpers/, stages/, outcomes/) korunmalı ve genişletilmeli |

---

## 3. Architecture

### 3.1 Katman 1: PipelineIntermediateState Typed Interface

**Karar:** Domain-grouped intersection type. Zod runtime validation **eklenmeyecek**.

**Gerekçe:** Drizzle JSONB column'ı runtime'da zaten serbest. Zod schema eklemek her DB read'de validation overhead'i getirir ve mevcut pipeline'ların backward-compat'ını kırar (eski row'larda eksik key'ler Zod'u patlatır). TypeScript compile-time safety yeterli — access noktalarında type narrowing ile güvenlik sağlanır.

```
backend/src/pipeline/core/contracts/IntermediateState.ts (YENİ)
```

```typescript
import type { CriticReviewOutput } from '../../agents/critic/CriticTypes.js';
import type { AnthropicImageBlock } from '../../../services/ai/multimodalClient.js';
import type { CIResult } from '../../services/CIService.js';
import type { AcCoverageReport } from '../explainability/acCoverage.js';

// ─── Domain Groups ─────────────────────────────

export interface OriginState {
  parentPipelineId?: string;
  existingRepo?: { owner: string; repo: string; branch: string };
  iterationRequest?: string;
  attachmentContext?: string;
  imageBlocks?: readonly AnthropicImageBlock[];
  cucumberEnabled?: boolean;
}

export interface CheckpointState {
  agent?: string;
  startedAt?: string;
  status?: 'in_progress' | 'completed' | 'failed';
  inputSummary?: string;
}

export interface ValidationState {
  validationResult?: {
    passed: boolean;
    score: number;
    summary: { errors: number; warnings: number; checksRun: string[] };
  };
}

export interface CriticState {
  criticSpecOutput?: CriticReviewOutput;
  criticCodeOutput?: CriticReviewOutput;
  criticBlock?: {
    blockedAt: string;
    overallScore: number;
    findingsCount: number;
    maxSeverity: string;
    manuallyOverridden?: boolean;
    overriddenAt?: string;
  };
  criticIterateRetryCount?: number;
  iterationHistory?: IterationHistoryEntry[];
}

export interface IterationHistoryEntry {
  iteration: number;
  protoConfidence: number | null;
  criticScore: number | null;
  criticFindingsCount: number;
  criticCriticalCount: number;
  timestamp: string;
  decision: string;
}

export interface TraceLoopState {
  traceIterateRetryCount?: number;
  traceIterateLastFeedback?: string;
  traceIterateLastAt?: string;
  traceDryRunStatus?: 'success' | 'failed';
  traceDryRunErrorCode?: string;
  traceDryRunErrorAt?: string;
  traceDryRunCompletedAt?: string;
  lastFailedTraceResponse?: string;
  traceSkipReason?: string;
}

export interface AutoApproveState {
  autoApproved?: boolean;
  autoApproveScore?: number;
}

export interface CIIntegrationState {
  ciResult?: CIResult;
}

export interface CoverageState {
  acCoverage?: AcCoverageReport;
}

export interface ExplainabilityState {
  explainabilityDegraded?: boolean;
  explainabilityDegradedAt?: string;
}

// ─── Composed Type ────────────────────────────

export type PipelineIntermediateState =
  OriginState &
  CheckpointState &
  ValidationState &
  CriticState &
  TraceLoopState &
  AutoApproveState &
  CIIntegrationState &
  CoverageState &
  ExplainabilityState;
```

**Migrasyon:**
1. Type'ı tanımla
2. `PipelineTypes.ts`'te `intermediateState?: Record<string, unknown>` → `intermediateState?: PipelineIntermediateState`
3. Compiler hatalarını takip et — her `as Record<string, unknown>` cast'i kaldır
4. `writeCheckpoint`'te `{ ...existing, agent, startedAt }` pattern'ı doğal olarak type-safe olur
5. Frontend **dokunulmaz** — frontend kendi type'larını API response'dan cast eder (NFR-K4-4)

**AcCoverageReport type'ı:** `explainability/acCoverage.ts:34`'te tanımlı — `{ totalAcs: number; staticCoveredCount: number; dynamicCoveredCount: number; items: AcCoverageItem[] }`. Import path: `../explainability/acCoverage.js`.

### 3.2 Katman 2: PipelineExecutionContext

**Karar:** Basit scoped cache — ORM identity map değil. `get()` + `invalidate()` pattern'ı.

**Gerekçe:** Full identity map (Hibernate/TypeORM style) bu codebase için over-engineering. Pipeline state tek bir aggregate root — tek snapshot yeterli. `store.update` sonrası `invalidate()` çağırmak, sonraki `get()`'in taze veri okumasını garanti eder.

```
backend/src/pipeline/core/orchestrator/PipelineExecutionContext.ts (YENİ)
```

```typescript
import type { PipelineState } from '../contracts/PipelineTypes.js';
// PipelineStore şu an PipelineOrchestrator.ts'te tanımlı. Circular import
// riski yok çünkü `import type` kullanılıyor (TypeScript type-only import
// runtime'da çözülmez). Mevcut helpers/stateHelpers.ts de aynı pattern'ı
// kullanıyor. PipelineStore'un ayrı dosyaya taşınması ileride yapılabilir
// ama bu refactor'ın scope'u dışında.
import type { PipelineStore } from './PipelineOrchestrator.js';

export class PipelineExecutionContext {
  private snapshot: PipelineState | null = null;
  private readCount = 0;

  constructor(
    private readonly store: PipelineStore,
    readonly pipelineId: string
  ) {}

  /** Return cached pipeline state, or fetch from DB on first call. */
  async get(): Promise<PipelineState> {
    if (!this.snapshot) {
      const row = await this.store.getById(this.pipelineId);
      if (!row) throw new Error(`Pipeline not found: ${this.pipelineId}`);
      this.snapshot = row;
      this.readCount++;
    }
    return this.snapshot;
  }

  /**
   * Clear the cached snapshot. Must be called after any store.update()
   * that changes fields the current method will re-read.
   */
  invalidate(): void {
    this.snapshot = null;
  }

  /** How many actual DB reads this context performed (observability). */
  get dbReads(): number {
    return this.readCount;
  }
}
```

**Kullanım pattern'ı:**

```typescript
// ÖNCE (runProtoAndTrace içinde):
const pipelineData = await this.getPipeline(pipelineId);  // DB read 1
// ... 200 satır sonra ...
const pipeline = await this.getPipeline(pipelineId);       // DB read 2 (redundant)

// SONRA:
const ctx = new PipelineExecutionContext(this.store, pipelineId);
const pipelineData = await ctx.get();  // DB read 1
// ... 200 satır sonra ...
const pipeline = await ctx.get();       // cache hit, 0ms
// ... store.update sonrası ...
ctx.invalidate();
const fresh = await ctx.get();          // DB read 2 (taze veri)
```

**invalidate() stratejisi:** Her `store.update` çağrısından sonra `invalidate()` çağırmak gerekir — ama **sadece** güncellenen field'lar sonradan okunacaksa. Pratik kural: outcome handler'lar ve stage runner'lar `store.update` yaptıktan sonra method'dan çıkıyorlarsa (return path) invalidate gerekmez. Sadece mid-method update'lerde (ör: validation result yazıp sonra aynı pipeline'dan traceEnabled okumak) gerekir.

**Stage runner'lara geçiş:** `ctx: PipelineExecutionContext` stage runner'ların deps interface'ine eklenir. Runner, `ctx.get()` ile pipeline'a erişir. Runner başında 1 DB read, sonrası cache hit.

### 3.3 Katman 3: FSM Transition Guard Table

**Karar:** Compile-time `VALID_TRANSITIONS` const record + `assertValidTransition()` guard function. XState **kullanılmayacak**.

**Gerekçe:** XState (veya benzeri FSM kütüphanesi) 16 state + 40 transition'lık bir FSM için aşırı. Mevcut `assertStage` pattern'ı zaten çalışıyor — eksik olan sadece transition doğrulaması. Bir const record + guard function, sıfır dependency ile aynı güvenliği sağlıyor.

```
backend/src/pipeline/core/contracts/PipelineTransitions.ts (YENİ)
```

```typescript
import type { PipelineStage } from './PipelineTypes.js';

/**
 * Compile-time-enforced transition table. Every stage must appear as a
 * key (enforced by Record<PipelineStage, ...>); values list the stages
 * reachable from that key.
 *
 * Adding a new PipelineStage variant without an entry here is a
 * compile-time error. Attempting a transition not listed here is a
 * runtime assertion failure (caught in dev/test, logged in prod).
 */
export const VALID_TRANSITIONS: Record<PipelineStage, readonly PipelineStage[]> = {
  // Scribe phase
  scribe_generating:      ['scribe_clarifying', 'awaiting_approval', 'critic_reviewing_spec', 'failed'],
  scribe_clarifying:      ['scribe_generating', 'failed'],

  // Critic spec review
  critic_reviewing_spec:  ['awaiting_approval', 'proto_building', 'failed'],

  // Approval gate
  awaiting_approval:      ['proto_building', 'scribe_generating', 'failed', 'cancelled'],

  // Proto phase
  proto_building:         ['critic_reviewing_code', 'trace_testing', 'awaiting_push_confirm', 'completed', 'completed_partial', 'ci_running', 'failed', 'cancelled'],

  // Critic code review
  critic_reviewing_code:  ['proto_building', 'awaiting_critic_resolution', 'trace_testing', 'awaiting_push_confirm', 'failed', 'cancelled'],

  // Critic hard-block
  awaiting_critic_resolution: ['awaiting_push_confirm', 'proto_building', 'failed', 'cancelled'],

  // Trace phase
  trace_testing:          ['completed', 'completed_partial', 'awaiting_push_confirm', 'fix_loop_iteration', 'proto_building', 'failed', 'cancelled'],

  // Fix loop
  fix_loop_iteration:     ['completed', 'completed_partial', 'failed', 'cancelled'],

  // CI polling
  ci_running:             ['completed', 'completed_partial', 'failed', 'cancelled'],

  // Push confirm gate
  awaiting_push_confirm:  ['proto_building', 'completed', 'completed_partial', 'ci_running', 'failed', 'cancelled'],

  // Terminal states
  completed:              ['cancelled'],
  completed_partial:      ['cancelled'],
  failed:                 ['scribe_clarifying', 'scribe_generating', 'proto_building', 'trace_testing', 'awaiting_push_confirm', 'cancelled'],
  cancelled:              [],
} as const;

/**
 * Validate that a stage transition is legal. In development/test, throws
 * InvalidTransitionError. In production, logs a warning and allows the
 * transition (fail-open to avoid bricking pipelines).
 *
 * Usage: call before every `store.update({ stage })`.
 */
export function assertValidTransition(
  from: PipelineStage,
  to: PipelineStage,
  pipelineId: string
): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    const msg = `Invalid FSM transition: ${from} → ${to} (pipeline ${pipelineId}). Allowed: [${allowed.join(', ')}]`;
    if (process.env.NODE_ENV === 'production') {
      // Fail-open in production: log but don't throw
      // (prevents bricking running pipelines due to an incomplete transition table)
      import('../../../lib/logger.js').then(({ logger }) =>
        logger.error({ pipelineId, from, to }, msg)
      ).catch(() => { /* exhausted */ });
    } else {
      throw new Error(msg);
    }
  }
}
```

**Wire-up stratejisi:**

Doğrudan her `store.update({ stage })` çağrısının önüne `assertValidTransition` eklemek yerine, orchestrator'a bir `transitionStage()` helper eklenecek:

```typescript
private async transitionStage(
  pipelineId: string,
  from: PipelineStage,
  to: PipelineStage,
  extraUpdate?: Partial<PipelineStateUpdate>,
  opts?: { expectedStageVersion?: number }
): Promise<PipelineState> {
  assertValidTransition(from, to, pipelineId);
  return this.store.update(pipelineId, { stage: to, ...extraUpdate }, opts);
}
```

Stage runner'lar deps interface üzerinden bu helper'a erişir. Outcome handler'lar zaten `deps.store.update` çağırıyor — bu çağrılar `deps.transitionStage`'e çevrilecek.

**Karar: Fail-open production, fail-hard dev/test.** Gerekçe: Tablo eksikliği production'da pipeline'ı brick'lememeli. Dev/test'te ise hızlı feedback döngüsü sağlar.

### 3.4 Katman 4: Stage Runner Extraction

**Karar:** 7 stage runner method'u standalone function'lara çıkarılacak. Ana class ~800-1000 satır facade olacak.

**Gerekçe:** Kademe 2 (helpers + stages) extraction'ı kanıtlanmış pattern. Kademe 3 (outcomes) deps interface pattern'ı kanıtlanmış. Bu katman ikisini birleştirip "büyük method'ları" taşıyacak.

**Çıkarılacak method'lar ve hedef dosyalar:**

```
backend/src/pipeline/core/orchestrator/stages/
  retryHandlers.ts          (MEVCUT — 303 LOC)
  iterateDispatchers.ts     (MEVCUT — 211 LOC)
  runScribeAnalysis.ts      (YENİ — ~120 LOC)
  runScribeContinuation.ts  (YENİ — ~60 LOC)
  runProtoAndTrace.ts       (YENİ — ~400 LOC, en büyük extraction)
  runTrace.ts               (YENİ — ~320 LOC)
  runIterationProto.ts      (YENİ — ~150 LOC)
  runConfirmedPush.ts       (YENİ — ~120 LOC)
  runCiPolling.ts           (YENİ — ~80 LOC)
```

**Her stage runner'ın deps interface'i:**

```typescript
// Örnek: RunProtoAndTraceDeps
export interface RunProtoAndTraceDeps {
  store: PipelineStore;
  ctx: PipelineExecutionContext;
  getAgents: (model?: string, pipelineId?: string) => AgentSet;
  createAgentsForModel?: (...) => AgentSet;
  createTokenCallback: (pipelineId: string) => TokenUsageCallback;
  transitionStage: (id: string, from: PipelineStage, to: PipelineStage, extra?: ...) => Promise<PipelineState>;
  emitEvent: (...) => void;
  emitStageCompleted: (...) => void;

  // Kademe 3 outcome deps
  buildProtoTraceOutcomeDeps: () => HandleProtoTraceOutcomeDeps;

  // Services
  validator: DeterministicValidator;
  securityGate: SecurityGate;
  metricsService: PipelineMetricsService;
  criticAgent?: CriticAgent;

  // Helpers (already extracted in Kademe 1)
  persistReasoning: (...) => void;
  recordProtoReasoning: (...) => void;
  applyArtifactInjection: (...) => ProtoOutput;
  persistAcCoverage: (...) => Promise<void>;
  appendProtoStarted: (...) => Promise<number>;
  runCriticCodeReview: (...) => Promise<CriticReviewOutput | null>;
  evaluateCriticIterateLoop: (...) => Promise<{...}>;

  // Config (replaces process.env access)
  previewGateEnabled: boolean;
}
```

**Ana class sonrası yapısı (~800-1000 LOC):**

```
PipelineOrchestrator {
  // ─── Fields (services, maps, config) ──── ~80 LOC
  // ─── Constructor + DI setters ─────────── ~80 LOC
  // ─── Public API (with withLock) ───────── ~200 LOC
  //     startPipeline, sendMessage, approveSpec, rejectSpec,
  //     retryStage, cancelPipeline, confirmPush, cancelPush,
  //     skipTrace, iterateProtoFromFeedback, criticOverride,
  //     toggleTrace, updatePipelineConfig, getStatus,
  //     listPipelines, listAllPipelines, listChildren,
  //     updateTitle, setModel
  // ─── Private: deps builders ───────────── ~100 LOC
  //     buildRunProtoAndTraceDeps, buildRunTraceDeps, etc.
  // ─── Private: handleScribeResult ──────── ~250 LOC (stays — interleaved with conversation state)
  // ─── Private: helpers (thin wrappers that survive) ~100 LOC
  //     transitionStage, failPipeline, emitEvent, withLock
  // ─── Private: service accessors ───────── ~60 LOC
  //     getMetricsService, getExplainability, etc.
}
```

**handleScribeResult neden kalıyor:** Bu method conversation state'i (`scribeConversation` array push'ları) ile iç içe geçmiş. Conversation mutation'ları orchestrator instance state'ine bağımlı (`.emit`, `.store.update` çift yönlü). Taşımak conversation management'ı da çıkarmayı gerektirir — bu Kademe 4 scope'unun dışında.

**Thin wrapper'ların kaderi:** Stage runner extraction sonrası 15 thin wrapper'dan:
- **~10 tanesi ortadan kalkar** — stage runner'lar helper'ları doğrudan deps üzerinden çağırır
- **~5 tanesi kalır** — `transitionStage`, `failPipeline`, `emitEvent`, `withLock`, `getAgents` gibi cross-cutting method'lar class'ta kalacak

---

## 4. Data Flow

### 4.1 Refactor Öncesi Akış (Mevcut)

```
User Request
  → PipelineOrchestrator.approveSpec()          [withLock]
    → this._approveSpec()                        [DB read: getPipeline]
      → this.runProtoAndTrace()                  [560 LOC, 6+ DB reads]
        → proto.execute()
        → this.getPipeline()                     [DB read: redundant]
        → this.validator.validate()
        → this.store.update(intermediateState)    [as Record<string, unknown>]
        → this.getPipeline()                     [DB read: redundant]
        → this.runCriticCodeReview()
        → this.store.update(intermediateState)    [as Record<string, unknown>]
        → handleProtoTraceOutcome()              [outcome handler]
        → this.runTrace()                        [320 LOC, 8+ DB reads]
```

### 4.2 Refactor Sonrası Akış

```
User Request
  → PipelineOrchestrator.approveSpec()           [withLock]
    → this._approveSpec()                         [DB read: ctx.get()]
      → runProtoAndTrace(pipelineId, deps)        [standalone fn, ~400 LOC]
        → ctx.get()                               [cache hit]
        → proto.execute()
        → deps.validator.validate()
        → deps.transitionStage(from, to, {...})   [FSM guard + update]
        → ctx.invalidate()
        → ctx.get()                               [DB read: 1 taze read]
        → deps.runCriticCodeReview()
        → deps.transitionStage(from, to, {...})   [FSM guard + update]
        → handleProtoTraceOutcome()               [outcome handler]
        → runTrace(pipelineId, traceDeps)          [standalone fn, ~320 LOC]
          → ctx.get()                             [cache hit or 1 read]
```

**Net DB read azalması:** `runProtoAndTrace` 6→2, `runTrace` 8→3, `runScribeAnalysis` 3→1. Toplam pipeline run: ~50 read → ~15 read.

---

## 5. File Inventory

### 5.1 Yeni Dosyalar

| Dosya | LOC (est.) | Amacı |
|---|---|---|
| `contracts/IntermediateState.ts` | ~130 | Type definitions (9 domain interfaces + helper types + 1 composed type) |
| `contracts/PipelineTransitions.ts` | ~80 | VALID_TRANSITIONS table + assertValidTransition guard |
| `orchestrator/PipelineExecutionContext.ts` | ~40 | Scoped pipeline cache |
| `stages/runScribeAnalysis.ts` | ~120 | Scribe analysis standalone |
| `stages/runScribeContinuation.ts` | ~60 | Scribe continuation standalone |
| `stages/runProtoAndTrace.ts` | ~400 | Proto+Trace pipeline standalone |
| `stages/runTrace.ts` | ~320 | Trace standalone |
| `stages/runIterationProto.ts` | ~150 | Iteration mode Proto standalone |
| `stages/runConfirmedPush.ts` | ~120 | Push confirmation standalone |
| `stages/runCiPolling.ts` | ~80 | CI workflow polling standalone |

### 5.2 Değişen Dosyalar

| Dosya | Değişiklik |
|---|---|
| `PipelineOrchestrator.ts` | 4063 → ~900 LOC (stage runner'lar çıkarılır, thin wrapper'lar azalır) |
| `contracts/PipelineTypes.ts` | `intermediateState?: Record<string, unknown>` → `PipelineIntermediateState` |
| `helpers/*.ts` | `as Record<string, unknown>` cast'leri kaldırılır |
| `stages/retryHandlers.ts` | `as Record<string, unknown>` cast'leri kaldırılır, `transitionStage` kullanımı |
| `stages/iterateDispatchers.ts` | Aynı |
| `outcomes/ProtoTraceOutcome.ts` | `transitionStage` kullanımı, typed intermediateState |
| `outcomes/TraceOutcome.ts` | Aynı |

### 5.3 Dokunulmayan Dosyalar

- Frontend — hiçbir dosya değişmez (NFR-K4-4)
- DB schema — migration yok (NFR-K4-5)
- Test dosyaları — mevcut testler olduğu gibi çalışır; sadece import path'leri değişebilir

---

## 6. Risk Assessment

| Risk | Olasılık | Etki | Mitigation |
|---|---|---|---|
| Transition tablosu eksik transition | Düşük | Medium | Fail-open production + dev/test'te hard fail. Mevcut 40+ transition tam haritalanmış |
| `ctx.invalidate()` unutulması | Medium | Low | Cache miss = stale data read. Ama mevcut kod zaten stale data okuyor (redundant getPipeline), yani worst case = status quo |
| Stage runner deps interface eksik dependency | Low | Medium | TypeScript compiler yakalar — eksik field = derleme hatası |
| `intermediateState` type'ı mevcut JSONB row'larla uyumsuz | Low | Low | Tüm field'lar optional. Eski row'lar sadece `undefined` döner, mevcut davranışla aynı |
| handleScribeResult'ın class'ta kalması future refactor'ı zorlaştırır | Low | Low | Bilinçli scope sınırı. Kademe 5'e ertelenebilir |

---

## 7. Acceptance Criteria

| ID | Kriter | Doğrulama |
|---|---|---|
| AC-1 | `pnpm -C backend typecheck` sıfır hata | CI gate |
| AC-2 | `pnpm -C backend lint` sıfır hata | CI gate |
| AC-3 | `pnpm -C backend test` tüm mevcut testler geçer | CI gate |
| AC-4 | `PipelineOrchestrator.ts` ≤ 1200 satır | `wc -l` check |
| AC-5 | `intermediateState` tipi `PipelineIntermediateState` — sıfır `as Record<string, unknown>` cast orchestrator dosyalarında | `grep` check |
| AC-6 | `VALID_TRANSITIONS` tablosu 16 stage'in tümünü kapsıyor | Compile-time: `Record<PipelineStage, ...>` enforces |
| AC-7 | `assertValidTransition` dev/test'te geçersiz transition'da throw | Unit test |
| AC-8 | `PipelineExecutionContext` stage runner'larda kullanılıyor, redundant `getPipeline` çağrıları elimine | Code review + grep |
| AC-9 | `process.env.AUTO_PUSH_AFTER_PROTO` doğrudan erişim yok — deps interface üzerinden | `grep` check |
| AC-10 | Yeni stage runner dosyaları `stages/` altında, deps interface pattern'ı takip ediyor | File structure check |
| AC-11 | Frontend'de sıfır değişiklik | `git diff frontend/` boş |

---

## 8. Out of Scope

| Konu | Neden Dışarıda | Gelecek |
|---|---|---|
| Frontend intermediateState typing | Ayrı concern — API response type'ları OpenAPI'den generate edilir | Ayrı PR |
| handleScribeResult extraction | Conversation state management iç içe geçmiş, scope aşar | Kademe 5 |
| DB migration (intermediateState column validation) | Runtime Zod validation eklenmeyecek kararı | İleride gerekirse |
| Test coverage artışı | Mevcut testler olduğu gibi geçmeli, yeni test eklenmesi ayrı concern | Ayrı PR |
| Mevcut PipelineStore interface refactoru | Store interface'i değişmiyor, sadece yeni stage runner'lar onu deps üzerinden alıyor | İleride |
