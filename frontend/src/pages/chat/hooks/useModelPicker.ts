/**
 * useModelPicker — owns `pendingModel` + `handleModelChange` for ChatPage.
 *
 * Two phases exist here, mirrored from the original ChatPage logic:
 *   - Before a pipeline exists (no `conversationId` or it equals `'pending'`):
 *     `handleModelChange` no-ops on the network. The picker UI is wired to
 *     `setPendingModel` directly in this case (see ChatPageLayout) so the
 *     local state still updates — it's just consumed later when
 *     `useHandleSend` creates the workflow.
 *   - After the pipeline is created: `handleModelChange` calls
 *     `workflowsApi.updateModel` and refreshes the workflow snapshot. Local
 *     `pendingModel` is left untouched — the source of truth becomes
 *     `activeWorkflow.model` after this point.
 *
 * Extracted from ChatPage.tsx as part of F-06 Phase 2 — preserves the
 * "split callback" behavior the layout already depends on.
 */
import { useCallback, useState } from 'react';

import { workflowsApi } from '../../../services/api/workflows';
import { toast } from '../../../components/ui/Toast';
import type { Workflow } from '../../../types/workflow';

import { localizeError } from '../chatPageHelpers';

export interface UseModelPickerOptions {
  conversationId: string | undefined;
  /**
   * Current workflow snapshot. Not read by the hook today but accepted so
   * future "lock the picker once running" logic has somewhere to land.
   */
  activeWorkflow?: Workflow | null;
  refreshWorkflow: () => Promise<unknown> | unknown;
  /** Optional initial model. Defaults to the haiku alias used in ChatPage. */
  initialModel?: string;
}

export interface UseModelPickerResult {
  pendingModel: string;
  setPendingModel: (next: string) => void;
  handleModelChange: (modelId: string) => Promise<void>;
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export function useModelPicker(options: UseModelPickerOptions): UseModelPickerResult {
  const { conversationId, refreshWorkflow, initialModel = DEFAULT_MODEL } = options;
  const [pendingModel, setPendingModel] = useState<string>(initialModel);

  const handleModelChange = useCallback(
    async (modelId: string) => {
      // Pre-pipeline: pendingModel is updated directly via the layout's
      // `setPendingModel` wiring. Bail before any network work.
      if (!conversationId || conversationId === 'pending') return;
      try {
        await workflowsApi.updateModel(conversationId, modelId);
        await refreshWorkflow();
        toast(`Model güncellendi: ${modelId}`, 'info');
      } catch (e) {
        toast(localizeError(e), 'error');
      }
    },
    [conversationId, refreshWorkflow],
  );

  return { pendingModel, setPendingModel, handleModelChange };
}
