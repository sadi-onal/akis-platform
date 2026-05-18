import { useState } from 'react';

import { useI18n } from '../../i18n/useI18n';
import { workflowsApi } from '../../services/api/workflows';
import type { CriticReviewOutput } from '../../types/pipeline';
import { CriticScoreBar } from './CriticScoreBar';

export interface CriticResolutionGateProps {
  pipelineId: string;
  /** Latest CriticReviewOutput from the code-review pass. */
  criticReview: CriticReviewOutput;
  /** Threshold from backend (env-driven). Defaults to 75. */
  approvalThreshold?: number;
  /**
   * Invoked after a successful override so the parent can refresh the
   * pipeline state (mirrors PushConfirmGate's onPushResolved).
   */
  onResolved?: () => void;
  className?: string;
}

const DEFAULT_THRESHOLD = 75;

/**
 * P8 — Critic hard-block resolution gate. Rendered inside
 * PipelineDetailRail when the pipeline is at `awaiting_critic_resolution`.
 *
 * Surfaces:
 *   - CriticScoreBar (visual score vs. threshold)
 *   - One-line summary of what the Critic flagged
 *   - "Yine de devam et" button — POSTs `/critic-override` and advances
 *     to `awaiting_push_confirm`.
 *
 * The "Düzelt" path lives in the chat input (FEEDBACK intent routes to
 * `useHandleIntentFeedback` which calls `workflowsApi.iterateWithFeedback`),
 * so no second button is needed here — the chat-driven loop matches the
 * existing push-confirm UX.
 *
 * Bakkal-Türkçesi: no "block", "merge", "PR" leakage in user copy.
 */
export function CriticResolutionGate({
  pipelineId,
  criticReview,
  approvalThreshold = DEFAULT_THRESHOLD,
  onResolved,
  className,
}: CriticResolutionGateProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const score = criticReview.overallScore ?? 0;
  const findingsCount = criticReview.findings?.length ?? 0;

  const handleOverride = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await workflowsApi.criticOverride(pipelineId);
      onResolved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('chat.critic.resolution.errorOverride'));
      setBusy(false);
    }
  };

  const description = t('chat.critic.resolution.description')
    .replace('{score}', String(score))
    .replace('{findingsCount}', String(findingsCount));

  return (
    <section
      data-testid="critic-resolution-gate"
      aria-label={t('chat.critic.resolution.title')}
      className={`rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 ${className ?? ''}`}
    >
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-ak-text-primary">
          {t('chat.critic.resolution.title')}
        </h3>
      </header>

      <div className="mb-2">
        <CriticScoreBar
          score={score}
          threshold={approvalThreshold}
          findingsCount={findingsCount}
          compact
        />
      </div>

      <p className="mb-3 text-xs leading-relaxed text-ak-text-secondary">{description}</p>

      {error && (
        <div
          role="alert"
          data-testid="critic-resolution-gate-error"
          className="mb-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-200"
        >
          {error}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleOverride}
          disabled={busy}
          data-testid="critic-resolution-gate-override"
          className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:text-rose-200"
        >
          {busy
            ? t('chat.critic.resolution.overriding')
            : t('chat.critic.resolution.override')}
        </button>
      </div>
    </section>
  );
}

export default CriticResolutionGate;
