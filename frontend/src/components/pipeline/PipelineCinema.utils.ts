import type { PipelineActivity } from '../../hooks/usePipelineStream';
import type { ConversationUIState } from '../../types/chat';

export type CinemaStage = 'scribe' | 'critic' | 'proto' | 'trace';

export const STAGE_ORDER: CinemaStage[] = ['scribe', 'critic', 'proto', 'trace'];

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
function activeStageFor(uiState: ConversationUIState | undefined): CinemaStage | undefined {
  switch (uiState) {
    case 'scribe_clarifying':
    case 'scribe_running':
    case 'scribe_revise':
      return 'scribe';
    case 'critic_running':
      return 'critic';
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
  // Map fix-loop activity onto Proto column visually so iterations stay
  // intelligible without a 5th column.
  const stageOf = (a: PipelineActivity): CinemaStage | null => {
    switch (a.stage) {
      case 'scribe':
        return 'scribe';
      case 'critic':
        return 'critic';
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
  }

  // Prefer the orchestrator-level uiState over the latest activity's
  // stage: the SSE buffer keeps emitting a stale critic activity well
  // after the pipeline has moved into `awaiting_approval`, which used to
  // leave the Critic column pulsing "denetliyor…" forever (Bulgu D).
  let activeStage: CinemaStage | undefined;
  if (uiState !== undefined) {
    activeStage = activeStageFor(uiState);
  } else if (current) {
    activeStage = stageOf(current) ?? undefined;
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
