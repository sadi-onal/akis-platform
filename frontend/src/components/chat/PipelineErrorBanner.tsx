import { cn } from '../../utils/cn';
import { errorCodeToFriendlyMessage } from '../../utils/errorMessages';
import type { PipelineError } from '../../types/pipeline';

interface PipelineErrorBannerProps {
  error: PipelineError;
  onRetry?: () => void;
  onSkipTrace?: () => void;
  className?: string;
  /**
   * #490 BUG-N: when a retry POST is in flight, the parent keeps the banner
   * visible (even though the backend may have already moved `stage` away from
   * `failed`) and sets this flag so the Tekrar Dene button becomes a
   * disabled loader. Prevents the user from thinking the pipeline has already
   * recovered when async retry hasn't resolved yet.
   */
  isRetrying?: boolean;
}

/**
 * Prominent banner displayed above the chat scroll view when a pipeline
 * reaches the `failed` stage. Shows a bakkal-Türkçesi friendly title
 * (derived from `error.code` via `errorCodeToFriendlyMessage`), a single
 * actionable sentence, the raw backend message as a small technical line,
 * and recovery buttons (retry / skip-trace / reconnect-github).
 *
 * Issue #480 (BUG-I). Retry-in-flight state added in #490 (BUG-N).
 * P11 — error-code → severity/title classification (rate-limit vs kota vs
 * zaman aşımı vs ağ) so a demo audience does not see "rate limit exceeded".
 */
export function PipelineErrorBanner({
  error,
  onRetry,
  onSkipTrace,
  className,
  isRetrying = false,
}: PipelineErrorBannerProps) {
  const showRetry = error.retryable && onRetry;
  const showSkipTrace = error.recoveryAction === 'skip-trace' && onSkipTrace;
  const showReconnectGitHub = error.recoveryAction === 'reconnect_github';

  const friendly = errorCodeToFriendlyMessage(error.code, error.message);

  // Severity drives the color palette of the banner.
  const palette =
    friendly.severity === 'warn'
      ? {
          border: 'border-amber-500/30',
          bg: 'bg-amber-500/[0.08]',
          icon: 'text-amber-400',
          title: 'text-amber-200',
          chipBorder: 'border-amber-500/20',
          chipBg: 'bg-amber-500/10',
          chipText: 'text-amber-300',
        }
      : friendly.severity === 'info'
        ? {
            border: 'border-sky-500/30',
            bg: 'bg-sky-500/[0.08]',
            icon: 'text-sky-400',
            title: 'text-sky-200',
            chipBorder: 'border-sky-500/20',
            chipBg: 'bg-sky-500/10',
            chipText: 'text-sky-300',
          }
        : {
            border: 'border-red-500/30',
            bg: 'bg-red-500/[0.08]',
            icon: 'text-red-400',
            title: 'text-red-300',
            chipBorder: 'border-red-500/20',
            chipBg: 'bg-red-500/10',
            chipText: 'text-red-400',
          };

  // When we matched the code, the backend's raw message lives on a second
  // line as a (smaller) technical detail. When unmatched, the raw message
  // already lives in `friendly.detail` (regression-safe fallback path).
  const showTechnicalLine = friendly.matched && error.message && error.message !== friendly.detail;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        'flex flex-col gap-2 border-b px-4 py-3 text-sm',
        palette.border,
        palette.bg,
        className
      )}
      data-testid="pipeline-error-banner"
      data-error-severity={friendly.severity}
    >
      {/* Title row */}
      <div className="flex items-start gap-2">
        <svg
          className={cn('mt-0.5 h-4 w-4 flex-shrink-0', palette.icon)}
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
          <span className={cn('font-semibold', palette.title)}>{friendly.title}</span>
          <span className="text-ak-text-secondary" data-testid="banner-detail">
            {friendly.detail}
          </span>
          {showTechnicalLine && (
            <span className="text-[11px] text-ak-text-muted" data-testid="banner-technical-detail">
              {error.message}
            </span>
          )}
          {/* Stage-specific detail (e.g. "trace_testing aşamasında 15 dk..."): the
              most informative line. Hidden when missing or duplicating message. */}
          {error.technicalDetail && error.technicalDetail !== error.message && (
            <span className="text-[11px] text-ak-text-muted" data-testid="banner-stage-detail">
              {error.technicalDetail}
            </span>
          )}
        </div>
        {/* Error code chip */}
        <span
          className={cn(
            'flex-shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px]',
            palette.chipBorder,
            palette.chipBg,
            palette.chipText
          )}
        >
          {error.code}
        </span>
      </div>

      {/* Action buttons */}
      {(showRetry || showSkipTrace || showReconnectGitHub) && (
        <div className="flex gap-2 pl-6">
          {showRetry && (
            <button
              onClick={isRetrying ? undefined : onRetry}
              disabled={isRetrying}
              aria-busy={isRetrying}
              className={cn(
                'rounded-md border px-3 py-1 text-[12px] font-medium transition-colors',
                isRetrying
                  ? 'cursor-wait border-amber-500/30 bg-amber-500/10 text-amber-200'
                  : 'border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20 hover:text-red-200'
              )}
              data-testid="retry-button"
            >
              {isRetrying ? (
                <span className="flex items-center gap-1.5">
                  <svg
                    className="h-3 w-3 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <circle
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="3"
                      opacity="0.25"
                    />
                    <path
                      d="M22 12a10 10 0 0 1-10 10"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                    />
                  </svg>
                  Yeniden deneniyor...
                </span>
              ) : (
                'Tekrar Dene'
              )}
            </button>
          )}
          {showSkipTrace && (
            <button
              onClick={onSkipTrace}
              className="rounded-md border border-ak-border bg-ak-surface-2 px-3 py-1 text-[12px] font-medium text-ak-text-secondary transition-colors hover:text-ak-text-primary"
              data-testid="skip-trace-button"
              // PR-U2 #9: buton state-aware (`showSkipTrace = error.recoveryAction === 'skip-trace'`)
              // ama kullanıcı "pipeline'ı iptal mi ediyorum?" diye düşünüyor.
              // Net bir tooltip + aria-description ekledik.
              title="Sadece test üretim adımını (Trace) atla — kod ve iskelet korunur, gönderim ekranına geçer."
              aria-label="Trace adımını atla. Akış iptal edilmez; kod hazır, sadece testler oluşturulmadan devam edilir."
            >
              Trace'i Atla
            </button>
          )}
          {showReconnectGitHub && (
            <a
              href="/settings?tab=integrations"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[12px] font-medium text-amber-300 transition-colors hover:bg-amber-500/20 hover:text-amber-200"
              data-testid="reconnect-github-button"
            >
              GitHub&apos;a Yeniden Bağlan
            </a>
          )}
        </div>
      )}
    </div>
  );
}
