import { useI18n } from '../../i18n/useI18n';

export interface PushConfirmGateProps {
  pipelineId: string;
  /** Number of files in the dryRun preview — for the badge. */
  fileCount: number;
  /** Whether the right Preview Panel is currently visible. */
  previewOpen: boolean;
  /** Open the right Preview Panel (used when previewOpen is false). */
  onOpenPreview: () => void;
}

/**
 * Compact push-confirm card (PDP-3 T2).
 *
 * Rendered inside PipelineDetailRail when the pipeline is in
 * `awaiting_push_confirm`. Lives in chat as a state announcement only:
 * the actual preview lives in the right PreviewPanel, the actions
 * (GitHub'a gönder / İptal et) live in PushGateFooter at the panel
 * bottom, and the "düzelt" loop happens via the chat input
 * (intent classifier → iterateWithFeedback).
 *
 * Bakkal-Türkçesi (NFR-5.1): user-facing copy never mentions "push",
 * "merge", "branch" or other Git jargon.
 */
export function PushConfirmGate({
  pipelineId: _pipelineId,
  fileCount,
  previewOpen,
  onOpenPreview,
}: PushConfirmGateProps) {
  const { t } = useI18n();

  return (
    <section
      data-testid="push-confirm-gate"
      aria-label={t('chat.pushGate.ariaLabel')}
      className="rounded-lg border border-ak-primary/30 bg-ak-primary/5 p-3"
    >
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-ak-text-primary">{t('chat.pushGate.title')}</h3>
        {fileCount > 0 && (
          <span className="text-xs text-ak-text-secondary">
            {`${fileCount} ${t('chat.pushGate.fileCountSuffix')}`}
          </span>
        )}
      </header>

      <p className="mb-2 text-xs leading-relaxed text-ak-text-secondary">
        {t('chat.pushGate.description')}
      </p>

      {/* PR-U2 #7: previously this button silently fired `onOpenPreview` and
          hid itself — the user had to look right to confirm something
          happened. Now we keep the button visible at all times with an
          `aria-pressed` state + arrow icon flipping direction (▷ when
          collapsed, ◁ when open) so the visual link to the preview panel
          is immediate. */}
      <button
        type="button"
        onClick={onOpenPreview}
        data-testid="push-confirm-gate-open-preview"
        aria-pressed={previewOpen}
        aria-label={
          previewOpen ? 'Önizleme paneli açık' : (t('chat.pushGate.openPreview') as string)
        }
        className={
          previewOpen
            ? 'inline-flex items-center gap-1.5 rounded-md border border-ak-primary bg-ak-primary/15 px-3 py-1.5 text-xs font-medium text-ak-primary'
            : 'inline-flex items-center gap-1.5 rounded-md border border-ak-primary/50 bg-ak-surface px-3 py-1.5 text-xs font-medium text-ak-primary hover:bg-ak-primary/10'
        }
      >
        <span aria-hidden="true">{previewOpen ? '◁' : '▷'}</span>
        {previewOpen ? 'Önizleme açık' : t('chat.pushGate.openPreview')}
      </button>
    </section>
  );
}

export default PushConfirmGate;
