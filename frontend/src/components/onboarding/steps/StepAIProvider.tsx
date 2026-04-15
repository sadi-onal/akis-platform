import { useState, useEffect } from 'react';
import { cn } from '../../../utils/cn';

const PROVIDERS = [
  { key: 'anthropic' as const, label: 'Anthropic (Claude)', desc: 'claude-sonnet-4-6', placeholder: 'sk-ant-...' },
  { key: 'openai' as const, label: 'OpenAI', desc: 'gpt-4o', placeholder: 'sk-...' },
  { key: 'openrouter' as const, label: 'OpenRouter', desc: 'Birden fazla model', placeholder: 'sk-or-...' },
];

interface StepAIProviderProps {
  onSave: (provider: string, apiKey: string) => Promise<void>;
  onSkip: () => void;
}

export function StepAIProvider({ onSave, onSkip }: StepAIProviderProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/settings/ai-keys/status', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.activeProvider) setActiveProvider(data.activeProvider);
      })
      .catch((err) => {
        if (import.meta.env.DEV) console.warn('[StepAIProvider] AI key status check failed:', err);
      });
  }, []);

  const handleSave = async () => {
    if (!selected || !apiKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(selected, apiKey.trim());
      setActiveProvider(selected);
      setApiKey('');
      setSelected(null);
    } catch {
      setError('API key kaydedilemedi.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="text-center mb-4">
        <h2 className="text-xl font-bold text-ak-text-primary">AI Sağlayıcı</h2>
        <p className="text-xs text-ak-text-tertiary mt-1">Pipeline'larda kullanılacak AI servisi</p>
      </div>

      {activeProvider && (
        <div className="flex items-center gap-2 rounded-xl bg-ak-primary/5 border border-ak-primary/20 px-3 py-2 text-xs">
          <svg className="h-4 w-4 text-ak-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
          <span className="text-ak-text-secondary">
            {PROVIDERS.find(p => p.key === activeProvider)?.label ?? activeProvider} ayarlı
          </span>
        </div>
      )}

      <div className="space-y-2">
        {PROVIDERS.map(p => (
          <button
            key={p.key}
            onClick={() => { setSelected(p.key); setApiKey(''); setError(null); }}
            className={cn(
              'w-full flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all',
              selected === p.key
                ? 'border-ak-primary/40 bg-ak-primary/5'
                : 'border-ak-border bg-ak-surface hover:bg-ak-surface-2',
            )}
          >
            <div className={cn(
              'h-3 w-3 rounded-full border-2 transition-colors',
              selected === p.key ? 'border-ak-primary bg-ak-primary' : 'border-ak-border',
            )} />
            <div>
              <p className="text-sm font-medium text-ak-text-primary">{p.label}</p>
              <p className="text-[11px] text-ak-text-tertiary">{p.desc}</p>
            </div>
          </button>
        ))}
      </div>

      {selected && (
        <div className="space-y-2 animate-slide-up">
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={PROVIDERS.find(p => p.key === selected)?.placeholder}
            autoFocus
            className={cn(
              'w-full rounded-xl border border-ak-border bg-ak-surface-2 px-3.5 py-2.5 text-sm text-ak-text-primary font-mono',
              'placeholder:text-ak-text-tertiary focus:border-ak-primary focus:outline-none focus:ring-1 focus:ring-ak-primary/30',
            )}
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            onClick={handleSave}
            disabled={!apiKey.trim() || saving}
            className={cn(
              'w-full rounded-xl bg-ak-primary py-2.5 text-sm font-semibold text-[color:var(--ak-on-primary)]',
              'hover:brightness-110 transition-all',
              (!apiKey.trim() || saving) && 'opacity-50 cursor-not-allowed',
            )}
          >
            {saving ? 'Kaydediliyor...' : 'Kaydet'}
          </button>
        </div>
      )}

      <button
        onClick={onSkip}
        className="w-full text-center text-xs text-ak-text-tertiary hover:text-ak-text-secondary transition-colors"
      >
        Daha sonra ekleyin →
      </button>
    </div>
  );
}
