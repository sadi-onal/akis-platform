import { useI18n } from '../../i18n/useI18n';

export interface PushConfirmGateProps {
  pipelineId: string;
  /** Number of files in the dryRun preview — for the badge. */
  fileCount: number;
  /** Whether the right Preview Panel is currently visible. */
  previewOpen: boolean;
  /** Open the right Preview Panel (used when previewOpen is false). */
  onOpenPreview: () => void;
  /**
   * PR-U3 M3 — outcome of the Trace dryRun that preceded the gate. Drives
   * the 3-mode rendering:
   *   - 'success' (default): normal "Review the code" presentation
   *   - 'failed': amber warning banner — test üretimi başarısız, override
   *     gerekir; consumer (PushGateFooter) okur ve gönderim butonunu yalnız
   *     `onOverrideAck=true` durumunda enable eder
   *   - 'pending': spinner banner, gönderim butonu devre dışı
   */
  traceDryRunStatus?: 'success' | 'failed' | 'pending';
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
  traceDryRunStatus = 'success',
}: PushConfirmGateProps) {
  const { t } = useI18n();

  // PR-U3 M3: surface palette adapts to dryRun outcome so the user is
  // never tricked into thinking they're shipping tested code when Trace
  // actually failed.
  const palette =
    traceDryRunStatus === 'failed'
      ? {
          container: 'rounded-lg border border-amber-500/40 bg-amber-500/10 p-3',
          title: 'text-amber-900 dark:text-amber-100',
        }
      : traceDryRunStatus === 'pending'
        ? {
            container: 'rounded-lg border border-ak-border bg-ak-surface-2 p-3',
            title: 'text-ak-text-primary',
          }
        : {
            container: 'rounded-lg border border-ak-primary/30 bg-ak-primary/5 p-3',
            title: 'text-ak-text-primary',
          };

  return (
    <section
      data-testid="push-confirm-gate"
      aria-label={t('chat.pushGate.ariaLabel')}
      data-trace-dryrun-status={traceDryRunStatus}
      className={palette.container}
    >
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className={`text-sm font-semibold ${palette.title}`}>{t('chat.pushGate.title')}</h3>
        {fileCount > 0 && (
          <span className="text-xs text-ak-text-secondary">
            {`${fileCount} ${t('chat.pushGate.fileCountSuffix')}`}
          </span>
        )}
      </header>

      {/* PR-U3 M3: mode-specific banner above the standard description so
          the user always knows what state Trace is in before they push. */}
      {traceDryRunStatus === 'failed' && (
        <div
          role="alert"
          className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/15 px-2.5 py-1.5 text-xs leading-relaxed text-amber-900 dark:text-amber-100"
        >
          <strong>Test üretimi başarısız oldu.</strong> Kod hazır, ancak Trace ajanı testleri
          otomatik oluşturamadı. Gönderdiğiniz kodun testleri olmayacak — yine de devam etmek için
          aşağıdaki onayı verin.
        </div>
      )}
      {traceDryRunStatus === 'pending' && (
        <div
          role="status"
          aria-live="polite"
          className="mb-2 flex items-center gap-2 rounded-md border border-ak-border bg-ak-surface-2 px-2.5 py-1.5 text-xs text-ak-text-secondary"
        >
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-ak-primary border-t-transparent"
          />
          Testler hazırlanıyor… Tamamlanınca gönderim aktifleşecek.
        </div>
      )}

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
