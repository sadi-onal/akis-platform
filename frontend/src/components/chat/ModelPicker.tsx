import { useEffect, useRef, useState } from 'react';
import { cn } from '../../utils/cn';
import { shortModelLabel } from '../../utils/modelLabel';
import { useI18n } from '../../i18n/useI18n';
import { workflowsApi } from '../../services/api/workflows';

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  recommended: boolean;
}

interface ModelPickerProps {
  /** Current model ID persisted on the pipeline; falls back to "auto" display when null. */
  value?: string;
  /** Called with the new model ID after the dropdown selection. Parent owns the API call. */
  onSelect: (modelId: string) => void | Promise<void>;
  /** Optional provider hint (anthropic | openai | openrouter) to seed the list. */
  providerHint?: 'anthropic' | 'openai' | 'openrouter';
  disabled?: boolean;
  className?: string;
}

/**
 * Compact model-selection pill rendered in the chat header. Opens an overlay
 * popover with the allowlisted models for the user's active provider; next
 * message uses the chosen model. Issue #437.
 *
 * Styling mirrors `TokenGauge` so the two active-session pills line up.
 */
export function ModelPicker({ value, onSelect, providerHint, disabled, className }: ModelPickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<ModelOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || options.length > 0 || loading) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    workflowsApi.listSupportedModels(providerHint)
      .then((res) => {
        if (cancelled) return;
        setOptions(res.models ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, options.length, loading, providerHint]);

  useEffect(() => {
    if (!open) return;
    const handleClick = (ev: MouseEvent) => {
      if (!rootRef.current?.contains(ev.target as Node)) setOpen(false);
    };
    const handleKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const handleSelect = async (modelId: string) => {
    if (modelId === value) {
      setOpen(false);
      return;
    }
    setSaving(true);
    try {
      await onSelect(modelId);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('chat.model.saveError'));
    } finally {
      setSaving(false);
    }
  };

  const display = value ? shortModelLabel(value) : t('chat.model.auto');

  return (
    <div ref={rootRef} className={cn('relative hidden sm:flex', className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('chat.model.ariaLabel')}
        disabled={disabled || saving}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          'flex items-center gap-1 rounded-lg border border-ak-border px-2.5 py-1 text-[11px] text-ak-text-secondary transition-colors',
          'hover:border-ak-primary hover:text-ak-primary',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          open && 'border-ak-primary text-ak-primary',
        )}
      >
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        <span className="font-mono">{display}</span>
        <svg className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={t('chat.model.ariaLabel')}
          className="absolute right-0 top-full z-20 mt-1 w-max min-w-[260px] rounded-lg border border-ak-border bg-ak-surface-2 p-1 shadow-lg"
        >
          {loading && (
            <div className="px-3 py-2 text-[11px] text-ak-text-tertiary">
              {t('chat.model.loading')}
            </div>
          )}
          {error && (
            <div className="px-3 py-2 text-[11px] text-red-300">{error}</div>
          )}
          {!loading && !error && options.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-ak-text-tertiary">
              {t('chat.model.empty')}
            </div>
          )}
          {!loading && !error && options.map((opt) => (
            <button
              key={opt.id}
              role="option"
              aria-selected={opt.id === value}
              onClick={() => handleSelect(opt.id)}
              disabled={saving}
              className={cn(
                'flex w-full items-center justify-between gap-3 rounded-md px-3 py-1.5 text-left text-[11px] transition-colors',
                opt.id === value
                  ? 'bg-ak-primary/10 text-ak-primary'
                  : 'text-ak-text-secondary hover:bg-ak-surface hover:text-ak-text-primary',
                saving && 'opacity-50 cursor-not-allowed',
              )}
            >
              <div className="flex flex-col">
                <span className="font-mono">{opt.id}</span>
                <span className="text-[10px] text-ak-text-tertiary">{opt.provider}</span>
              </div>
              {opt.recommended && (
                <span className="rounded bg-ak-primary/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-ak-primary">
                  {t('chat.model.recommended')}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

