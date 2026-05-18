import type { PipelineActivity } from '../../hooks/usePipelineStream';
import type { ConversationUIState } from '../../types/chat';

// PR-A Fix 4: Critic runs twice per pipeline — once on the spec (before
// Proto) and once on the code (after Proto). The cinema row mirrors the
// real pipeline by giving each phase its own column. Older code still
// emits `stage: 'critic'`; the activity's `criticPhase` field (set by the
// orchestrator) decides which column we route the event into. For replay
// from DB rows where `criticPhase` is missing we fall back to: "if any
// proto activity has already been observed in the buffer, route to
// critic_code; else critic_spec".
export type CinemaStage = 'scribe' | 'critic_spec' | 'proto' | 'critic_code' | 'trace';

export const STAGE_ORDER: CinemaStage[] = [
  'scribe',
  'critic_spec',
  'proto',
  'critic_code',
  'trace',
];

export interface StageView {
  stage: CinemaStage;
  state: 'pending' | 'active' | 'complete';
  latest: PipelineActivity | null;
  progress: number;
  reasoning: PipelineActivity['reasoning'] | undefined;
}

// Map the orchestrator-level UI state to the cinema column that should
// pulse. Returning `undefined` means "no stage is live right now" — used
// for gates (awaiting_approval / awaiting_push_confirm) and idle, so the
// last-touched stage doesn't stay stuck on `active` while the user reads
// the approval card.
function activeStageFor(
  uiState: ConversationUIState | undefined,
  protoSeen: boolean
): CinemaStage | undefined {
  switch (uiState) {
    case 'scribe_clarifying':
    case 'scribe_running':
    case 'scribe_revise':
      return 'scribe';
    case 'critic_running':
      // PR-A Fix 4: pick the right critic column. If Proto has already
      // emitted activity, we must be in the second (code) review; else
      // the first (spec) review.
      return protoSeen ? 'critic_code' : 'critic_spec';
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
  // PR-A Fix 4: track whether Proto has been seen yet so a critic event
  // with no `criticPhase` hint can be routed to the right column.
  let protoSeenSoFar = false;
  const stageOf = (a: PipelineActivity): CinemaStage | null => {
    switch (a.stage) {
      case 'scribe':
        return 'scribe';
      case 'critic': {
        if (a.criticPhase === 'spec') return 'critic_spec';
        if (a.criticPhase === 'code') return 'critic_code';
        // Fallback: position by chronology. Cinema activities are
        // chronological, so anything before the first proto event is a
        // spec review; anything after is a code review.
        return protoSeenSoFar ? 'critic_code' : 'critic_spec';
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

  const lastFor = new Map<CinemaStage, PipelineActivity>();
  const progressFor = new Map<CinemaStage, number>();
  const reasoningFor = new Map<CinemaStage, PipelineActivity['reasoning']>();

  for (const a of activities) {
    const s = stageOf(a);
    if (!s) continue;
    lastFor.set(s, a);
    if (a.progress !== undefined) progressFor.set(s, a.progress);
    if (a.reasoning) reasoningFor.set(s, a.reasoning);
    // Update protoSeenSoFar AFTER routing so a proto event itself doesn't
    // retroactively reroute earlier critic events.
    if (a.stage === 'proto' || a.stage === 'fix-loop') protoSeenSoFar = true;
  }

  // Prefer the orchestrator-level uiState over the latest activity's
  // stage: the SSE buffer keeps emitting a stale critic activity well
  // after the pipeline has moved into `awaiting_approval`, which used to
  // leave the Critic column pulsing "denetliyor…" forever (Bulgu D).
  let activeStage: CinemaStage | undefined;
  if (uiState !== undefined) {
    activeStage = activeStageFor(uiState, protoSeenSoFar);
  } else if (current) {
    // Reset protoSeenSoFar tracking for the `current` lookup so the
    // single-activity case works correctly without re-iterating.
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
          if (current.criticPhase === 'spec') return 'critic_spec' as CinemaStage;
          if (current.criticPhase === 'code') return 'critic_code' as CinemaStage;
          return (protoSeenForCurrent ? 'critic_code' : 'critic_spec') as CinemaStage;
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
    const latest = lastFor.get(stage) ?? null;
    const progress = progressFor.get(stage) ?? 0;
    const reasoning = reasoningFor.get(stage);
    let state: StageView['state'] = 'pending';
    if (activeIdx === -1) {
      state = latest ? 'complete' : 'pending';
    } else if (idx < activeIdx) {
      state = 'complete';
    } else if (idx === activeIdx) {
      state = progress >= 100 ? 'complete' : 'active';
    } else {
      state = 'pending';
    }
    return { stage, state, latest, progress, reasoning };
  });
}
