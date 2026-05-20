import type { IterationTrajectory as Trajectory } from '../../types/pipeline';
import { useI18n } from '../../i18n/useI18n';

interface IterationTrajectoryProps {
  trajectory?: Trajectory;
  /**
   * `compact` renders just the score arrow ("52 → 67 → 84"); the
   * Cinema kart uses this. `full` renders the per-iter row list; the
   * Açıklama panel uses this.
   */
  variant?: 'compact' | 'full';
}

function formatPct(value: number | null | undefined, fractional: boolean): string {
  if (value === null || value === undefined) return '—';
  if (fractional) return `${Math.round(value * 100)}`;
  return `${Math.round(value)}`;
}

/** Tiny placeholder interpolator — `t()` only returns the template string,
 *  so we substitute {x} markers ourselves. Mirrors the same shape as
 *  i18n consumers elsewhere in the project that do their own swap. */
function interpolate(template: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
    template
  );
}

/**
 * T4 — visualises the Critic-Proto iterate loop trajectory.
 *
 * Cinema card variant: a single horizontal line showing each iteration's
 * Critic score with an arrow between them. Rendered under the Critic stage
 * badge so the demo argument "%52 → %67 → %84 — agent kendi kendine
 * iyileşiyor" is visible at a glance.
 *
 * Açıklama panel variant: one row per iteration with full details
 * (Proto confidence, Critic score, findings count, decision).
 *
 * Renders nothing when the trajectory is absent OR has zero entries.
 */
export function IterationTrajectory({ trajectory, variant = 'full' }: IterationTrajectoryProps) {
  const { t } = useI18n();

  if (!trajectory || trajectory.entries.length === 0) {
    return null;
  }

  if (variant === 'compact') {
    // One-line summary for Cinema. Show critic scores joined by →.
    const scores = trajectory.entries.map((e) => formatPct(e.criticScore, false));
    return (
      <span
        data-testid="iteration-trajectory-compact"
        className="inline-flex items-center gap-1 text-[10px] font-medium text-ak-text-secondary"
        aria-label={t('pipeline.iteration.trajectory.title')}
        title={t('pipeline.iteration.trajectory.title')}
      >
        {scores.map((s, idx) => (
          <span key={idx} className="inline-flex items-center gap-1">
            {idx > 0 && <span aria-hidden="true">→</span>}
            <span>%{s}</span>
          </span>
        ))}
      </span>
    );
  }

  return (
    <div data-testid="iteration-trajectory-full" className="mt-3 space-y-1.5">
      <div className="text-xs font-medium uppercase tracking-wider text-ak-text-tertiary">
        {t('pipeline.iteration.trajectory.title')}
      </div>
      <ol className="space-y-1" role="list">
        {trajectory.entries.map((entry) => {
          const protoStr = formatPct(entry.protoConfidence, true);
          const criticStr = formatPct(entry.criticScore, false);
          const decisionKey =
            entry.decision === 'approved'
              ? 'pipeline.iteration.trajectory.approved'
              : entry.decision === 'blocked'
                ? 'pipeline.iteration.trajectory.blocked'
                : 'pipeline.iteration.trajectory.rejected';
          const decisionColor =
            entry.decision === 'approved'
              ? 'text-emerald-600 dark:text-emerald-400'
              : entry.decision === 'blocked'
                ? 'text-rose-600 dark:text-rose-400'
                : 'text-amber-600 dark:text-amber-400';
          const rowText =
            entry.protoConfidence !== null
              ? interpolate(t('pipeline.iteration.trajectory.iterRow'), {
                  n: entry.iteration,
                  p: protoStr,
                  c: criticStr,
                })
              : interpolate(t('pipeline.iteration.trajectory.iterRowNoProto'), {
                  n: entry.iteration,
                  c: criticStr,
                });
          const findingsText = interpolate(t('pipeline.iteration.trajectory.findings'), {
            n: entry.criticFindingsCount,
            k: entry.criticCriticalCount,
          });
          return (
            <li
              key={entry.iteration}
              data-testid={`iteration-trajectory-row-${entry.iteration}`}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
            >
              <span className="font-mono text-ak-text-primary">{rowText}</span>
              <span className="text-ak-text-tertiary">·</span>
              <span className="text-ak-text-secondary">{findingsText}</span>
              {entry.decision && (
                <>
                  <span className="text-ak-text-tertiary">—</span>
                  <span className={`font-semibold ${decisionColor}`}>{t(decisionKey)}</span>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export default IterationTrajectory;
