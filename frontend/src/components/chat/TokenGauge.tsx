import { useMemo, useState } from 'react';
import { cn } from '../../utils/cn';
import { formatTokens } from '../../utils/formatTokens';
import { useI18n } from '../../i18n/useI18n';
import type { WorkflowTokenUsage } from '../../types/workflow';

interface TokenGaugeProps {
  usage: WorkflowTokenUsage;
  className?: string;
}

/**
 * Compact pill showing chat-level token usage against the model's total
 * context window — "12.4k / 200k · %6.2". Colors escalate at 80% (amber) and
 * 95% (red). Tooltip breaks down input vs output tokens plus model name.
 * Issue #438.
 */
export function TokenGauge({ usage, className }: TokenGaugeProps) {
  const { t } = useI18n();
  const [tooltipOpen, setTooltipOpen] = useState(false);

  const { totalLabel, contextLabel, percentLabel, severity } = useMemo(() => {
    const pct = usage.percentUsed;
    const severity: 'ok' | 'warn' | 'critical' =
      pct >= 95 ? 'critical' : pct >= 80 ? 'warn' : 'ok';
    return {
      totalLabel: formatTokens(usage.totalTokens),
      contextLabel: formatTokens(usage.contextWindow),
      percentLabel: pct.toFixed(pct < 10 ? 2 : 1),
      severity,
    };
  }, [usage.percentUsed, usage.totalTokens, usage.contextWindow]);

  const severityClasses: Record<typeof severity, string> = {
    ok: 'border-ak-border text-ak-text-secondary hover:border-ak-primary hover:text-ak-primary',
    warn: 'border-amber-400/60 bg-amber-400/10 text-amber-300 hover:border-amber-400',
    critical: 'border-red-500/60 bg-red-500/10 text-red-300 hover:border-red-400',
  };

  return (
    <div
      className={cn('relative hidden sm:flex', className)}
      onMouseEnter={() => setTooltipOpen(true)}
      onMouseLeave={() => setTooltipOpen(false)}
      onFocus={() => setTooltipOpen(true)}
      onBlur={() => setTooltipOpen(false)}
    >
      <button
        type="button"
        aria-label={t('chat.tokens.ariaLabel')}
        className={cn(
          'flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-mono transition-colors',
          severityClasses[severity],
        )}
      >
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        </svg>
        <span>
          {totalLabel} / {contextLabel} · %{percentLabel}
        </span>
      </button>

      {tooltipOpen && (
        <div
          role="tooltip"
          className="absolute right-0 top-full z-20 mt-1 w-max min-w-[220px] rounded-lg border border-ak-border bg-ak-surface-2 px-3 py-2 text-[11px] text-ak-text-secondary shadow-lg"
        >
          <div className="mb-1 font-semibold text-ak-text-primary">
            {t('chat.tokens.tooltip.title')}
          </div>
          <div className="flex justify-between gap-6">
            <span>{t('chat.tokens.tooltip.input')}</span>
            <span className="font-mono text-ak-text-primary">{formatTokens(usage.inputTokens)}</span>
          </div>
          <div className="flex justify-between gap-6">
            <span>{t('chat.tokens.tooltip.output')}</span>
            <span className="font-mono text-ak-text-primary">{formatTokens(usage.outputTokens)}</span>
          </div>
          <div className="mt-1 flex justify-between gap-6 border-t border-ak-border pt-1">
            <span>{t('chat.tokens.tooltip.contextWindow')}</span>
            <span className="font-mono text-ak-text-primary">{formatTokens(usage.contextWindow)}</span>
          </div>
          <div className="mt-1 text-[10px] text-ak-text-tertiary">
            {t('chat.tokens.tooltip.model')}: <span className="font-mono">{usage.model}</span>
          </div>
          {severity === 'warn' && (
            <div className="mt-2 text-[10px] text-amber-300">
              {t('chat.tokens.warning.high')}
            </div>
          )}
          {severity === 'critical' && (
            <div className="mt-2 text-[10px] text-red-300">
              {t('chat.tokens.warning.critical')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

