import { useEffect } from 'react';
import { cn } from '../../utils/cn';

interface GithubConnectModalProps {
  open: boolean;
  onDismiss: () => void;
}

const OAUTH_START_URL = '/api/integrations/github/oauth/start';

export function GithubConnectModal({ open, onDismiss }: GithubConnectModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onDismiss]);

  if (!open) return null;

  const handleConnect = () => {
    window.location.href = OAUTH_START_URL;
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="GitHub bağlantısı"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ak-bg/95 backdrop-blur-sm animate-fade-in"
    >
      <div
        className={cn(
          'relative w-full max-w-md mx-4 rounded-2xl border border-ak-border',
          'bg-ak-surface p-6 shadow-2xl animate-scale-in',
        )}
      >
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Kapat"
          className="absolute right-3 top-3 text-ak-text-tertiary hover:text-ak-text-secondary transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="mb-4 flex items-center justify-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-ak-primary/10">
            <svg
              viewBox="0 0 24 24"
              className="h-8 w-8 text-ak-primary"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-1.92c-3.2.7-3.87-1.54-3.87-1.54-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.24.73-1.53-2.55-.29-5.23-1.27-5.23-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.18.92-.25 1.9-.38 2.88-.38s1.96.13 2.88.38c2.18-1.49 3.14-1.18 3.14-1.18.63 1.58.23 2.75.11 3.04.74.8 1.18 1.82 1.18 3.07 0 4.4-2.69 5.36-5.25 5.65.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
            </svg>
          </div>
        </div>

        <h2 className="mb-1.5 text-center text-base font-semibold text-ak-text-primary">
          GitHub'ı bağla
        </h2>
        <p className="mb-5 text-center text-sm leading-relaxed text-ak-text-secondary">
          AKIS pipeline'ının senin adına repo açabilmesi, dal oluşturabilmesi ve
          kod push edebilmesi için GitHub hesabını OAuth ile bağlaman gerekir.
          Ne kadar GitHub ile giriş yapmış olsan da entegrasyonu ayrı şekilde
          onaylaman gerek — token'lar farklı yetki kapsamlarında.
        </p>

        <button
          type="button"
          onClick={handleConnect}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-xl bg-ak-primary px-4 py-2.5',
            'text-sm font-semibold text-ak-bg shadow-ak-elevation-2',
            'hover:bg-ak-primary/90 transition-colors',
          )}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
            <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-1.92c-3.2.7-3.87-1.54-3.87-1.54-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.24.73-1.53-2.55-.29-5.23-1.27-5.23-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.18.92-.25 1.9-.38 2.88-.38s1.96.13 2.88.38c2.18-1.49 3.14-1.18 3.14-1.18.63 1.58.23 2.75.11 3.04.74.8 1.18 1.82 1.18 3.07 0 4.4-2.69 5.36-5.25 5.65.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
          </svg>
          GitHub ile Bağla
        </button>

        <button
          type="button"
          onClick={onDismiss}
          className="mt-3 w-full text-center text-xs text-ak-text-tertiary hover:text-ak-text-secondary transition-colors"
        >
          Şimdi değil
        </button>
      </div>
    </div>
  );
}
