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
  /**
   * Current pipeline UI state — used to bias the classify-error fallback.
   * At `awaiting_push_confirm` (and P8's `awaiting_critic_resolution`),
   * a classifier hiccup should route to FEEDBACK (iterate the existing
   * scaffold) rather than BUILD (which would restart the entire pipeline
   * and toss the user's work-in-progress preview).
   * Spec: docs/superpowers/specs/2026-05-14-preview-unify-chat-iterate-design.md § T3
   *
   * @deprecated PR-U2 #14: ChatRouter no longer reads pipeline state — the
   * caller computes the desired fallback intent and passes it via
   * `defaultFallbackIntent`. Kept here only to preserve the existing call
   * site signature; remove on next breaking refactor.
   */
  pipelineUiState?: string;
  /**
   * PR-U2 #14: explicit fallback intent for the network-failure path.
   * Defaults to `'BUILD'`. Parent decides ("user is on the push gate →
   * FEEDBACK") rather than ChatRouter inferring from pipeline state.
   * This keeps the intent classifier purely semantic and removes the
   * coupling the audit flagged.
   */
  defaultFallbackIntent?: 'BUILD' | 'FEEDBACK' | 'ASK' | 'CHAT';
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
  children: (renderProps: {
    send: (message: string, attachments?: ChatAttachment[]) => Promise<void>;
    busy: boolean;
  }) => React.ReactNode;
}

interface PendingDecision {
  message: string;
  attachments?: ChatAttachment[];
  classification: IntentClassification;
}

export function ChatRouter({
  pipelineId,
  pipelineUiState,
  defaultFallbackIntent,
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

  // PR-U2 #14: fallback intent resolved at call time. Preferred path is
  // `defaultFallbackIntent` (parent decides); legacy `pipelineUiState`
  // kept as a soft fallback so existing call sites don't break before
  // they migrate. New callers should ignore pipelineUiState entirely.
  const fallbackRef = useRef<{ explicit?: IntentLabel; legacyState?: string }>({});
  fallbackRef.current = { explicit: defaultFallbackIntent, legacyState: pipelineUiState };

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
    []
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
          // Network or auth failure — fallback resolution:
          //  1. If parent passed `defaultFallbackIntent`, use it (PR-U2 #14
          //     — explicit injection, ChatRouter stays state-agnostic).
          //  2. Else, legacy `pipelineUiState` heuristic: gate-active →
          //     FEEDBACK (iterate scaffold), else BUILD. Kept so callers
          //     that haven't migrated still get the safer behavior.
          if (fallbackRef.current.explicit) {
            await dispatch(fallbackRef.current.explicit, message, attachments);
            return;
          }
          const gateActive =
            fallbackRef.current.legacyState === 'awaiting_push_confirm' ||
            fallbackRef.current.legacyState === 'awaiting_critic_resolution';
          const fallback: IntentLabel = gateActive ? 'FEEDBACK' : 'BUILD';
          await dispatch(fallback, message, attachments);
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
    [dispatch, pipelineId, recentMessages]
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
    [dispatch, pending]
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
