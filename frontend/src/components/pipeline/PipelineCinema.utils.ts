import type { PipelineActivity } from '../../hooks/usePipelineStream';
import type { ConversationUIState } from '../../types/chat';

// PR-F (mimari refactor 2026-05-19): Cinema artık 3 column —
// Scribe / Proto / Trace. Critic ana akıştan "guardrail" konumuna
// çekildi: critic_spec aktiviteleri Scribe column'una, critic_code
// aktiviteleri Proto column'una map'leniyor. Görsel olarak ayrı bir
// kart yok; bulgular ExplanationPanel + CriticFindingsInline ile
// gösteriliyor. PR-A öncesi 5-column görünümü (Scribe · Critic·Spec
// · Proto · Critic·Kod · Trace) tasfiye edildi.
export type CinemaStage = 'scribe' | 'proto' | 'trace';

export const STAGE_ORDER: CinemaStage[] = ['scribe', 'proto', 'trace'];

export interface StageView {
  stage: CinemaStage;
  /**
   * 'failed' added in T9 follow-up (F-1, 2026-05-22): when the Reconciler
   * sweeps a stuck pipeline to `pipeline.stage='failed'`,
   * `mapPipelineToWorkflow` writes `workflow.stages.<X>.status='failed'`
   * + `.error=<label>`. The Rail forwards this as `failedStages` to
   * `reduceStageViews`, which flips the targeted stage's state to
   * `'failed'` and overrides `latest.message` with the label so the card
   * stops showing its stale running text ("Test senaryolarını
   * hazırlıyor..."). Without this override the Trace card kept its last
   * running message even though the upper banner offered "Tekrar Dene".
   */
  state: 'pending' | 'active' | 'complete' | 'failed';
  latest: PipelineActivity | null;
  progress: number;
  reasoning: PipelineActivity['reasoning'] | undefined;
  /** PR-F: Trace iterate-loop retry rozetinden parse edilen meta. */
  meta?: StageMeta;
}

/**
 * F-1 (2026-05-22) — per-stage failure labels sourced from
 * `workflow.stages.{scribe,proto,trace}.error` (populated by T9's
 * `mapPipelineToWorkflow` change). Map a stage to a short user-visible
 * label ("Zaman aşımı" for PIPELINE_TIMEOUT, the error message otherwise).
 * Stages absent from the map render normally.
 */
export type FailedStagesMap = Partial<Record<CinemaStage, string>>;

// PR-F: Trace retry badge için stage view'a opsiyonel meta ekleniyor.
// `retryCount` ve `maxRetries` Trace iterate-loop'tan (`step: 'retry-trigger'`)
// emit edilen activity'lerden çıkarılır.
// PR-F3 (2026-05-19): Critic critical-finding iterate-loop için de aynı meta
// kullanılır; ancak Critic retry'ı Proto column'unda görünür ("Critic
// düzeltiyor (n/max)" badge). `source` ile hangi tip retry olduğunu UI ayırt
// edebilir; absent ise Trace olarak varsayılır (geriye dönük uyum).
export interface StageMeta {
  retryCount?: number;
  maxRetries?: number;
  retrySource?: 'trace' | 'critic';
}

// Map the orchestrator-level UI state to the cinema column that should
// pulse. Returning `undefined` means "no stage is live right now" — used
// for gates (awaiting_approval / awaiting_push_confirm) and idle, so the
// last-touched stage doesn't stay stuck on `active` while the user reads
// the approval card.
function activeStageFor(uiState: ConversationUIState | undefined): CinemaStage | undefined {
  switch (uiState) {
    case 'scribe_clarifying':
    case 'scribe_running':
    case 'scribe_revise':
      return 'scribe';
    // #626: critic phase now carries through from the backend via split
    // ConversationUIState values. Spec critic pulses the Scribe column;
    // code critic pulses Proto. Previously both collapsed into
    // `critic_running` which returned undefined → no column pulsed.
    case 'critic_reviewing_spec':
      return 'scribe';
    case 'critic_reviewing_code':
      return 'proto';
    case 'proto_running':
      return 'proto';
    case 'trace_running':
    case 'ci_running':
      return 'trace';
    default:
      return undefined;
  }
}

export function reduceStageViews(
  activities: PipelineActivity[],
  current: PipelineActivity | null,
  uiState?: ConversationUIState,
  /**
   * F-1: optional per-stage failure override. When a stage appears in this
   * map, its `state` becomes `'failed'` and `latest.message` is replaced
   * with the label so the card stops rendering its last running text.
   * Sourced from `workflow.stages.<X>.status === 'failed'` + `.error` by
   * the rail (which gets the values from T9's mapper).
   */
  failedStages?: FailedStagesMap
): StageView[] {
  // PR-F: Critic guardrail mode — critic_spec aktiviteleri Scribe column'una,
  // critic_code aktiviteleri Proto column'una map'lenir. `protoSeenSoFar`
  // chronological fallback için tutulur (criticPhase belirtilmeyen eski
  // row'lar veya replay senaryoları).
  let protoSeenSoFar = false;
  const stageOf = (a: PipelineActivity): CinemaStage | null => {
    switch (a.stage) {
      case 'scribe':
        return 'scribe';
      case 'critic': {
        if (a.criticPhase === 'spec') return 'scribe';
        if (a.criticPhase === 'code') return 'proto';
        return protoSeenSoFar ? 'proto' : 'scribe';
      }
      case 'proto':
      case 'fix-loop':
        return 'proto';
      case 'trace':
        return 'trace';
      default:
        return null;
    }
  };

  // PR-F1 (2026-05-19 manuel test): Display text (`latest.message`) artık sadece
  // column'un kendi native stage'inden geliyor — Critic activity'leri column'a
  // map'leniyor ama Scribe kartında "Spesifikasyon inceleniyor (adversarial
  // review)..." yazısı çıkmıyor. Critic event'leri progress / complete state
  // hesabına dahil; sadece kullanıcıya gösterilen mesaj native kalır.
  const nativeLastFor = new Map<CinemaStage, PipelineActivity>();
  const lastFor = new Map<CinemaStage, PipelineActivity>();
  const progressFor = new Map<CinemaStage, number>();
  const reasoningFor = new Map<CinemaStage, PipelineActivity['reasoning']>();
  const nativeReasoningStages = new Set<CinemaStage>();
  const metaFor = new Map<CinemaStage, StageMeta>();

  for (const a of activities) {
    const s = stageOf(a);
    if (!s) continue;
    lastFor.set(s, a);
    // Native = column'un kendi stage'inden gelen activity (Scribe column için
    // `scribe`, Proto column için `proto`/`fix-loop`, Trace column için
    // `trace`). Critic activity'leri hiçbir column'un native'i değil — Scribe
    // column'a map'lense bile display'e ('latest.message') girmez.
    // PR-F1 (2026-05-19): manuel testte Scribe kartı Critic'in mesajını
    // gösteriyordu ("Spesifikasyon inceleniyor (adversarial review)..."),
    // yanıltıcıydı. Artık display sadece native'den gelir.
    if (a.stage !== 'critic') {
      nativeLastFor.set(s, a);
    }
    if (a.progress !== undefined) progressFor.set(s, a.progress);
    // PR-T3 S5: cinema'daki güven rozeti **kolonun kendi ajanının** öz-güveni
    // olmalı. Critic events stage olarak Scribe/Proto'ya katlanıyor ama Critic
    // review-skoru ile Scribe öz-güveni iki ayrı metrik — önceden Critic
    // sonradan gelirse Scribe öz-güvenini yerine geçiyordu (manuel testte
    // Açıklama %92 ↔ Akış %82 tutarsızlığı). Kural: native (non-critic)
    // reasoning her zaman kazanır; Critic reasoning native yoksa serbestçe
    // güncellenir (iterate-loop'ta son iterasyonun skoru görünür).
    if (a.reasoning) {
      if (a.stage !== 'critic') {
        reasoningFor.set(s, a.reasoning);
        nativeReasoningStages.add(s);
      } else if (!nativeReasoningStages.has(s)) {
        reasoningFor.set(s, a.reasoning);
      }
    }
    // PR-F: Trace retry badge — `retry-trigger` step'inde retryCount alanı
    // doludur ve message metni `... (n/m)` formatında. Aktif retry sayısını
    // ve maxRetries'i parse edip stage meta'sına yazıyoruz; PipelineCinema
    // bunu Trace column'unda küçük bir rozet olarak gösterir.
    if (a.stage === 'trace' && a.step === 'retry-trigger') {
      const existing = metaFor.get('trace') ?? {};
      const max = parseRetryMaxFromMessage(a.message);
      metaFor.set('trace', {
        ...existing,
        retryCount: a.retryCount ?? existing.retryCount,
        maxRetries: max ?? existing.maxRetries,
        retrySource: 'trace',
      });
    }
    // PR-V (2026-05-20) Bug 2 — Trace stage_completed clears stale retry
    // meta. When Trace dry-run fails 3x in the preview-confirm flow, the
    // orchestrator emits a `stage_completed` (status='completed') activity
    // with a neutral message before opening the push gate. Without this
    // reset, the cinema would keep showing "Test deniyor (3)" forever
    // because the last retry-trigger set retryCount=3 and no later activity
    // touched the meta. Reset on completion so the column shows a clean
    // final state.
    if (a.stage === 'trace' && a.step === 'stage_completed') {
      metaFor.delete('trace');
    }
    // PR-F3 (2026-05-19): Critic critical-finding iterate-loop retry — Critic
    // `criticPhase=code` + `step=retry-trigger` activity'si Proto column'unda
    // "Critic düzeltiyor (n/max)" badge olarak gösterilir. Trace badge'i ile
    // aynı meta shape; Proto column'unda aynı anda iki retry birden olmaz
    // (Critic iterate aktifken Trace henüz çalışmıyor; Trace iterate Trace
    // column'unda görünür).
    if (a.stage === 'critic' && a.criticPhase === 'code' && a.step === 'retry-trigger') {
      const existing = metaFor.get('proto') ?? {};
      const max = parseRetryMaxFromMessage(a.message);
      metaFor.set('proto', {
        ...existing,
        retryCount: a.retryCount ?? existing.retryCount,
        maxRetries: max ?? existing.maxRetries,
        retrySource: 'critic',
      });
    }
    if (a.stage === 'proto' || a.stage === 'fix-loop') protoSeenSoFar = true;
  }

  // PR-V5: derive completion from EXPLICIT `status === 'completed'`
  // activities emitted by the orchestrator BEFORE each stage transition.
  // Pre-PR-V5 the rule was "stage idx < activeIdx ⇒ complete", which
  // produced premature checkmarks: the orchestrator transitions to the
  // next stage and the next stage's first activity arrives before the
  // outgoing stage's actual exit. The explicit signal removes that
  // ambiguity.
  const completed = new Set<CinemaStage>();
  for (const a of activities) {
    if (a.status !== 'completed') continue;
    const s = stageOf(a);
    if (s) completed.add(s);
  }

  // Prefer the orchestrator-level uiState over the latest activity's
  // stage: the SSE buffer keeps emitting a stale critic activity well
  // after the pipeline has moved into `awaiting_approval`, which used to
  // leave the Critic column pulsing "denetliyor…" forever (Bulgu D).
  let activeStage: CinemaStage | undefined;
  if (uiState !== undefined) {
    activeStage = activeStageFor(uiState);
  } else if (current) {
    let protoSeenForCurrent = false;
    for (const a of activities) {
      if (a === current) break;
      if (a.stage === 'proto' || a.stage === 'fix-loop') {
        protoSeenForCurrent = true;
        break;
      }
    }
    const stageOfCurrent = (() => {
      switch (current.stage) {
        case 'scribe':
          return 'scribe' as CinemaStage;
        case 'critic':
          if (current.criticPhase === 'spec') return 'scribe' as CinemaStage;
          if (current.criticPhase === 'code') return 'proto' as CinemaStage;
          return (protoSeenForCurrent ? 'proto' : 'scribe') as CinemaStage;
        case 'proto':
        case 'fix-loop':
          return 'proto' as CinemaStage;
        case 'trace':
          return 'trace' as CinemaStage;
        default:
          return undefined;
      }
    })();
    activeStage = stageOfCurrent;
  }

  return STAGE_ORDER.map((stage) => {
    // PR-F1: `latest` (display) = native stage activity'sinin sonu. Combined
    // `lastFor` hâlâ state hesaplaması için fallback olarak kullanılır — eğer
    // hiç native activity yoksa column "complete" yerine "pending" görünmemeli.
    const native = nativeLastFor.get(stage);
    const combined = lastFor.get(stage);
    let latest = native ?? null;
    const progress = progressFor.get(stage) ?? 0;
    const reasoning = reasoningFor.get(stage);
    const meta = metaFor.get(stage);
    // PR-V5 completion rule:
    //   1. Explicit completed activity (status === 'completed') → complete.
    //   2. uiState says this column's stage is live → active.
    //   3. Idle uiState + any activity for this column → complete
    //      (replay back-compat: pre-PR-V5 pipelines have no explicit
    //      completion signal but reaching a terminal/gate state implies
    //      the stage finished).
    //   4. Otherwise → pending.
    //
    // The pre-PR-V5 rule "stage idx < activeIdx ⇒ complete" was removed —
    // it caused premature checkmarks because the next stage's first
    // activity could land BEFORE the outgoing stage's actual exit.
    let state: StageView['state'];
    if (completed.has(stage)) {
      state = 'complete';
    } else if (activeStage === stage) {
      state = 'active';
    } else if (activeStage === undefined && combined) {
      // Idle uiState + at least one activity → legacy completion fallback.
      // New emissions will populate the `completed` Set above; this branch
      // covers pre-PR-V5 history and DB replays of older pipelines.
      state = 'complete';
    } else {
      state = 'pending';
    }
    // F-1 (2026-05-22): failed-state override beats every other rule.
    // When the rail tells us a stage is failed (sourced from T9's
    // `mapPipelineToWorkflow` writing `workflow.stages.<X>.status='failed'`),
    // we replace the card's state + display message so the user no longer
    // sees the stale running text ("Test senaryolarını hazırlıyor...")
    // alongside the failure banner.
    const failureLabel = failedStages?.[stage];
    if (failureLabel) {
      state = 'failed';
      // Synthesize a minimal activity that carries the label as `message`
      // so the existing StageColumn `latest.message` render path picks it
      // up without any column-specific branch.
      const stamp = latest?.timestamp ?? new Date(0).toISOString();
      latest = {
        pipelineId: latest?.pipelineId ?? 'failed',
        stage: stage,
        step: 'failed',
        message: failureLabel,
        timestamp: stamp,
      };
    }
    return { stage, state, latest, progress, reasoning, meta };
  });
}

/**
 * PR-F / PR-F3 — iterate-loop retry mesajından maxRetries değerini çıkarır.
 * Backend emit'i `... (2/3)` formatında message yazar; regex onu yakalar.
 * Yakalanamazsa undefined döner (eski activity'lerle backward-compat).
 * Hem Trace hem Critic iterate-loop için aynı format kullanılır.
 */
function parseRetryMaxFromMessage(message: string): number | undefined {
  const match = /\((\d+)\/(\d+)\)/.exec(message);
  if (!match) return undefined;
  const max = parseInt(match[2] ?? '', 10);
  return Number.isFinite(max) ? max : undefined;
}
