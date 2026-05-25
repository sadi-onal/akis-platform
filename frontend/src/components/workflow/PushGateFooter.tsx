import { useState } from 'react';

import { useI18n } from '../../i18n/useI18n';
import { workflowsApi } from '../../services/api/workflows';
import { cn } from '../../utils/cn';
import { isStageConflictError } from '../../utils/errorMessages';

type BusyMode = 'confirm' | 'cancel' | null;

export interface PushGateFooterProps {
  pipelineId: string;
  onResolved?: (action: 'confirm' | 'cancel') => void;
  className?: string;
}

/**
 * Sticky footer rendered at the bottom of {@link PreviewPanel} when the
 * pipeline is at `awaiting_push_confirm`. Surfaces the two terminal actions
 * that used to live inside the chat-side `PushConfirmGate` card.
 *
 * Bakkal-Türkçesi (NFR-5.1): never use "push" / "branch" / "merge" in
 * user-facing strings — only "GitHub'a gönder" / "İptal et".
 *
 * Spec: docs/superpowers/specs/2026-05-14-preview-unify-chat-iterate-design.md § T1
 */
export function PushGateFooter({ pipelineId, onResolved, className }: PushGateFooterProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<BusyMode>(null);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    if (busy) return;
    setBusy('confirm');
    setError(null);
    try {
      await workflowsApi.confirmPush(pipelineId);
      onResolved?.('confirm');
    } catch (e) {
      // #637: stage already changed — show friendly message + auto-refresh
      if (isStageConflictError(e)) {
        setError(t('chat.stageConflict'));
        setBusy(null);
        onResolved?.('confirm');
        return;
      }
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
      onResolved?.('cancel');
    } catch (e) {
      // #637: stage already changed — show friendly message + auto-refresh
      if (isStageConflictError(e)) {
        setError(t('chat.stageConflict'));
        setBusy(null);
        onResolved?.('cancel');
        return;
      }
      setError(e instanceof Error ? e.message : t('chat.pushGate.errorCancel'));
      setBusy(null);
    }
  };

  return (
    <footer
      data-testid="push-gate-footer"
      className={cn(
        'sticky bottom-0 z-10 border-t border-ak-border bg-ak-surface/95 px-4 py-3 backdrop-blur',
        className,
      )}
    >
      {error && (
        <div
          role="alert"
          data-testid="push-gate-footer-error"
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
          data-testid="push-gate-footer-confirm"
          className="rounded-md bg-ak-primary px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-ak-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'confirm' ? t('chat.pushGate.confirming') : t('chat.pushGate.confirm')}
        </button>
        <button
          type="button"
          onClick={handleCancel}
          disabled={busy !== null}
          data-testid="push-gate-footer-cancel"
          className="rounded-md border border-ak-border bg-ak-surface px-3 py-1.5 text-xs font-medium text-ak-text-primary hover:bg-ak-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'cancel' ? t('chat.pushGate.cancelling') : t('chat.pushGate.cancel')}
        </button>
      </div>
    </footer>
  );
}

export default PushGateFooter;
