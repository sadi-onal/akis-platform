import { useCallback, useEffect, useRef, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import { toast } from '../../../components/ui/Toast';
import type { ChatMessage } from '../../../types/chat';
import type { PipelineStage } from '../../../types/pipeline';
import type { Workflow } from '../../../types/workflow';
import { workflowsApi } from '../../../services/api/workflows';
import { conversationToChatMessages } from '../../../utils/conversationToChatMessages';

/**
 * Stages where the user is actively waiting for an AI reply — poll fast (5s).
 * Other running stages do heavy backend work, so 20s (SSE up) / 8s (SSE down)
 * is fine. Kept here (rather than in the parent ChatPage) so the polling cadence
 * lives next to the polling effect that consumes it.
 */
const INTERACTIVE_STAGES: PipelineStage[] = ['scribe_clarifying'];

function isInteractiveStage(stage?: PipelineStage): boolean {
  return !!stage && INTERACTIVE_STAGES.includes(stage);
}

export interface UseConversationLoaderOptions {
  /** Splat-derived id from `/chat/:id`; `undefined` while the user is on `/chat`. */
  conversationId: string | undefined;
  /** Whether the active workflow is in a running stage — gates the polling effect. */
  isRunning: boolean;
  /** Whether the SSE pipeline-event stream is healthy. Controls poll cadence. */
  isConnected: boolean;
  /** From `useConversationState` — keeps UI state in lockstep with the workflow stage. */
  syncFromStage: (stage: PipelineStage) => void;
  /** Sidebar updater — called whenever polling/loader fetches a new workflow snapshot. */
  onWorkflowSnapshot?: (workflow: Workflow) => void;
  /** Called when a fetch 404s and we redirect back to `/chat`. */
  navigate: NavigateFunction;
}

export interface UseConversationLoaderReturn {
  activeWorkflow: Workflow | null;
  setActiveWorkflow: React.Dispatch<React.SetStateAction<Workflow | null>>;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  /** Tracks the id we currently have data for; written by load + refresh. */
  loadedIdRef: React.MutableRefObject<string | undefined>;
  /**
   * `<id>:<convLen>:<lastTs>` cache key. Exposed so external callers (e.g.
   * handleNewConversation, handleBack, handleDelete) can reset it before they
   * navigate away — without that reset, re-entering the same chat would find
   * a matching key and skip the setMessages call (F-01 regression).
   */
  lastMessagesKeyRef: React.MutableRefObject<string>;
  /** Re-fetch the current workflow + sync messages/sidebar/uiState. */
  refreshWorkflow: () => Promise<void>;
}

/**
 * Owns the chat-page conversation loading + polling lifecycle. Extracted from
 * `ChatPage.tsx` as part of F-06 so each concern is independently testable.
 *
 * Responsibilities:
 * - Fetch the active workflow when `conversationId` changes (or clear on `/chat`).
 * - Stash a cache key so the same payload doesn't re-render the message list.
 * - Poll the active workflow on a Fibonacci-ish backoff while it's running.
 * - Surface a `refreshWorkflow()` callback that other handlers (send/approve/
 *   reject/retry/skip) can invoke after a mutation.
 */
export function useConversationLoader(
  options: UseConversationLoaderOptions,
): UseConversationLoaderReturn {
  const { conversationId, isRunning, isConnected, syncFromStage, onWorkflowSnapshot, navigate } =
    options;

  const [activeWorkflow, setActiveWorkflow] = useState<Workflow | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const loadedIdRef = useRef<string | undefined>(undefined);
  const lastMessagesKeyRef = useRef('');
  const prevConvLenRef = useRef(0);
  const activeStageRef = useRef<PipelineStage | undefined>(activeWorkflow?.currentStage);
  activeStageRef.current = activeWorkflow?.currentStage;
  // SSE provides real-time updates — polling is a fallback, so use longer interval
  const consecutiveErrorsRef = useRef(0);
  const backoffRef = useRef(8000);
  const connectionLostRef = useRef(false);

  // Stable callback refs so the polling effect doesn't tear down on every parent
  // render. `onWorkflowSnapshot` may be re-allocated by the parent on each render
  // (sidebar updater closure), and `syncFromStage` is already memoized inside
  // `useConversationState`, but going through a ref keeps both invariant here.
  const onWorkflowSnapshotRef = useRef(onWorkflowSnapshot);
  onWorkflowSnapshotRef.current = onWorkflowSnapshot;
  const syncFromStageRef = useRef(syncFromStage);
  syncFromStageRef.current = syncFromStage;

  // Load active conversation — keep old content visible until new data arrives
  useEffect(() => {
    if (!conversationId) {
      // Going to /chat (no id) — only clear if we had a conversation before
      if (loadedIdRef.current) {
        setActiveWorkflow(null);
        setMessages([]);
        loadedIdRef.current = undefined;
        // F-01: also reset the message-key cache so revisiting the same chat
        // re-runs setMessages instead of treating the unchanged key as a no-op.
        lastMessagesKeyRef.current = '';
      }
      return;
    }

    // Same chat — skip
    if (loadedIdRef.current === conversationId) return;

    // Mark immediately to prevent double-fetch on rapid navigation
    const targetId = conversationId;
    loadedIdRef.current = targetId;

    // Different chat — load without clearing (keeps old content visible during fetch)
    workflowsApi
      .get(targetId)
      .then((w) => {
        // Stale response guard: skip if user navigated away during fetch
        if (loadedIdRef.current !== targetId) return;
        setActiveWorkflow(w);
        const convLen = w.conversation?.length ?? 0;
        const lastTs = w.conversation?.[convLen - 1]?.timestamp ?? '';
        const key = `${targetId}:${convLen}:${lastTs}`;
        if (key !== lastMessagesKeyRef.current) {
          lastMessagesKeyRef.current = key;
          setMessages(conversationToChatMessages(w.conversation ?? [], w.currentStage));
        }
        syncFromStageRef.current(w.currentStage ?? 'completed');
      })
      .catch(() => {
        if (loadedIdRef.current !== targetId) return;
        // F-01: reset the message-key cache on the error redirect — without it
        // the next conversation load can hit a stale matching key and skip
        // setMessages, leaving the panel blank.
        lastMessagesKeyRef.current = '';
        navigate('/chat', { replace: true });
      });
    // syncFromStage + onWorkflowSnapshot accessed via refs above to keep the
    // load effect stable across parent re-renders.
  }, [conversationId, navigate]);

  // Polling for updates — only when agent is running
  const currentStageForPolling = activeWorkflow?.currentStage;
  useEffect(() => {
    if (!conversationId || !isRunning) return;
    // Interactive stages (scribe_clarifying): user is waiting for an AI reply — poll fast.
    // Non-interactive running stages: SSE up → 20s, SSE down → 8s + backoff on failures.
    const baseInterval = isInteractiveStage(currentStageForPolling)
      ? 5000
      : isConnected
        ? 20000
        : 8000;
    backoffRef.current = baseInterval;
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (controller.signal.aborted) return;
      try {
        const w = await workflowsApi.get(conversationId);
        if (controller.signal.aborted) return;

        // Success — reset error tracking
        consecutiveErrorsRef.current = 0;
        backoffRef.current = baseInterval;
        if (connectionLostRef.current) {
          connectionLostRef.current = false;
          toast('Bağlantı yeniden kuruldu.', 'success');
        }

        const convLen = w.conversation?.length ?? 0;
        const stageChanged = w.currentStage !== activeStageRef.current;
        if (convLen !== prevConvLenRef.current || stageChanged) {
          prevConvLenRef.current = convLen;
          setActiveWorkflow(w);
          // Keep sidebar list item in sync so status dot reflects failed/running state
          onWorkflowSnapshotRef.current?.(w);
          const lastTs = w.conversation?.[convLen - 1]?.timestamp ?? '';
          const key = `${conversationId}:${convLen}:${lastTs}`;
          if (key !== lastMessagesKeyRef.current) {
            lastMessagesKeyRef.current = key;
            setMessages(conversationToChatMessages(w.conversation ?? [], w.currentStage));
          }
          syncFromStageRef.current(w.currentStage ?? 'completed');
        }
      } catch {
        if (controller.signal.aborted) return;
        consecutiveErrorsRef.current += 1;
        backoffRef.current = Math.min(backoffRef.current * 2, 30000);
        if (consecutiveErrorsRef.current >= 5 && !connectionLostRef.current) {
          connectionLostRef.current = true;
          toast('Sunucuya bağlanılamıyor. Yeniden denenecek...', 'warning');
        }
      }

      if (!controller.signal.aborted) {
        timeoutId = setTimeout(poll, backoffRef.current);
      }
    };

    timeoutId = setTimeout(poll, backoffRef.current);
    return () => {
      controller.abort();
      clearTimeout(timeoutId);
    };
  }, [conversationId, isRunning, isConnected, currentStageForPolling]);

  const refreshWorkflow = useCallback(async () => {
    if (!conversationId) return;
    const w = await workflowsApi.get(conversationId);
    loadedIdRef.current = conversationId;
    setActiveWorkflow(w);
    const convLen = w.conversation?.length ?? 0;
    const lastTs = w.conversation?.[convLen - 1]?.timestamp ?? '';
    const key = `${conversationId}:${convLen}:${lastTs}`;
    if (key !== lastMessagesKeyRef.current) {
      lastMessagesKeyRef.current = key;
      setMessages(conversationToChatMessages(w.conversation ?? [], w.currentStage));
    }
    syncFromStageRef.current(w.currentStage ?? 'completed');
    onWorkflowSnapshotRef.current?.(w);
  }, [conversationId]);

  return {
    activeWorkflow,
    setActiveWorkflow,
    messages,
    setMessages,
    loadedIdRef,
    lastMessagesKeyRef,
    refreshWorkflow,
  };
}
