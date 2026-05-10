import { useCallback, useEffect, useRef } from 'react';

import type { ChatMessage } from '../../../types/chat';
import { workflowsApi } from '../../../services/api/workflows';

const POLL_MAX_DURATION_MS = 15 * 60 * 1000; // 15 min
const POLL_MAX_INTERVAL_MS = 30_000;

/**
 * Fibonacci-ish backoff: 2s, ~3s, ~5s, ~8s, ~13s, ~21s … capped at 30s.
 * Smoother ramp than 2^n while still trending up fast enough that long Trace
 * runs don't get hammered with requests every two seconds.
 */
function fibStep(n: number): number {
  if (n < 2) return 2_000;
  return Math.min(Math.round(2000 * Math.pow(1.6, n - 1)), POLL_MAX_INTERVAL_MS);
}

export interface UseIterationChildPollOptions {
  /** Re-fetch the root workflow so iteration progress shows up on the timeline. */
  refreshWorkflow: () => Promise<void>;
  /** Refresh the sidebar (mirror status/file count of the child). */
  refreshList: () => void;
  /** Append the completion / failure info message when the child terminates. */
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

export interface UseIterationChildPollReturn {
  /**
   * Start polling the child pipeline with `id`. Subsequent calls cancel the
   * previous in-flight poll and start fresh — only one iteration tracker can
   * be in-flight at a time per ChatPage instance.
   */
  startPolling: (childId: string) => void;
}

/**
 * Tracks an in-flight iteration child pipeline so we can poll for completion
 * without a new SSE subscription (issue #388 / BUG-08). Extracted from
 * `ChatPage.handleSend` as part of F-06 — `handleSend` itself is still
 * monolithic but the long-running poll machinery now lives next to the rest
 * of the conversation loader concerns.
 *
 * Lifecycle:
 * - Caller invokes `startPolling(childId)` immediately after creating the
 *   child via `workflowsApi.create({ parentPipelineId, skipScribe: true })`.
 * - Hook polls `workflowsApi.get(childId)` on a Fibonacci backoff.
 * - On every tick we also call `refreshWorkflow()` so the root workflow shown
 *   in the chat panel mirrors the child's state.
 * - On terminal stage (completed / completed_partial / failed / cancelled),
 *   we append a single info message and clear the tracker.
 * - On unmount the tracker ref is cleared — any in-flight `setTimeout` bails
 *   out on its next tick when it sees `pollChildRef.current === null`.
 */
export function useIterationChildPoll(
  options: UseIterationChildPollOptions,
): UseIterationChildPollReturn {
  const { refreshWorkflow, refreshList, setMessages } = options;

  const pollChildRef = useRef<{ childId: string; ticks: number } | null>(null);

  // Stable refs — callers re-allocate these on every render (closures over
  // conversationId / setMessages), so we route through refs to keep the
  // startPolling callback itself stable.
  const refreshWorkflowRef = useRef(refreshWorkflow);
  refreshWorkflowRef.current = refreshWorkflow;
  const refreshListRef = useRef(refreshList);
  refreshListRef.current = refreshList;
  const setMessagesRef = useRef(setMessages);
  setMessagesRef.current = setMessages;

  // Clear the tracker on unmount. The poll loop observes pollChildRef.current
  // === null to bail out, so this is enough — no AbortController needed.
  useEffect(() => {
    return () => {
      pollChildRef.current = null;
    };
  }, []);

  const startPolling = useCallback((childId: string) => {
    pollChildRef.current = { childId, ticks: 0 };
    const startedAt = Date.now();

    const pollIterationChild = async () => {
      if (!pollChildRef.current || pollChildRef.current.childId !== childId) return;
      pollChildRef.current.ticks += 1;
      try {
        const w = await workflowsApi.get(childId);
        await refreshWorkflowRef.current();
        const childStage = w.currentStage;
        const terminal =
          childStage === 'completed' ||
          childStage === 'completed_partial' ||
          childStage === 'failed' ||
          childStage === 'cancelled';
        if (terminal) {
          pollChildRef.current = null;
          refreshListRef.current();
          // BUG-18: push a completion info message so the chat timeline doesn't
          // stay stuck on "İterasyon başlatıldı…" forever after child finishes.
          const protoStage = (
            w.stages as
              | { proto?: { files?: unknown[]; filesCreated?: number; branch?: string } }
              | undefined
          )?.proto;
          const fileCount = protoStage?.filesCreated ?? protoStage?.files?.length;
          const branchName = protoStage?.branch;
          const summary =
            childStage === 'completed' || childStage === 'completed_partial'
              ? fileCount
                ? `Değişiklikler uygulandı — ${fileCount} dosya güncellendi${branchName ? ` (${branchName})` : ''}. Önizleme yenileyerek sonucu görebilirsiniz.`
                : 'İterasyon tamamlandı. Önizleme yenileyerek sonucu görebilirsiniz.'
              : childStage === 'failed'
                ? 'İterasyon başarısız oldu. Tekrar deneyebilirsiniz.'
                : 'İterasyon iptal edildi.';
          setMessagesRef.current((prev) => [
            ...prev,
            {
              type: 'info',
              content: summary,
              timestamp: new Date().toISOString(),
            },
          ]);
          return;
        }
      } catch {
        // Transient network/auth glitch — fall through to schedule next tick.
      }
      const elapsed = Date.now() - startedAt;
      if (!pollChildRef.current || elapsed >= POLL_MAX_DURATION_MS) {
        pollChildRef.current = null;
        return;
      }
      setTimeout(pollIterationChild, fibStep(pollChildRef.current.ticks));
    };

    setTimeout(pollIterationChild, 2000);
  }, []);

  return { startPolling };
}
