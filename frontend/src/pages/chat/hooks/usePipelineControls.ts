/**
 * usePipelineControls — pipeline approval/control callbacks for ChatPage.
 *
 * Owns the five callbacks that drive the human-in-the-loop pipeline:
 *   - `handleApprove` (Spec onayı; spawns Proto)
 *   - `handleReject`  (reject the awaiting-approval gate)
 *   - `handleCancel`  (mid-pipeline cancel)
 *   - `handleRetry`   (re-run a failed stage)
 *   - `handleSkip`    (skip Trace)
 *
 * Plus the `retryingError` mini-state-machine: BUG-N — when the user clicks
 * "Yeniden dene", we want the error banner to stay visible until the new run
 * either succeeds (banner clears) or produces a new error (banner replaces).
 * The hook owns the captured error and the cleanup effect so ChatPage no
 * longer has to thread `setRetryingError` through.
 *
 * Returns a `pipelineError` derived value that the layout binds to the
 * banner: prefers the captured (pre-retry) error when retry is in flight,
 * else the workflow's current error when in `failed`. Same selector as
 * before; just relocated so retry-state stays cohesive.
 *
 * Extracted from ChatPage.tsx as part of F-06 Phase 2.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { workflowsApi } from '../../../services/api/workflows';
import { toast } from '../../../components/ui/Toast';
import type { PipelineError } from '../../../types/pipeline';
import type { Workflow } from '../../../types/workflow';

import { localizeError, sanitizeRepoName } from '../chatPageHelpers';

export interface UsePipelineControlsOptions {
  conversationId: string | undefined;
  activeWorkflow: Workflow | null;
  refreshWorkflow: () => Promise<unknown> | unknown;
}

export interface UsePipelineControlsResult {
  handleApprove: () => Promise<void>;
  handleReject: () => Promise<void>;
  handleCancel: () => Promise<void>;
  handleRetry: () => Promise<void>;
  handleSkip: () => Promise<void>;
  /** Banner-eligible error: captured pre-retry, else workflow `failed` error. */
  pipelineError: PipelineError | undefined;
  /** True while the captured pre-retry error is held. Wired to layout banner. */
  isRetrying: boolean;
}

export function usePipelineControls(
  options: UsePipelineControlsOptions
): UsePipelineControlsResult {
  const { conversationId, activeWorkflow, refreshWorkflow } = options;

  // BUG-N: capture pre-retry error so the banner stays visible during retry.
  const [retryingError, setRetryingError] = useState<PipelineError | null>(null);
  useEffect(() => {
    if (!retryingError) return;
    const stage = activeWorkflow?.currentStage;
    const nextError = activeWorkflow?.error;
    if (stage === 'completed' || stage === 'completed_partial') {
      setRetryingError(null);
      return;
    }
    if (stage === 'failed' && nextError) {
      setRetryingError(null);
    }
  }, [activeWorkflow?.currentStage, activeWorkflow?.error, retryingError]);

  // Approve uses an in-flight ref so a double-click can't double-submit.
  const approveRef = useRef(false);
  const handleApprove = useCallback(
    async (jiraConfig?: { projectKey: string }) => {
      if (!conversationId || !activeWorkflow || approveRef.current) return;
      approveRef.current = true;
      try {
        const cucumberEnabled = localStorage.getItem('akis_cucumber_enabled') === 'true';
        await workflowsApi.approve(
          conversationId,
          sanitizeRepoName(activeWorkflow.title ?? 'project'),
          'private',
          {
            cucumberEnabled,
            ...(jiraConfig ? { jiraConfig: { ...jiraConfig, enabled: true } } : {}),
          }
        );
        await refreshWorkflow();
        toast('Spec onaylandı, Proto başlatılıyor…', 'success');
      } catch (e) {
        toast(localizeError(e), 'error');
      } finally {
        approveRef.current = false;
      }
    },
    [conversationId, activeWorkflow, refreshWorkflow, approveRef]
  );

  const handleReject = useCallback(async () => {
    if (!conversationId) return;
    try {
      await workflowsApi.reject(conversationId);
      await refreshWorkflow();
      toast('Spec reddedildi.', 'info');
    } catch (e) {
      toast(localizeError(e), 'error');
    }
  }, [conversationId, refreshWorkflow]);

  const handleCancel = useCallback(async () => {
    if (!conversationId) return;
    try {
      await workflowsApi.cancel(conversationId);
      await refreshWorkflow();
      toast('Pipeline iptal edildi.', 'info');
    } catch (e) {
      toast(localizeError(e), 'error');
    }
  }, [conversationId, refreshWorkflow]);

  const handleRetry = useCallback(async () => {
    if (!conversationId) return;
    const currentError = activeWorkflow?.error;
    if (currentError) setRetryingError(currentError);
    try {
      await workflowsApi.retry(conversationId);
      await refreshWorkflow();
      toast('Yeniden deneniyor...', 'info');
    } catch (e) {
      setRetryingError(null);
      toast(localizeError(e), 'error');
    }
  }, [conversationId, activeWorkflow?.error, refreshWorkflow]);

  const handleSkip = useCallback(async () => {
    if (!conversationId) return;
    try {
      await workflowsApi.skipTrace(conversationId);
      await refreshWorkflow();
      toast('Trace atlandi.', 'info');
    } catch (e) {
      toast(localizeError(e), 'error');
    }
  }, [conversationId, refreshWorkflow]);

  const pipelineError =
    retryingError ??
    (activeWorkflow?.currentStage === 'failed' ? activeWorkflow?.error : undefined);

  return {
    handleApprove,
    handleReject,
    handleCancel,
    handleRetry,
    handleSkip,
    pipelineError,
    isRetrying: retryingError !== null,
  };
}
