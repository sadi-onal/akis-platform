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
  state: 'pending' | 'active' | 'complete';
  latest: PipelineActivity | null;
  progress: number;
  reasoning: PipelineActivity['reasoning'] | undefined;
  /** PR-F: Trace iterate-loop retry rozetinden parse edilen meta. */
  meta?: StageMeta;
}

// PR-F: Trace retry badge için stage view'a opsiyonel meta ekleniyor.
// `retryCount` ve `maxRetries` Trace iterate-loop'tan (`step: 'retry-trigger'`)
// emit edilen activity'lerden çıkarılır.
export interface StageMeta {
  retryCount?: number;
  maxRetries?: number;
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
    case 'critic_running':
      // PR-F: Critic ana column değil; UI state critic_running ise hangi
      // faza ait olduğunu chronological context belirler. Spec critic'i
      // hâlâ Scribe column'unda nabız atar; code critic'i Proto'da.
      // (Routing reduceStageViews içinde protoSeenSoFar üzerinden yapılır.)
      return undefined;
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
  uiState?: ConversationUIState
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
    if (a.reasoning) reasoningFor.set(s, a.reasoning);
    // PR-F: Trace retry badge — `retry-trigger` step'inde retryCount alanı
    // doludur ve message metni `... (n/m)` formatında. Aktif retry sayısını
    // ve maxRetries'i parse edip stage meta'sına yazıyoruz; PipelineCinema
    // bunu Trace column'unda küçük bir rozet olarak gösterir.
    if (a.stage === 'trace' && a.step === 'retry-trigger') {
      const existing = metaFor.get('trace') ?? {};
      const max = parseTraceMaxRetries(a.message);
      metaFor.set('trace', {
        ...existing,
        retryCount: a.retryCount ?? existing.retryCount,
        maxRetries: max ?? existing.maxRetries,
      });
    }
    if (a.stage === 'proto' || a.stage === 'fix-loop') protoSeenSoFar = true;
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
  const activeIdx = activeStage ? STAGE_ORDER.indexOf(activeStage) : -1;

  return STAGE_ORDER.map((stage, idx) => {
    // PR-F1: `latest` (display) = native stage activity'sinin sonu. Combined
    // `lastFor` hâlâ state hesaplaması için fallback olarak kullanılır — eğer
    // hiç native activity yoksa column "complete" yerine "pending" görünmemeli.
    const native = nativeLastFor.get(stage);
    const combined = lastFor.get(stage);
    const latest = native ?? null;
    const progress = progressFor.get(stage) ?? 0;
    const reasoning = reasoningFor.get(stage);
    const meta = metaFor.get(stage);
    let state: StageView['state'] = 'pending';
    if (activeIdx === -1) {
      // Column complete olarak görünmesi için en az bir activity yeterli
      // (native veya mapped — Critic-only senaryolar mantıken çalışmıyor
      // ama defensive: pending kalmasın).
      state = combined ? 'complete' : 'pending';
    } else if (idx < activeIdx) {
      state = 'complete';
    } else if (idx === activeIdx) {
      state = progress >= 100 ? 'complete' : 'active';
    } else {
      state = 'pending';
    }
    return { stage, state, latest, progress, reasoning, meta };
  });
}

/**
 * PR-F — Trace iterate-loop retry mesajından maxRetries değerini çıkarır.
 * Backend emit'i `... (2/3)` formatında message yazar; rejex onu yakalar.
 * Yakalanamazsa undefined döner (eski activity'lerle backward-compat).
 */
function parseTraceMaxRetries(message: string): number | undefined {
  const match = /\((\d+)\/(\d+)\)/.exec(message);
  if (!match) return undefined;
  const max = parseInt(match[2] ?? '', 10);
  return Number.isFinite(max) ? max : undefined;
}
