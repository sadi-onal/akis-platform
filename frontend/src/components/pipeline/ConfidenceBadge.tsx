import { useState, useId, useRef, useEffect } from 'react';
import { useI18n } from '../../i18n/useI18n';
import type { MessageKey } from '../../i18n/i18n.types';

export interface ConfidenceBadgeProps {
  /** 0-100 confidence score */
  score: number;
  /** Optional list of factors shown in tooltip */
  factors?: string[];
  /** Compact form — just the number, no label */
  compact?: boolean;
  /**
   * PR-E bulgu #2: suppress the hover/click tooltip entirely so the badge can
   * sit inside a parent that already supplies its own tooltip (e.g. the
   * cinema column's stage-tooltip). The badge renders as a plain pill — same
   * tier colour + score, no popover, no cursor-help affordance.
   */
  suppressTooltip?: boolean;
  /** Additional class names */
  className?: string;
}

type Tier = 'high' | 'medium' | 'low';

function tierFor(score: number): Tier {
  if (score >= 85) return 'high';
  if (score >= 70) return 'medium';
  return 'low';
}

const TIER_LABEL_KEY: Record<Tier, MessageKey> = {
  high: 'confidence.tier.high',
  medium: 'confidence.tier.medium',
  low: 'confidence.tier.low',
};

const TIER_EXPLANATION_KEY: Record<Tier, MessageKey> = {
  high: 'confidence.explanation.high',
  medium: 'confidence.explanation.medium',
  low: 'confidence.explanation.low',
};

// Tier styling uses AKIS-aligned semantic colors with explicit light/dark
// variants so contrast holds in both themes. Emerald = good, amber = caution,
// rose = warning — same vocabulary the rest of the app uses.
const TIER_CLASS: Record<Tier, string> = {
  high: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-200 dark:border-emerald-500/30',
  medium:
    'bg-amber-500/10 text-amber-700 border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/30',
  low: 'bg-rose-500/10 text-rose-700 border-rose-500/40 dark:bg-rose-500/15 dark:text-rose-200 dark:border-rose-500/30',
};

/**
 * ConfidenceBadge — color-coded confidence indicator.
 * Hover/focus reveals a per-tier explanation plus optional factor list.
 */
export function ConfidenceBadge({
  score,
  factors,
  compact,
  suppressTooltip,
  className,
}: ConfidenceBadgeProps) {
  const { t } = useI18n();
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const tier = tierFor(clamped);
  const id = useId();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const hasFactors = !!factors && factors.length > 0;
  const tierLabel = t(TIER_LABEL_KEY[tier]);
  const explanation = t(TIER_EXPLANATION_KEY[tier]);

  // PR-E bulgu #2: when the parent already owns a tooltip (cinema column
  // stage-tooltip), render a non-interactive pill so we don't stack a
  // second popover on top of the parent's. Same colours + score, no
  // hover/click handlers, no cursor-help, no popover.
  if (suppressTooltip) {
    return (
      <span
        aria-label={`${tierLabel}: ${clamped}%`}
        data-tier={tier}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold leading-none ${TIER_CLASS[tier]} ${className ?? ''}`}
      >
        <span aria-hidden="true">●</span>
        <span>{compact ? `${clamped}%` : `${tierLabel} · ${clamped}%`}</span>
      </span>
    );
  }

  return (
    <span ref={ref} className={`relative inline-flex ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-describedby={open ? id : undefined}
        aria-label={`${tierLabel}: ${clamped}%`}
        data-tier={tier}
        className={`inline-flex cursor-help items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold leading-none transition ${TIER_CLASS[tier]}`}
      >
        <span aria-hidden="true">●</span>
        <span>{compact ? `${clamped}%` : `${tierLabel} · ${clamped}%`}</span>
      </button>
      {open && (
        // Anchor the popover to the badge's RIGHT edge (extending leftward)
        // so it cannot overflow the right edge of a cinema column. `max-w-xs`
        // + viewport-bounded `min()` keep it readable on narrow screens.
        <span
          id={id}
          role="tooltip"
          style={{ maxWidth: 'min(16rem, 90vw)' }}
          className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-ak-border bg-ak-surface p-2 text-xs text-ak-text-primary shadow-lg"
        >
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-ak-text-tertiary">
            {t('confidence.tooltip.scoreCaption')}
          </span>
          <span className="mb-2 block leading-relaxed text-ak-text-secondary">{explanation}</span>
          {hasFactors && (
            <>
              <span className="mb-1 block font-semibold">
                {t('confidence.tooltip.factorsHeader')}
              </span>
              <ul className="list-disc space-y-0.5 pl-4 text-ak-text-secondary">
                {factors!.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </>
          )}
        </span>
      )}
    </span>
  );
}

export default ConfidenceBadge;
