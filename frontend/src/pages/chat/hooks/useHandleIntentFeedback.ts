/**
 * useHandleIntentFeedback — state-aware FEEDBACK intent dispatcher.
 *
 * When the pipeline is at `awaiting_push_confirm`, a FEEDBACK message
 * means "iterate Proto with this correction" → POST to
 * `/api/pipelines/:id/iterate-with-feedback` via `workflowsApi`.
 *
 * Otherwise, fall back to the existing intent placeholder so we don't
 * silently swallow the user's input when there's no active gate.
 *
 * Spec: docs/superpowers/specs/2026-05-14-preview-unify-chat-iterate-design.md § T3
 */
import { useCallback } from 'react';

import { toast } from '../../../components/ui/Toast';
import { useI18n } from '../../../i18n/useI18n';
import { workflowsApi } from '../../../services/api/workflows';
import type { ChatMessage, ConversationUIState } from '../../../types/chat';

export interface UseHandleIntentFeedbackOptions {
  /** Current pipeline UI state (from `useConversationState`). */
  uiState: ConversationUIState;
  /** Active pipeline id; required to call the iterate endpoint. */
  pipelineId: string | undefined;
  /** Chat message setter — appends optimistic user + system echo. */
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  /**
   * Fallback used when we're NOT at the push-confirm gate; preserves
   * the existing "yakında" placeholder behaviour.
   */
  fallback: (label: string, message: string) => void;
}

/**
 * Returns a stable `handleIntentFeedback(message)` callback. The callback:
 *
 * 1. If state ≠ awaiting_push_confirm OR pipelineId missing → fallback.
 * 2. Else: appends a user message + a system echo immediately
 *    (optimistic), then fires `workflowsApi.iterateWithFeedback`.
 * 3. On API error: surfaces a toast (the user message stays so they can
 *    retry or copy-paste their request).
 */
export function useHandleIntentFeedback(options: UseHandleIntentFeedbackOptions) {
  const { uiState, pipelineId, setMessages, fallback } = options;
  const { t } = useI18n();

  return useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed) return;

      const isPushConfirm = uiState === 'awaiting_push_confirm';
      if (!isPushConfirm || !pipelineId) {
        fallback('Geribildirim', message);
        return;
      }

      const stamp = new Date().toISOString();
      // Optimistic echo: user bubble + system "Düzeltme gönderildi..."
      // appended immediately so the chat feels responsive while the
      // pipeline cycles back through proto_building.
      setMessages((prev) => [
        ...prev,
        { type: 'user', content: message, timestamp: stamp },
        {
          type: 'info',
          content: t('chat.feedback.optimisticEcho'),
          timestamp: stamp,
        },
      ]);

      try {
        await workflowsApi.iterateWithFeedback(pipelineId, message);
        // The conversation loader's polling picks up the new stage
        // (proto_building → … → awaiting_push_confirm) and re-renders
        // the gate with the refreshed protoFiles.
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Düzeltme gönderilemedi.';
        toast(msg, 'error');
      }
    },
    [uiState, pipelineId, setMessages, fallback, t]
  );
}
