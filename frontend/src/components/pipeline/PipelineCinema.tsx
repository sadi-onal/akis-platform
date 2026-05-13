import { useMemo } from 'react';
import type { PipelineActivity } from '../../hooks/usePipelineStream';
import type { ConversationUIState } from '../../types/chat';
import { ConfidenceBadge } from './ConfidenceBadge';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { reduceStageViews, type CinemaStage, type StageView } from './PipelineCinema.utils';

export interface PipelineCinemaProps {
  activities: PipelineActivity[];
  currentStep: PipelineActivity | null;
  /**
   * Orchestrator-level state — drives which column is "live". Without it
   * we fall back to the latest activity's stage, which leaves a column
   * pulsing forever at approval/push gates because the SSE buffer never
   * emits a "stage finished" marker.
   */
  uiState?: ConversationUIState;
  /** Compact mode hides the full-screen takeover; the row stays visible. */
  compact?: boolean;
  /** Callback when user toggles compact mode */
  onToggleCompact?: () => void;
  /** Slot rendered below the four-column row — typically the approval gate. */
  approvalSlot?: React.ReactNode;
  className?: string;
}

const STAGE_LABEL: Record<CinemaStage, string> = {
  scribe: 'Scribe',
  critic: 'Critic',
  proto: 'Proto',
  trace: 'Trace',
};

const STAGE_TAGLINE: Record<CinemaStage, string> = {
  scribe: 'Fikir → Spec',
  critic: 'Adversarial review',
  proto: 'Spec → Kod',
  trace: 'Kod → Test',
};

// Per-agent identity colours. Scribe/Proto/Trace match the rest of the app
// (see tailwind config: ak-scribe/proto/trace tokens). Critic is rose —
// the visual cue for "review/scrutiny" without being alarming-red.
const STAGE_ACCENT: Record<CinemaStage, { dot: string; ring: string; tint: string; text: string }> =
  {
    scribe: {
      dot: 'bg-ak-scribe',
      ring: 'border-ak-scribe/60 shadow-[0_0_0_1px_rgb(56_189_248/0.25)]',
      tint: 'bg-ak-scribe/5',
      text: 'text-ak-scribe',
    },
    critic: {
      dot: 'bg-rose-400',
      ring: 'border-rose-400/60 shadow-[0_0_0_1px_rgb(251_113_133/0.25)]',
      tint: 'bg-rose-400/5',
      text: 'text-rose-500 dark:text-rose-300',
    },
    proto: {
      dot: 'bg-ak-proto',
      ring: 'border-ak-proto/60 shadow-[0_0_0_1px_rgb(245_158_11/0.25)]',
      tint: 'bg-ak-proto/5',
      text: 'text-ak-proto',
    },
    trace: {
      dot: 'bg-ak-trace',
      ring: 'border-ak-trace/60 shadow-[0_0_0_1px_rgb(167_139_250/0.25)]',
      tint: 'bg-ak-trace/5',
      text: 'text-ak-trace',
    },
  };

function StageColumn({ view, reducedMotion }: { view: StageView; reducedMotion: boolean }) {
  const { stage, state, latest, progress, reasoning } = view;
  const accent = STAGE_ACCENT[stage];
  const messageText = latest?.message ?? '';
  const baseClass =
    'flex min-h-[160px] flex-col gap-2 rounded-xl border bg-ak-surface p-3 transition-all';
  const stateClass =
    state === 'active'
      ? `${accent.ring} ${accent.tint}`
      : state === 'complete'
        ? 'border-ak-border-default'
        : 'border-ak-border-subtle opacity-60';
  return (
    <div data-stage={stage} data-state={state} className={`${baseClass} ${stateClass}`}>
      <header className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`inline-block h-2 w-2 rounded-full ${accent.dot} ${
              state === 'active' && !reducedMotion ? 'animate-pulse' : ''
            } ${state === 'pending' ? 'opacity-40' : ''}`}
          />
          <span className={`text-sm font-semibold ${accent.text}`}>{STAGE_LABEL[stage]}</span>
        </span>
        {reasoning?.confidence !== undefined && (
          <ConfidenceBadge score={reasoning.confidence} compact />
        )}
      </header>
      <p className="text-xs text-ak-text-tertiary">{STAGE_TAGLINE[stage]}</p>
      {state !== 'pending' && (
        <div
          className="mt-1 h-1 w-full overflow-hidden rounded-full"
          style={{ background: 'var(--ak-border-subtle)' }}
        >
          <div
            className={accent.dot}
            style={{
              height: '100%',
              width: `${progress}%`,
              transition: reducedMotion ? 'none' : 'width 400ms ease-out',
            }}
          />
        </div>
      )}
      {messageText && (
        <p
          className={`text-xs leading-snug ${
            state === 'pending' ? 'text-ak-text-tertiary' : 'text-ak-text-primary'
          }`}
          aria-live="polite"
        >
          {messageText}
        </p>
      )}
      {reasoning?.decision && (
        <div className="mt-auto rounded-md border border-ak-border-subtle bg-ak-surface-2 p-2 text-xs">
          <p className="font-semibold text-ak-text-primary">{reasoning.decision}</p>
          {reasoning.snippet && (
            <p className="mt-0.5 line-clamp-3 text-ak-text-tertiary">{reasoning.snippet}</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * PipelineCinema — theatrical, four-column live view of an active pipeline.
 * Designed for thesis demos and onboarding. Operates purely on the SSE
 * activity stream; no extra round-trips. Falls back to a compact row when
 * `compact` is set so power users can collapse it.
 */
export function PipelineCinema({
  activities,
  currentStep,
  uiState,
  compact = false,
  onToggleCompact,
  approvalSlot,
  className,
}: PipelineCinemaProps) {
  const reducedMotion = useReducedMotion();
  const views = useMemo(
    () => reduceStageViews(activities, currentStep, uiState),
    [activities, currentStep, uiState]
  );

  return (
    <section
      aria-label="Pipeline canlı görüntüsü"
      data-cinema-mode={compact ? 'compact' : 'full'}
      className={`flex flex-col gap-3 ${className ?? ''}`}
    >
      {/* When the consumer renders its own header (e.g. PipelineDetailRail
          puts "Pipeline detayı" with the Akış/Açıklama tabs above us) we
          omit our own subtitle to avoid two tracking-wide caps headers
          stacked on top of each other. The header only renders when
          there's a compact toggle to attach to. */}
      {onToggleCompact && (
        <header className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ak-text-tertiary">
            Pipeline akışı
          </h2>
          <button
            type="button"
            onClick={onToggleCompact}
            className="rounded-md border border-ak-border bg-ak-surface px-2 py-1 text-xs text-ak-text-secondary hover:bg-ak-surface-2 hover:text-ak-text-primary"
            aria-pressed={compact}
          >
            {compact ? 'Geniş görünüm' : 'Kompakt görünüm'}
          </button>
        </header>
      )}
      <div
        className={`grid gap-2 ${
          compact ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4'
        }`}
      >
        {views.map((v) => (
          <StageColumn key={v.stage} view={v} reducedMotion={reducedMotion} />
        ))}
      </div>
      {approvalSlot && (
        <div className="rounded-xl border border-amber-400/40 bg-amber-500/5 p-3">
          {approvalSlot}
        </div>
      )}
    </section>
  );
}

export default PipelineCinema;
