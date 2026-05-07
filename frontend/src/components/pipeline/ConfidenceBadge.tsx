import { useState, useId, useRef, useEffect } from 'react';

export interface ConfidenceBadgeProps {
  /** 0-100 confidence score */
  score: number;
  /** Optional list of factors shown in tooltip */
  factors?: string[];
  /** Compact form — just the number, no label */
  compact?: boolean;
  /** Additional class names */
  className?: string;
}

type Tier = 'high' | 'medium' | 'low';

function tierFor(score: number): Tier {
  if (score >= 85) return 'high';
  if (score >= 70) return 'medium';
  return 'low';
}

const TIER_LABEL: Record<Tier, string> = {
  high: 'Yüksek güven',
  medium: 'Orta güven',
  low: 'Düşük güven',
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
 * Hover/focus reveals the factor list backing the score.
 */
export function ConfidenceBadge({ score, factors, compact, className }: ConfidenceBadgeProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const tier = tierFor(clamped);
  const id = useId();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const hasFactors = !!factors && factors.length > 0;

  return (
    <span ref={ref} className={`relative inline-flex ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => hasFactors && setOpen((v) => !v)}
        onMouseEnter={() => hasFactors && setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => hasFactors && setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-describedby={open ? id : undefined}
        aria-label={`${TIER_LABEL[tier]}: ${clamped}%`}
        data-tier={tier}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold leading-none transition ${TIER_CLASS[tier]} ${
          hasFactors ? 'cursor-help' : 'cursor-default'
        }`}
      >
        <span aria-hidden="true">●</span>
        <span>{compact ? `${clamped}%` : `${TIER_LABEL[tier]} · ${clamped}%`}</span>
      </button>
      {open && hasFactors && (
        <span
          id={id}
          role="tooltip"
          className="absolute left-0 top-full z-50 mt-1 w-64 max-w-xs rounded-lg border border-ak-border bg-ak-surface p-2 text-xs text-ak-text-primary shadow-lg"
        >
          <span className="mb-1 block font-semibold">Güven faktörleri</span>
          <ul className="list-disc space-y-0.5 pl-4 text-ak-text-secondary">
            {factors!.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </span>
      )}
    </span>
  );
}

export default ConfidenceBadge;
