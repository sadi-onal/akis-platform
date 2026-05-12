import { lazy, Suspense, useState } from 'react';
import { useI18n } from '../../i18n/useI18n';
import { workflowsApi } from '../../services/api/workflows';

// Lazy-load PreviewPanel — same chunking as ChatPageLayout. Keeps the rail's
// initial bundle slim for users who never hit `awaiting_push_confirm`.
const PreviewPanel = lazy(() =>
  import('../workflow/PreviewPanel').then((m) => ({ default: m.PreviewPanel }))
);

export interface PushConfirmGateProps {
  pipelineId: string;
  /**
   * The dryRun Proto output flattened into Sandpack's expected shape. When
   * null the gate still renders so the user sees the action buttons, but the
   * preview area shows a "files yükleniyor" placeholder. The parent (rail)
   * is responsible for fetching via `useProtoFiles` and passing the result.
   */
  files: Record<string, string> | null;
  /** Called after confirm/cancel completes so the chat polls fresh state. */
  onResolved?: () => void;
}

type BusyMode = 'confirm' | 'cancel' | 'iterate' | null;

const FEEDBACK_MIN_CHARS = 3;
const FEEDBACK_MAX_CHARS = 2000;

/**
 * PDP-3 B4 — Preview-confirm gate.
 *
 * Rendered inside PipelineDetailRail when the pipeline is in
 * `awaiting_push_confirm`. Surfaces the Sandpack preview of the generated
 * scaffold plus two explicit actions: push to GitHub or cancel. Cancellation
 * keeps the cached files on the pipeline so the user can still copy/inspect
 * them — but no GitHub commit happens.
 *
 * Bakkal-Türkçesi (NFR-5.1): user-facing copy never mentions "push", "merge",
 * "branch" or other Git jargon — only "GitHub'a gönder" / "İptal et".
 */
export function PushConfirmGate({ pipelineId, files, onResolved }: PushConfirmGateProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<BusyMode>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');

  const handleConfirm = async () => {
    if (busy) return;
    setBusy('confirm');
    setError(null);
    try {
      await workflowsApi.confirmPush(pipelineId);
      onResolved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('chat.pushGate.errorConfirm'));
      setBusy(null);
    }
  };

  const handleCancel = async () => {
    if (busy) return;
    setBusy('cancel');
    setError(null);
    try {
      await workflowsApi.cancelPush(pipelineId);
      onResolved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('chat.pushGate.errorCancel'));
      setBusy(null);
    }
  };

  const handleIterate = async () => {
    if (busy) return;
    const trimmed = feedback.trim();
    if (trimmed.length < FEEDBACK_MIN_CHARS) return;
    setBusy('iterate');
    setError(null);
    try {
      await workflowsApi.iterateWithFeedback(pipelineId, trimmed);
      // Clear textarea; pipeline transitions to proto_building. The parent
      // rail's `useProtoFiles` polling will pick up new files and re-render
      // this gate once the new dryRun lands.
      setFeedback('');
      onResolved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('chat.pushGate.errorIterate'));
      setBusy(null);
    }
  };

  const fileCount = files ? Object.keys(files).length : 0;

  return (
    <section
      data-testid="push-confirm-gate"
      aria-label={t('chat.pushGate.ariaLabel')}
      className="rounded-lg border border-ak-primary/30 bg-ak-primary/5 p-3"
    >
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-ak-text-primary">{t('chat.pushGate.title')}</h3>
        {fileCount > 0 && (
          <span className="text-xs text-ak-text-secondary">
            {`${fileCount} ${t('chat.pushGate.fileCountSuffix')}`}
          </span>
        )}
      </header>

      <p className="mb-3 text-xs leading-relaxed text-ak-text-secondary">
        {t('chat.pushGate.description')}
      </p>

      <div className="mb-3 h-72 overflow-hidden rounded-md border border-ak-border">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-xs text-ak-text-tertiary">
              {t('chat.pushGate.previewLoading')}
            </div>
          }
        >
          {files && Object.keys(files).length > 0 ? (
            <PreviewPanel files={files} />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-ak-text-tertiary">
              {t('chat.pushGate.previewLoading')}
            </div>
          )}
        </Suspense>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-200"
        >
          {error}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleConfirm}
          disabled={busy !== null}
          data-testid="push-confirm-gate-confirm"
          className="rounded-md bg-ak-primary px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-ak-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'confirm' ? t('chat.pushGate.confirming') : t('chat.pushGate.confirm')}
        </button>
        <button
          type="button"
          onClick={handleCancel}
          disabled={busy !== null}
          data-testid="push-confirm-gate-cancel"
          className="rounded-md border border-ak-border bg-ak-surface px-3 py-1.5 text-xs font-medium text-ak-text-primary hover:bg-ak-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'cancel' ? t('chat.pushGate.cancelling') : t('chat.pushGate.cancel')}
        </button>
      </div>

      {/*
        B5 — feedback-driven Proto re-iteration. The user types what they
        want changed; the orchestrator re-runs Proto in dryRun mode with
        the feedback injected into the prompt. New `protoOutput.files`
        replace the current ones; the rail's polling refreshes the preview.
      */}
      <div className="mt-4 border-t border-ak-border pt-3">
        <label
          htmlFor="push-gate-feedback"
          className="mb-1 block text-xs font-medium text-ak-text-primary"
        >
          {t('chat.pushGate.feedback.title')}
        </label>
        <p className="mb-2 text-[11px] leading-relaxed text-ak-text-tertiary">
          {t('chat.pushGate.feedback.hint')}
        </p>
        <textarea
          id="push-gate-feedback"
          data-testid="push-confirm-gate-feedback-input"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value.slice(0, FEEDBACK_MAX_CHARS))}
          disabled={busy !== null}
          placeholder={t('chat.pushGate.feedback.placeholder')}
          rows={3}
          className="mb-2 w-full resize-y rounded-md border border-ak-border bg-ak-surface px-2.5 py-1.5 text-xs text-ak-text-primary placeholder:text-ak-text-tertiary focus:border-ak-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleIterate}
          disabled={busy !== null || feedback.trim().length < FEEDBACK_MIN_CHARS}
          data-testid="push-confirm-gate-iterate"
          className="rounded-md border border-ak-primary/50 bg-ak-surface px-3 py-1.5 text-xs font-medium text-ak-primary hover:bg-ak-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'iterate'
            ? t('chat.pushGate.feedback.iterating')
            : t('chat.pushGate.feedback.submit')}
        </button>
      </div>
    </section>
  );
}

export default PushConfirmGate;
