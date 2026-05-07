import type { PipelineActivity } from '../../hooks/usePipelineStream';

export type CinemaStage = 'scribe' | 'critic' | 'proto' | 'trace';

export const STAGE_ORDER: CinemaStage[] = ['scribe', 'critic', 'proto', 'trace'];

export interface StageView {
  stage: CinemaStage;
  state: 'pending' | 'active' | 'complete';
  latest: PipelineActivity | null;
  progress: number;
  reasoning: PipelineActivity['reasoning'] | undefined;
}

export function reduceStageViews(
  activities: PipelineActivity[],
  current: PipelineActivity | null
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

  const currentStage = current ? stageOf(current) : null;
  const activeIdx = currentStage ? STAGE_ORDER.indexOf(currentStage) : -1;

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
