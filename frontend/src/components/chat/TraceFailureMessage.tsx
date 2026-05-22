import { useI18n } from '../../i18n/useI18n';

export interface TraceFailureMessageProps {
  /** Pipeline error code (e.g. PIPELINE_TIMEOUT, AI_PROVIDER_ERROR). Drives title selection. */
  errorCode: string;
  /** Human-readable detail of what went wrong. Rendered verbatim below the title. */
  errorMessage: string;
  /**
   * When set to 'retry', surfaces the two action buttons. When undefined,
   * the row stays read-only (terminal failure with no recovery path).
   */
  recoveryAction?: 'retry' | 'skip';
  /**
   * Optional iteration number — currently unused for rendering but accepted
   * so the call-site (ChatMessage dispatcher) can pass the full ChatMessage
   * payload without prop-stripping. Useful when we later add "Deneme N" hints.
   */
  iteration?: number;
  /** Retry the trace stage. Wired to usePipelineControls.handleRetry upstream. */
  onRetry: () => void;
  /** Skip the trace stage and move to push. Wired to usePipelineControls.handleSkip. */
  onSkipTrace: () => void;
}

/**
 * Inline chat row rendered for the `trace_failure` ChatMessage variant.
 *
 * F-3 (defense-blocker manuel test 2026-05-15): when Trace times out or
 * errors mid-iteration we previously showed nothing in the chat — the user
 * had no idea why the pipeline stalled. This component surfaces the failure
 * with bakkal-Türkçesi copy and two recovery affordances:
 *   - "Tekrar Dene" → POST /pipelines/:id/retry
 *   - "Trace'siz devam et" → POST /pipelines/:id/skip-trace
 *
 * Both handlers come from usePipelineControls; ChatMessage already threads
 * onRetry + onSkip props through, so we just rename `onSkip` → `onSkipTrace`
 * here to match the existing PipelineErrorBanner convention.
 *
 * Title varies by error code so timeouts get a friendlier copy
 * ("İşlem zaman aşımına uğradı") than generic provider errors
 * ("Test yazımı tamamlanamadı"). Buttons render only when
 * recoveryAction === 'retry'; if the backend marked the failure terminal
 * the row stays read-only.
 */
export function TraceFailureMessage({
  errorCode,
  errorMessage,
  recoveryAction,
  onRetry,
  onSkipTrace,
}: TraceFailureMessageProps) {
  const { t } = useI18n();
  const isTimeout = errorCode === 'PIPELINE_TIMEOUT';
  const title = isTimeout
    ? t('chat.trace_failure.timeout_title')
    : t('chat.trace_failure.error_title');

  return (
    <div
      role="alert"
      data-testid="trace-failure-message"
      className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-4 py-3 animate-in fade-in slide-in-from-left-2 duration-200"
    >
      <div
        className="mt-0.5 flex-shrink-0 text-base leading-none text-amber-400"
        aria-hidden="true"
      >
        ⚠
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="text-sm font-semibold text-amber-200">{title}</div>
        <div className="text-sm text-ak-text-secondary">{errorMessage}</div>
        {recoveryAction === 'retry' && (
          <div className="mt-1 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onRetry}
              data-testid="trace-failure-retry-button"
              className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[12px] font-medium text-amber-200 transition-colors hover:bg-amber-500/20 hover:text-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
            >
              {t('chat.trace_failure.retry')}
            </button>
            <button
              type="button"
              onClick={onSkipTrace}
              data-testid="trace-failure-skip-button"
              title="Sadece test üretim adımını (Trace) atla — kod ve iskelet korunur, gönderim ekranına geçer."
              aria-label="Trace adımını atla. Akış iptal edilmez; kod hazır, sadece testler oluşturulmadan devam edilir."
              className="rounded-md border border-ak-border bg-ak-surface-2 px-3 py-1 text-[12px] font-medium text-ak-text-secondary transition-colors hover:text-ak-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ak-border-strong"
            >
              {t('chat.trace_failure.skip')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
