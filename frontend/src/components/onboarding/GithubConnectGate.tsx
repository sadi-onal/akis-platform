import { useState } from 'react';
import { cn } from '../../utils/cn';
import { PENDING_GITHUB_IDEA_KEY } from './githubConnectStorage';

interface GithubConnectGateProps {
  pendingIdea: string;
  onCancel: () => void;
}

const OAUTH_START_URL = '/api/integrations/github/oauth/start';

/**
 * Inline gate shown when the user submits an idea without a GitHub
 * integration. Persists the idea to sessionStorage so ChatPage can
 * auto-resume after the OAuth dance returns to /chat?github=connected.
 */
export function GithubConnectGate({ pendingIdea, onCancel }: GithubConnectGateProps) {
  const [redirecting, setRedirecting] = useState(false);

  const handleConnect = () => {
    setRedirecting(true);
    sessionStorage.setItem(PENDING_GITHUB_IDEA_KEY, pendingIdea);
    window.location.href = OAUTH_START_URL;
  };

  return (
    <div
      role="region"
      aria-label="GitHub bağlantısı gerekli"
      data-testid="github-connect-gate"
      className="mx-auto w-full max-w-2xl rounded-2xl border border-ak-border bg-ak-surface p-6 shadow-ak-elevation-1 animate-fade-in"
    >
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ak-primary/10">
          <svg
            viewBox="0 0 24 24"
            className="h-6 w-6 text-ak-primary"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-1.92c-3.2.7-3.87-1.54-3.87-1.54-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.24.73-1.53-2.55-.29-5.23-1.27-5.23-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.18.92-.25 1.9-.38 2.88-.38s1.96.13 2.88.38c2.18-1.49 3.14-1.18 3.14-1.18.63 1.58.23 2.75.11 3.04.74.8 1.18 1.82 1.18 3.07 0 4.4-2.69 5.36-5.25 5.65.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
          </svg>
        </div>

        <div className="min-w-0 flex-1">
          <h3 className="mb-1 text-base font-semibold text-ak-text-primary">
            Devam etmek için GitHub'ı bağla
          </h3>
          <p className="mb-3 text-sm leading-relaxed text-ak-text-secondary">
            Fikrini aldık. AKIS bu fikri çalıştırabilmek için adına bir GitHub
            deposu açacak.
          </p>

          <ul className="mb-4 space-y-1.5 text-sm text-ak-text-secondary">
            <li className="flex items-start gap-2">
              <CheckIcon />
              <span>Senin için yeni bir depo açar</span>
            </li>
            <li className="flex items-start gap-2">
              <CheckIcon />
              <span>Yazdığı kodu o depoya gönderir</span>
            </li>
            <li className="flex items-start gap-2">
              <CheckIcon />
              <span>Mevcut depolarına dokunmaz</span>
            </li>
          </ul>

          <p
            className="mb-4 rounded-lg bg-ak-surface-2 px-3 py-2 text-xs italic text-ak-text-tertiary line-clamp-2"
            data-testid="github-connect-gate-pending-idea"
          >
            "{pendingIdea}"
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleConnect}
              disabled={redirecting}
              data-testid="github-connect-gate-connect"
              className={cn(
                'inline-flex items-center gap-2 rounded-xl bg-ak-primary px-4 py-2 text-sm font-semibold text-[color:var(--ak-on-primary)] shadow-ak-elevation-1 transition-all',
                'hover:brightness-110 active:brightness-95',
                redirecting && 'opacity-60 cursor-wait',
              )}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-1.92c-3.2.7-3.87-1.54-3.87-1.54-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.24.73-1.53-2.55-.29-5.23-1.27-5.23-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.18.92-.25 1.9-.38 2.88-.38s1.96.13 2.88.38c2.18-1.49 3.14-1.18 3.14-1.18.63 1.58.23 2.75.11 3.04.74.8 1.18 1.82 1.18 3.07 0 4.4-2.69 5.36-5.25 5.65.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
              </svg>
              {redirecting ? "GitHub'a yönlendiriliyorsun..." : 'GitHub ile Bağla ve Devam Et'}
            </button>
            <button
              type="button"
              onClick={onCancel}
              data-testid="github-connect-gate-cancel"
              className="rounded-xl px-3 py-2 text-sm font-medium text-ak-text-tertiary transition-colors hover:text-ak-text-secondary"
            >
              Vazgeç
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg
      className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

