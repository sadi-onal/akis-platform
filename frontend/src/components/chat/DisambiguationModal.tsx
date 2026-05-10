import { useEffect, useRef } from 'react';
import type { IntentLabel } from '../../services/api/chatIntent';

/**
 * Intent disambiguation modal (FR-11.3 / 02-ux § 5.9).
 *
 * Shown when the IntentClassifier returns confidence < threshold (default
 * 0.7). Three primary choices map to the three real handlers — BUILD, ASK,
 * FEEDBACK — plus a Vazgeç (cancel) escape. The CHAT intent is intentionally
 * NOT offered here: ambiguous one-word prompts shouldn't fall into smalltalk;
 * that's the catch-all for explicit greetings.
 *
 * Bakkal-language (NFR-5.1):
 *   - "Yeni özellik" rather than BUILD
 *   - "Soru" rather than ASK
 *   - "Geribildirim" rather than FEEDBACK
 *   - "Vazgeç" rather than Cancel
 */

export interface DisambiguationOption {
  intent: IntentLabel;
  label: string;
  description: string;
  icon: string;
}

const DEFAULT_OPTIONS: ReadonlyArray<DisambiguationOption> = [
  {
    intent: 'BUILD',
    label: 'Yeni özellik',
    description: 'Bunu projene ekleyeyim',
    icon: '✏',
  },
  {
    intent: 'ASK',
    label: 'Soru',
    description: 'Bana açıkla / öğret',
    icon: '❓',
  },
  {
    intent: 'FEEDBACK',
    label: 'Geribildirim',
    description: 'Mevcut çıktıda bir sorun var',
    icon: '💬',
  },
];

export interface DisambiguationModalProps {
  /** The user's original message — quoted at the top of the modal. */
  message: string;
  /** Triggered when the user picks one of the four classes. */
  onSelect: (intent: IntentLabel) => void;
  /** Triggered on Vazgeç button or Esc / backdrop click. */
  onCancel: () => void;
  /** Disable buttons while parent is finishing the classify-then-dispatch. */
  busy?: boolean;
  /**
   * Optional override of the three primary buttons. Useful for tests; defaults
   * to {@link DEFAULT_DISAMBIGUATION_OPTIONS}.
   */
  options?: ReadonlyArray<DisambiguationOption>;
}

export function DisambiguationModal({
  message,
  onSelect,
  onCancel,
  busy,
  options = DEFAULT_OPTIONS,
}: DisambiguationModalProps) {
  const firstButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // Focus the first option when the modal opens (a11y: keyboard users
    // shouldn't have to tab into the dialog).
    firstButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!busy) onCancel();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

  // Quote the user's message but truncate it if huge — keeps the modal short.
  const quoted = message.length > 120 ? `${message.slice(0, 117)}…` : message;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Niyetini netleştir"
      data-testid="intent-disambiguation-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ak-bg/95 backdrop-blur-sm"
      onClick={(e) => {
        // Click on the backdrop (not on the inner card) cancels
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="relative w-full max-w-md rounded-2xl border border-ak-border bg-ak-surface p-5 shadow-2xl">
        <h2 className="mb-2 text-base font-semibold text-ak-text-primary">
          Bunu nasıl yapayım?
        </h2>
        <p className="mb-4 text-sm text-ak-text-secondary">
          <span className="italic">“{quoted}”</span> — birden fazla anlama gelebilir.
        </p>

        <div className="mb-4 flex flex-col gap-2">
          {options.map((opt, idx) => (
            <button
              key={opt.intent}
              ref={idx === 0 ? firstButtonRef : undefined}
              type="button"
              onClick={() => onSelect(opt.intent)}
              disabled={busy}
              data-testid={`intent-option-${opt.intent}`}
              className="flex w-full items-start gap-3 rounded-xl border border-ak-border bg-ak-surface px-4 py-3 text-left transition hover:border-ak-accent hover:bg-ak-surface-hover focus:border-ak-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span aria-hidden="true" className="mt-0.5 text-base">
                {opt.icon}
              </span>
              <span className="flex flex-col">
                <span className="text-sm font-medium text-ak-text-primary">
                  {opt.label}
                </span>
                <span className="text-xs text-ak-text-secondary">
                  {opt.description}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            data-testid="intent-option-cancel"
            className="rounded-lg px-3 py-1.5 text-sm text-ak-text-secondary transition hover:text-ak-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            Vazgeç
          </button>
        </div>
      </div>
    </div>
  );
}
