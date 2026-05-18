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
  /**
   * Optional provider hint — historically scoped the dropdown to one provider.
   * P12 changed behavior: the dropdown now fetches all providers in parallel
   * and groups them by header, so the hint is informational only (kept for
   * backward-compat with ChatPanel; ignored by the fetch).
   */
  providerHint?: 'anthropic' | 'openai' | 'google';
  disabled?: boolean;
  /**
   * When true, the picker renders as a read-only pill with a lock icon and
   * a tooltip explaining the chat-level model lock (PR-A Commit 5). Click is
   * a no-op. `disabled` is the bigger hammer (e.g. while saving) — `locked`
   * is the always-on UI affordance for "this chat's model can't change".
   */
  locked?: boolean;
  className?: string;
}

/**
 * Compact model-selection pill rendered in the chat header. Opens an overlay
 * popover with the allowlisted models for the user's active provider; next
 * message uses the chosen model. Issue #437.
 *
 * Styling mirrors `TokenGauge` so the two active-session pills line up.
 */
/**
 * Provider list the dropdown fetches in parallel. P12 — all three are runtime
 * active (Anthropic P1a, OpenAI P1a #553, Google Gemini P1c #552); the picker
 * shows every model across providers so users can switch lanes mid-chat.
 */
const ALL_PROVIDERS = ['anthropic', 'openai', 'google'] as const;

/** Human label shown above each group in the dropdown. */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

export function ModelPicker({
  value,
  onSelect,
  providerHint: _providerHint,
  disabled,
  locked,
  className,
}: ModelPickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<ModelOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // NOTE: `loading` is intentionally excluded from deps — including it would
    // cause a re-run (and cleanup) immediately after setLoading(true), which
    // sets `cancelled=true` on the in-flight fetch and permanently stalls the
    // dropdown on "loading…" (issue #465).
    //
    // P12: fetch all providers in parallel so the dropdown lists Anthropic +
    // OpenAI + Google together; a single provider's failure does not blank
    // the whole list (the catch swallows it and falls back to []).
    if (!open || options.length > 0) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all(
      ALL_PROVIDERS.map((p) =>
        workflowsApi
          .listSupportedModels(p)
          .catch(() => ({ provider: p, models: [] as ModelOption[] }))
      )
    )
      .then((results) => {
        if (cancelled) return;
        const merged = results.flatMap((r) => r.models ?? []);
        setOptions(merged);
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
  }, [open, options.length]);

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
  const lockTooltip =
    locked && value ? t('chat.model.locked').replace('{model}', shortModelLabel(value)) : undefined;

  // P12 — group options by provider so the dropdown body shows three sections
  // (Anthropic / OpenAI / Google) instead of a flat list. Order follows
  // ALL_PROVIDERS so the layout stays stable regardless of fetch order.
  const grouped = options.reduce<Record<string, ModelOption[]>>((acc, opt) => {
    (acc[opt.provider] ??= []).push(opt);
    return acc;
  }, {});
  const orderedGroups = ALL_PROVIDERS.map((prov) => [prov, grouped[prov] ?? []] as const).filter(
    ([, opts]) => opts.length > 0
  );

  return (
    <div ref={rootRef} className={cn('relative hidden sm:flex', className)}>
      <button
        type="button"
        aria-haspopup={locked ? undefined : 'listbox'}
        aria-expanded={locked ? undefined : open}
        aria-label={t('chat.model.ariaLabel')}
        disabled={disabled || saving || locked}
        title={lockTooltip}
        onClick={() => {
          if (locked) return;
          setOpen((prev) => !prev);
        }}
        className={cn(
          'flex items-center gap-1 rounded-lg border border-ak-border px-2.5 py-1 text-[11px] text-ak-text-secondary transition-colors',
          !locked && 'hover:border-ak-primary hover:text-ak-primary',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          locked && 'cursor-default opacity-70',
          open && 'border-ak-primary text-ak-primary'
        )}
      >
        {locked ? (
          <svg
            className="h-3 w-3"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 11c1.105 0 2 .895 2 2v3a2 2 0 11-4 0v-3c0-1.105.895-2 2-2zM7 11V8a5 5 0 1110 0v3M5 11h14a1 1 0 011 1v9a1 1 0 01-1 1H5a1 1 0 01-1-1v-9a1 1 0 011-1z"
            />
          </svg>
        ) : (
          <svg
            className="h-3 w-3"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        )}
        <span className="font-mono">{display}</span>
        {!locked && (
          <svg
            className={cn('h-3 w-3 transition-transform', open && 'rotate-180')}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={t('chat.model.ariaLabel')}
          // Dropdown viewport'a sığacak şekilde: butonun ÜSTÜNDE açılır
          // (chat input alt kenarda; üstte chat panel'in tamamı boş). Yine de
          // daha yüksek bir liste için max-h ve iç scroll var. Sticky group
          // header'lar scroll sırasında "şu an Anthropic'tesin / OpenAI'desin"
          // bilgisini görünür tutar.
          className="absolute right-0 bottom-full z-20 mb-1 w-max min-w-[260px] max-h-[60vh] overflow-y-auto rounded-lg border border-ak-border bg-ak-surface-2 p-1 shadow-lg"
        >
          {loading && (
            <div className="px-3 py-2 text-[11px] text-ak-text-tertiary">
              {t('chat.model.loading')}
            </div>
          )}
          {error && <div className="px-3 py-2 text-[11px] text-red-300">{error}</div>}
          {!loading && !error && options.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-ak-text-tertiary">
              {t('chat.model.empty')}
            </div>
          )}
          {!loading &&
            !error &&
            orderedGroups.map(([prov, opts]) => (
              <div key={prov} className="py-0.5">
                <div className="sticky top-0 z-10 bg-ak-surface-2 px-3 py-1 text-[10px] uppercase tracking-wider text-ak-text-tertiary">
                  {PROVIDER_LABELS[prov] ?? prov}
                </div>
                {opts.map((opt) => (
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
                      saving && 'opacity-50 cursor-not-allowed'
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
            ))}
        </div>
      )}
    </div>
  );
}
