import { cn } from '../../utils/cn';
import type { PipelineError } from '../../types/pipeline';

interface PipelineErrorBannerProps {
  error: PipelineError;
  onRetry?: () => void;
  onSkipTrace?: () => void;
  className?: string;
}

/**
 * Prominent banner displayed above the chat scroll view when a pipeline
 * reaches the `failed` stage. Shows the user-friendly error message from
 * the backend, the error code, and action buttons (retry / skip-trace)
 * based on the error's `retryable` flag and `recoveryAction`.
 *
 * Issue #480 (BUG-I).
 */
export function PipelineErrorBanner({
  error,
  onRetry,
  onSkipTrace,
  className,
}: PipelineErrorBannerProps) {
  const showRetry = error.retryable && onRetry;
  const showSkipTrace = error.recoveryAction === 'skip-trace' && onSkipTrace;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        'flex flex-col gap-2 border-b border-red-500/30 bg-red-500/[0.08] px-4 py-3 text-sm',
        className,
      )}
      data-testid="pipeline-error-banner"
    >
      {/* Title row */}
      <div className="flex items-start gap-2">
        <svg
          className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
          />
        </svg>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-semibold text-red-300">Pipeline başarısız</span>
          <span className="text-ak-text-secondary">{error.message}</span>
        </div>
        {/* Error code chip */}
        <span className="flex-shrink-0 rounded border border-red-500/20 bg-red-500/10 px-1.5 py-0.5 font-mono text-[10px] text-red-400">
          {error.code}
        </span>
      </div>

      {/* Action buttons */}
      {(showRetry || showSkipTrace) && (
        <div className="flex gap-2 pl-6">
          {showRetry && (
            <button
              onClick={onRetry}
              className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1 text-[12px] font-medium text-red-300 transition-colors hover:bg-red-500/20 hover:text-red-200"
              data-testid="retry-button"
            >
              Tekrar Dene
            </button>
          )}
          {showSkipTrace && (
            <button
              onClick={onSkipTrace}
              className="rounded-md border border-ak-border bg-ak-surface-2 px-3 py-1 text-[12px] font-medium text-ak-text-secondary transition-colors hover:text-ak-text-primary"
              data-testid="skip-trace-button"
            >
              Trace'i Atla
            </button>
          )}
        </div>
      )}
    </div>
  );
}
