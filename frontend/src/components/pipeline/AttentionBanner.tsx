import { useState } from 'react';
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

// Human-readable stage names. Backend now emits granular keys
// (critic-spec, critic-code) so the banner can disambiguate the two
// Critic rounds; older payloads still send bare agent names so we
// gracefully fall back to a Title-cased version.
// T5: surface the renamed labels — Critic → Değerlendirme. Backend
// stage identifiers ('critic', 'critic-spec', 'critic-code') stay the
// same so persisted events keep displaying correctly.
const STAGE_LABEL: Record<string, string> = {
  scribe: 'Scribe',
  proto: 'Proto',
  trace: 'Trace',
  critic: 'Değerlendirme',
  'critic-spec': 'Değerlendirme · spec',
  'critic-code': 'Değerlendirme · kod',
};

function labelForStage(stage: string): string {
  return STAGE_LABEL[stage] ?? stage.charAt(0).toUpperCase() + stage.slice(1);
}

/**
 * AttentionBanner — surfaces ExplainabilityService attention points.
 * Sorts by severity, caps at `limit`, and renders nothing when empty.
 */
export function AttentionBanner({ points, limit = 3, className }: AttentionBannerProps) {
  const [expanded, setExpanded] = useState(false);
  if (!points || points.length === 0) return null;
  const sorted = [...points].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const capped = sorted.slice(0, limit);
  const overflow = sorted.length - capped.length;
  const visible = expanded ? sorted : capped;
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
          <span className="text-xs font-medium opacity-75">{labelForStage(p.stage)}</span>
          <span className="text-xs opacity-60">·</span>
          <span className="flex-1">{p.issue}</span>
        </div>
      ))}
      {overflow > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="self-start text-xs text-ak-text-tertiary underline-offset-2 hover:underline focus:outline-none focus-visible:underline"
        >
          {expanded ? 'Gizle' : `+${overflow} ek dikkat noktası göster`}
        </button>
      )}
    </div>
  );
}

export default AttentionBanner;
