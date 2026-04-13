import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Link } from 'react-router-dom';

interface Props {
  children: ReactNode;
  fallbackPath?: string;
  fallbackLabel?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  showDetails: boolean;
}

/**
 * Error Boundary for graceful error handling in React components.
 * Prevents blank screens by catching JavaScript errors anywhere in the child component tree.
 * 
 * Features:
 * - User-friendly error message
 * - "Back to [path]" and "Reload" actions
 * - Collapsible technical details (dev mode only)
 * - Secret redaction in error messages
 */
export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    showDetails: false,
  };

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Log error without exposing secrets
    console.error('ErrorBoundary caught an error:', redactSecrets(error.message));
    console.error('Component stack:', errorInfo.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  private toggleDetails = () => {
    this.setState((prev) => ({ showDetails: !prev.showDetails }));
  };

  public render() {
    const { fallbackPath = '/dashboard', fallbackLabel = 'Dashboard' } = this.props;

    if (this.state.hasError) {
      const isDev = import.meta.env.DEV;
      const errorMessage = this.state.error?.message || 'An unexpected error occurred';

      return (
        <div className="flex min-h-[400px] flex-col items-center justify-center p-8">
          <div className="w-full max-w-md rounded-lg border border-ak-danger/30 bg-ak-surface-2 p-6 text-center shadow-lg">
            {/* Error Icon */}
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-ak-danger/10">
              <svg
                className="h-6 w-6 text-ak-danger"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>

            {/* Title */}
            <h2 className="mb-2 text-lg font-semibold text-ak-text-primary">
              Bir hata olustu
            </h2>

            {/* Message */}
            <p className="mb-6 text-sm text-ak-text-secondary">
              Bu sayfa yüklenirken bir hata meydana geldi.
              Lütfen tekrar deneyin veya sorun devam ederse destek ekibiyle iletisime gecin.
            </p>

            {/* Actions */}
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
              <Link
                to={fallbackPath}
                className="inline-flex items-center justify-center rounded-lg border border-ak-border bg-ak-surface px-4 py-2 text-sm font-medium text-ak-text-primary transition-colors hover:bg-ak-surface-3"
              >
                ← {fallbackLabel} sayfasina don
              </Link>
              <button
                onClick={this.handleReload}
                className="inline-flex items-center justify-center rounded-lg bg-ak-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-ak-primary/80"
              >
                Sayfayi Yenile
              </button>
            </div>

            {/* Technical Details (dev mode only) */}
            {isDev && (
              <div className="mt-6 border-t border-ak-border pt-4">
                <button
                  onClick={this.toggleDetails}
                  className="text-xs text-ak-text-tertiary hover:text-ak-text-secondary transition-colors"
                >
                  {this.state.showDetails ? '▼' : '▶'} Technical Details (dev only)
                </button>
                {this.state.showDetails && (
                  <div className="mt-3 rounded bg-ak-surface p-3 text-left">
                    <p className="mb-2 text-xs font-medium text-ak-danger">
                      {redactSecrets(errorMessage)}
                    </p>
                    <pre className="max-h-40 overflow-auto text-xs text-ak-text-tertiary">
                      {redactSecrets(this.state.error?.stack || 'No stack trace available')}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * Redact potential secrets from error messages
 */
function redactSecrets(text: string): string {
  if (!text) return text;

  let redacted = text;
  
  // Redact GitHub tokens
  redacted = redacted.replace(/ghp_[a-zA-Z0-9]{36}/g, 'ghp_REDACTED');
  redacted = redacted.replace(/gho_[a-zA-Z0-9]{36}/g, 'gho_REDACTED');
  redacted = redacted.replace(/ghs_[a-zA-Z0-9]{36}/g, 'ghs_REDACTED');
  redacted = redacted.replace(/ghr_[a-zA-Z0-9]{36}/g, 'ghr_REDACTED');
  redacted = redacted.replace(/ghu_[a-zA-Z0-9]{36}/g, 'ghu_REDACTED');
  redacted = redacted.replace(/github_pat_[a-zA-Z0-9_]{82}/g, 'github_pat_REDACTED');
  
  // Redact npm tokens
  redacted = redacted.replace(/ntn_[a-zA-Z0-9]{36}/g, 'ntn_REDACTED');
  
  // Redact JWT tokens
  redacted = redacted.replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, 'JWT_REDACTED');

  return redacted;
}

export default ErrorBoundary;

