import { cn } from '../../utils/cn';
import { useI18n } from '../../i18n/useI18n';
import type { WorkflowStatus, StageStatus } from '../../types/workflow';

type BadgeStatus = WorkflowStatus | StageStatus;

const STATUS_CONFIG: Record<string, { labelKey: string; colorClass: string; dotClass?: string }> = {
  completed: { labelKey: 'badge.completed', colorClass: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/30' },
  completed_partial: { labelKey: 'badge.partial', colorClass: 'text-amber-400 bg-amber-400/10 border-amber-400/30' },
  running: { labelKey: 'badge.running', colorClass: 'text-amber-400 bg-amber-400/10 border-amber-400/30', dotClass: 'bg-amber-400' },
  awaiting_approval: { labelKey: 'badge.awaiting_approval', colorClass: 'text-amber-400 bg-amber-400/10 border-amber-400/30' },
  failed: { labelKey: 'badge.failed', colorClass: 'text-red-400 bg-red-400/10 border-red-400/30' },
  cancelled: { labelKey: 'badge.cancelled', colorClass: 'text-ak-text-tertiary bg-ak-text-tertiary/10 border-ak-text-tertiary/30' },
  idle: { labelKey: 'badge.pending', colorClass: 'text-ak-text-tertiary bg-ak-text-tertiary/10 border-ak-text-tertiary/30' },
  pending: { labelKey: 'badge.pending', colorClass: 'text-amber-400 bg-amber-400/10 border-amber-400/30' },
  scribe_clarifying: { labelKey: 'badge.running', colorClass: 'text-amber-400 bg-amber-400/10 border-amber-400/30', dotClass: 'bg-amber-400' },
  scribe_generating: { labelKey: 'badge.running', colorClass: 'text-amber-400 bg-amber-400/10 border-amber-400/30', dotClass: 'bg-amber-400' },
  proto_building: { labelKey: 'badge.running', colorClass: 'text-amber-400 bg-amber-400/10 border-amber-400/30', dotClass: 'bg-amber-400' },
  trace_testing: { labelKey: 'badge.running', colorClass: 'text-amber-400 bg-amber-400/10 border-amber-400/30', dotClass: 'bg-amber-400' },
};

interface StatusBadgeProps {
  status: BadgeStatus;
  size?: 'small' | 'normal';
  className?: string;
}

export function StatusBadge({ status, size = 'normal', className }: StatusBadgeProps) {
  const { t } = useI18n();
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.idle;
  const isSmall = size === 'small';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border font-mono font-semibold uppercase tracking-wide',
        isSmall ? 'px-2 py-0.5 text-[10px]' : 'px-3 py-1 text-[11px]',
        cfg.colorClass,
        className,
      )}
    >
      {cfg.dotClass && (
        <span className={cn('h-1.5 w-1.5 rounded-full animate-pulse', cfg.dotClass)} />
      )}
      {status === 'completed' && <span>&#10003;</span>}
      {t(cfg.labelKey)}
    </span>
  );
}
