/**
 * Claude-Code-style "Background agent started" line.
 *
 * Renders a single compact row announcing that an AKIS agent (Scribe / Proto /
 * Trace) has taken over the current pipeline stage. Matches the visual pattern
 * the user pointed to in their reference screenshot for issue #390 / BUG-10:
 *
 *     ● Background agent started  Scribe — Spec yazıyor
 *
 * Intentionally presentational only. Higher-level code decides when to mount
 * the line (e.g. on `stage_change` events from usePipelineStream).
 */
import { cn } from '../../utils/cn';
import { useI18n } from '../../i18n/useI18n';

export type NarratorAgent = 'scribe' | 'proto' | 'trace';

const AGENT_DOT: Record<NarratorAgent, string> = {
  scribe: 'bg-blue-400',
  proto: 'bg-orange-400',
  trace: 'bg-purple-400',
};

const AGENT_LABEL: Record<NarratorAgent, string> = {
  scribe: 'Scribe',
  proto: 'Proto',
  trace: 'Trace',
};

export interface AgentStartedLineProps {
  agent: NarratorAgent;
  /**
   * Either an i18n key (preferred — e.g. `pipeline.activity.proto.creating_scaffold`)
   * or a raw string. PR-A: ChatPage now passes activity keys so EN locale gets
   * English labels. Unknown keys fall back to the literal string (i18n returns
   * the key as-is when not found).
   */
  task?: string;
  /** Static "started" state uses muted color; use `running` for active pulse. */
  state?: 'started' | 'running' | 'completed';
  /** Elapsed time/token annotation shown in the gutter (Claude-Code style). */
  meta?: string;
  className?: string;
}

export function AgentStartedLine({
  agent,
  task,
  state = 'started',
  meta,
  className,
}: AgentStartedLineProps) {
  const { t } = useI18n();
  const isActive = state === 'running';
  const taskLabel = task ? t(task) : undefined;
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 text-xs text-ak-text-secondary',
        'border-l-2',
        agent === 'scribe' && 'border-blue-400/60',
        agent === 'proto' && 'border-orange-400/60',
        agent === 'trace' && 'border-purple-400/60',
        className,
      )}
      role="status"
      aria-live={isActive ? 'polite' : 'off'}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full flex-shrink-0',
          AGENT_DOT[agent],
          isActive && 'animate-pulse',
        )}
        aria-hidden
      />
      <span className="text-ak-text-tertiary">
        {state === 'completed' ? 'Background agent finished' : 'Background agent started'}
      </span>
      <span className="font-medium text-ak-text-primary">{AGENT_LABEL[agent]}</span>
      {taskLabel && (
        <>
          <span className="text-ak-text-tertiary">—</span>
          <span className="text-ak-text-secondary truncate">{taskLabel}</span>
        </>
      )}
      {meta && (
        <span className="ml-auto font-mono text-[11px] text-ak-text-tertiary whitespace-nowrap">
          {meta}
        </span>
      )}
    </div>
  );
}
