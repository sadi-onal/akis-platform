import { useState, useEffect } from 'react';
import { cn } from '../../../utils/cn';

interface StepGitHubProps {
  onConnect: (token: string) => Promise<void>;
  onSkip: () => void;
}

export function StepGitHub({ onConnect, onSkip }: StepGitHubProps) {
  const [connected, setConnected] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [showPAT, setShowPAT] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/github/status', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.connected) {
          setConnected(true);
          setUsername(data.username);
        }
      })
      .catch((err) => {
        if (import.meta.env.DEV) console.warn('[StepGitHub] GitHub status check failed:', err);
      });
  }, []);

  const handlePATConnect = async () => {
    if (!token.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onConnect(token.trim());
      setConnected(true);
    } catch {
      setError('GitHub bağlantısı başarısız. Token geçerli mi kontrol edin.');
    } finally {
      setSaving(false);
    }
  };

  const handleOAuthConnect = () => {
    window.location.href = '/auth/oauth/github';
  };

  if (connected) {
    return (
      <div className="space-y-5">
        <div className="text-center mb-6">
          <h2 className="text-xl font-bold text-ak-text-primary">GitHub Bağlantısı</h2>
          <p className="text-xs text-ak-text-tertiary mt-1">Kod push için gerekli</p>
        </div>

        <div className="flex flex-col items-center gap-3 rounded-2xl border border-ak-primary/20 bg-ak-primary/5 p-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-ak-primary/10">
            <svg className="h-6 w-6 text-ak-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </div>
          <p className="text-sm font-medium text-ak-text-primary">GitHub bağlı</p>
          {username && <p className="text-xs text-ak-text-tertiary">@{username}</p>}
        </div>

        <p className="text-center text-xs text-ak-text-tertiary">Devam butonuna tıklayın</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="text-center mb-6">
        <h2 className="text-xl font-bold text-ak-text-primary">GitHub Bağlantısı</h2>
        <p className="text-xs text-ak-text-tertiary mt-1">Proto ajanının kodu push edebilmesi için gerekli</p>
      </div>

      {/* OAuth option */}
      <button
        onClick={handleOAuthConnect}
        className={cn(
          'w-full flex items-center justify-center gap-3 rounded-xl border border-ak-border bg-ak-surface py-3 px-4',
          'text-sm font-medium text-ak-text-primary hover:bg-ak-surface-2 transition-colors',
        )}
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
        </svg>
        GitHub ile Bağlan
      </button>

      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-ak-border" />
        <span className="text-[10px] text-ak-text-tertiary uppercase">veya</span>
        <div className="flex-1 h-px bg-ak-border" />
      </div>

      {/* PAT option */}
      {!showPAT ? (
        <button
          onClick={() => setShowPAT(true)}
          className="w-full text-center text-xs text-ak-text-tertiary hover:text-ak-primary transition-colors"
        >
          Personal Access Token ile bağlan
        </button>
      ) : (
        <div className="space-y-2">
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="ghp_..."
            autoFocus
            className={cn(
              'w-full rounded-xl border border-ak-border bg-ak-surface-2 px-3.5 py-2.5 text-sm text-ak-text-primary font-mono',
              'placeholder:text-ak-text-tertiary focus:border-ak-primary focus:outline-none focus:ring-1 focus:ring-ak-primary/30',
            )}
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            onClick={handlePATConnect}
            disabled={!token.trim() || saving}
            className={cn(
              'w-full rounded-xl bg-ak-primary py-2.5 text-sm font-semibold text-[color:var(--ak-on-primary)]',
              'hover:brightness-110 transition-all',
              (!token.trim() || saving) && 'opacity-50 cursor-not-allowed',
            )}
          >
            {saving ? 'Bağlanıyor...' : 'Bağla'}
          </button>
        </div>
      )}

      <button
        onClick={onSkip}
        className="w-full text-center text-xs text-ak-text-tertiary hover:text-ak-text-secondary transition-colors mt-2"
      >
        Daha sonra bağlayın →
      </button>
    </div>
  );
}
