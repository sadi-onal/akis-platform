import type { AttentionPoint } from '../../types/pipeline';

export interface AttentionBannerProps {
  points: AttentionPoint[];
  /** Optional limit on items shown — defaults to 3 */
  limit?: number;
  className?: string;
}

const SEVERITY_CLASS = {
  high: 'bg-rose-500/10 border-rose-500/40 text-rose-700 dark:bg-rose-500/10 dark:border-rose-500/30 dark:text-rose-200',
  medium:
    'bg-amber-500/10 border-amber-500/40 text-amber-800 dark:bg-amber-500/10 dark:border-amber-500/30 dark:text-amber-200',
  low: 'bg-ak-surface-2 border-ak-border text-ak-text-secondary',
} as const;

const SEVERITY_LABEL = {
  high: 'Önemli',
  medium: 'Dikkat',
  low: 'Bilgi',
} as const;

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;

/**
 * AttentionBanner — surfaces ExplainabilityService attention points.
 * Sorts by severity, caps at `limit`, and renders nothing when empty.
 */
export function AttentionBanner({ points, limit = 3, className }: AttentionBannerProps) {
  if (!points || points.length === 0) return null;
  const sorted = [...points].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const visible = sorted.slice(0, limit);
  const overflow = sorted.length - visible.length;
  return (
    <div
      role="region"
      aria-label="Pipeline dikkat noktaları"
      className={`flex flex-col gap-2 ${className ?? ''}`}
    >
      {visible.map((p, idx) => (
        <div
          key={`${p.stage}-${idx}`}
          role="status"
          className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${SEVERITY_CLASS[p.severity]}`}
          data-severity={p.severity}
        >
          <span className="font-semibold uppercase tracking-wide text-xs">
            {SEVERITY_LABEL[p.severity]}
          </span>
          <span className="text-xs opacity-60">·</span>
          <span className="text-xs font-medium opacity-75">{p.stage}</span>
          <span className="text-xs opacity-60">·</span>
          <span className="flex-1">{p.issue}</span>
        </div>
      ))}
      {overflow > 0 && (
        <p className="text-xs text-ak-text-tertiary">+{overflow} ek dikkat noktası gizlendi</p>
      )}
    </div>
  );
}

export default AttentionBanner;
