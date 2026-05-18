import { useI18n } from '../../i18n/useI18n';

export interface CriticScoreBarProps {
  /** Overall Critic score (0-100). */
  score: number;
  /** Approval threshold (0-100); defaults to backend default of 75. */
  threshold?: number;
  /** Number of findings raised in this review. */
  findingsCount: number;
  /** When set, the bar is visually compact (used inside dense rails). */
  compact?: boolean;
  className?: string;
}

const DEFAULT_THRESHOLD = 75;

/**
 * CriticScoreBar — visualises the Critic overallScore against the approval
 * threshold. Renders a 0-100 horizontal bar with the threshold marked as a
 * dashed vertical line, the score as a filled segment, and a status pill
 * underneath summarising approved / blocked.
 *
 * P8 — paired with `CriticResolutionGate`; can also be reused inside
 * `ExplanationPanel` for completed pipelines where the user wants to
 * compare a passing score against the threshold.
 */
export function CriticScoreBar({
  score,
  threshold = DEFAULT_THRESHOLD,
  findingsCount,
  compact = false,
  className,
}: CriticScoreBarProps) {
  const { t } = useI18n();
  const clampedScore = Math.max(0, Math.min(100, Math.round(score)));
  const clampedThreshold = Math.max(0, Math.min(100, Math.round(threshold)));
  const approved = clampedScore >= clampedThreshold;

  // Tailwind dynamic widths get purged in production builds, so use inline
  // styles for the variable bar widths.
  const fillStyle = { width: `${clampedScore}%` } as const;
  const thresholdStyle = { left: `${clampedThreshold}%` } as const;

  const barHeight = compact ? 'h-1.5' : 'h-2.5';
  const wrapperPad = compact ? 'py-1' : 'py-1.5';

  return (
    <div
      data-testid="critic-score-bar"
      data-approved={approved}
      data-score={clampedScore}
      data-threshold={clampedThreshold}
      aria-label={t('chat.critic.scoreBar.title')}
      className={`flex flex-col gap-1 ${wrapperPad} ${className ?? ''}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-ak-text-secondary">
          {t('chat.critic.scoreBar.title')}
        </span>
        <span className="text-xs font-medium text-ak-text-primary">
          {`${clampedScore}/100 · ${findingsCount} ${t('chat.critic.scoreBar.findingsSuffix')}`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={clampedScore}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t('chat.critic.scoreBar.title')}
        className={`relative w-full ${barHeight} overflow-hidden rounded-full bg-ak-surface-2`}
      >
        <div
          data-testid="critic-score-bar-fill"
          style={fillStyle}
          className={`${barHeight} rounded-full transition-all ${
            approved ? 'bg-emerald-500' : 'bg-rose-500'
          }`}
        />
        <span
          data-testid="critic-score-bar-threshold"
          aria-hidden="true"
          style={thresholdStyle}
          title={t('chat.critic.scoreBar.threshold').replace('{value}', String(clampedThreshold))}
          className={`absolute top-0 h-full w-px border-l border-dashed border-ak-text-primary/60`}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          data-testid="critic-score-bar-status"
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
            approved
              ? 'bg-emerald-500/15 text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-200'
              : 'bg-rose-500/15 text-rose-700 ring-1 ring-rose-500/30 dark:text-rose-200'
          }`}
        >
          {approved
            ? t('chat.critic.scoreBar.approved')
            : t('chat.critic.scoreBar.blocked')}
        </span>
        <span className="text-[11px] text-ak-text-secondary">
          {t('chat.critic.scoreBar.threshold').replace('{value}', String(clampedThreshold))}
        </span>
      </div>
    </div>
  );
}

export default CriticScoreBar;
