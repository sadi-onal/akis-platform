import { useCallback, useRef, useState } from 'react';
import {
  chatIntentApi,
  type IntentClassification,
  type IntentLabel,
} from '../../services/api/chatIntent';
import type { ChatAttachment } from './ChatInput';
import { DisambiguationModal } from './DisambiguationModal';

/**
 * ChatRouter — frontend dispatcher for FR-11 intent detection.
 *
 * Wraps the existing chat-send path. On every send:
 *   1. POST /api/chat/intent → classification + confidence + classificationId
 *   2. If confidence ≥ threshold → call the matching handler
 *   3. Else → open <DisambiguationModal/>; user's pick is PATCH'd as override
 *      then the matching handler is invoked.
 *
 * The handlers are exposed as props so the host page can wire each class to
 * its real implementation. Today only `onBuild` has a real implementation
 * (the existing handleSend create/iteration path); the other three are stubs
 * controlled by the host. See `ChatRouter.askFallback` decision in the PR.
 *
 * Anchors:
 *   - 03-architecture § 3.4 (frontend ChatRouter)
 *   - 02-ux § 3 intent state machine + § 5.9 modal
 *   - 06-roadmap Wave 4 PR 4.1
 */

export interface ChatRouterProps {
  pipelineId?: string;
  /** Last N messages from the chat scrollback (oldest → newest), max 20. */
  recentMessages?: string[];
  /**
   * Existing BUILD-path send. Receives the same `(content, attachments)`
   * tuple the legacy `handleSend` consumed.
   */
  onBuild: (message: string, attachments?: ChatAttachment[]) => void | Promise<void>;
  /** ASK handler. F-09 (chat-qa) target. Stub falls back to a toast in ChatPage. */
  onAsk: (message: string) => void | Promise<void>;
  /** FEEDBACK handler. Logs + offers the "düzeltelim mi?" follow-up. */
  onFeedback: (message: string) => void | Promise<void>;
  /** CHAT handler. Simple conversational reply (stub for now). */
  onChat: (message: string) => void | Promise<void>;
  /**
   * Optional override of the network calls — used by tests to stub
   * classify/override without spinning up MSW. Defaults to `chatIntentApi`.
   */
  api?: {
    classify: typeof chatIntentApi.classify;
    override: typeof chatIntentApi.override;
  };
  /**
   * Render function that hands back `{ send }`. The host attaches `send` to
   * the ChatInput's onSend prop. This keeps ChatRouter headless — it doesn't
   * own the input UI itself, only the routing decision.
   */
  children: (renderProps: { send: (message: string, attachments?: ChatAttachment[]) => Promise<void>; busy: boolean }) => React.ReactNode;
}

interface PendingDecision {
  message: string;
  attachments?: ChatAttachment[];
  classification: IntentClassification;
}

export function ChatRouter({
  pipelineId,
  recentMessages,
  onBuild,
  onAsk,
  onFeedback,
  onChat,
  api,
  children,
}: ChatRouterProps) {
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [busy, setBusy] = useState(false);
  // Latest props in a ref so the dispatch callback isn't stale during async.
  const handlersRef = useRef({ onBuild, onAsk, onFeedback, onChat });
  handlersRef.current = { onBuild, onAsk, onFeedback, onChat };

  const apiRef = useRef(api ?? chatIntentApi);
  apiRef.current = api ?? chatIntentApi;

  const dispatch = useCallback(
    async (intent: IntentLabel, message: string, attachments?: ChatAttachment[]) => {
      const h = handlersRef.current;
      switch (intent) {
        case 'BUILD':
          await h.onBuild(message, attachments);
          break;
        case 'ASK':
          await h.onAsk(message);
          break;
        case 'FEEDBACK':
          await h.onFeedback(message);
          break;
        case 'CHAT':
          await h.onChat(message);
          break;
      }
    },
    [],
  );

  const send = useCallback(
    async (message: string, attachments?: ChatAttachment[]) => {
      const trimmed = message.trim();
      if (!trimmed) return;
      setBusy(true);
      try {
        let classification: IntentClassification;
        try {
          classification = await apiRef.current.classify({
            message: trimmed,
            pipelineId,
            recentMessages,
          });
        } catch {
          // Network or auth failure — fall back to BUILD so the user is never
          // blocked from the primary action by a classifier hiccup.
          await dispatch('BUILD', message, attachments);
          return;
        }

        if (classification.confidence >= classification.threshold) {
          await dispatch(classification.intent, message, attachments);
          return;
        }

        // Confidence too low — defer to the disambiguation modal.
        setPending({ message, attachments, classification });
      } finally {
        setBusy(false);
      }
    },
    [dispatch, pipelineId, recentMessages],
  );

  const handleModalSelect = useCallback(
    async (intent: IntentLabel) => {
      if (!pending) return;
      const { message, attachments, classification } = pending;
      setBusy(true);
      try {
        if (classification.classificationId) {
          // Best-effort override; never block the user on telemetry failure.
          apiRef.current.override(classification.classificationId, intent).catch(() => {
            /* swallow */
          });
        }
        setPending(null);
        await dispatch(intent, message, attachments);
      } finally {
        setBusy(false);
      }
    },
    [dispatch, pending],
  );

  const handleModalCancel = useCallback(() => {
    setPending(null);
  }, []);

  return (
    <>
      {children({ send, busy })}
      {pending && (
        <DisambiguationModal
          message={pending.message}
          onSelect={handleModalSelect}
          onCancel={handleModalCancel}
          busy={busy}
        />
      )}
    </>
  );
}
