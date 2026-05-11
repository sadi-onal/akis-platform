/**
 * useChatQaAsk — the F-09 / FR-10 ASK intent streaming handler, extracted
 * from ChatPage.tsx as part of F-06. Pipeline-free RAG answer: inserts a
 * `user` bubble + a streaming `chat_qa_response`, then walks the SSE stream
 * appending chunks, accumulating citations, and surfacing the optional
 * [BUILD] CTA on the `done` event.
 *
 * Aborts are wired so navigating away or re-asking cancels the previous
 * stream — keeps the AI provider from double-billing the user.
 */
import { useCallback, useEffect, useRef } from 'react';

import { chatQaApi, type ChatHistoryEntry, type QACitation } from '../../../services/api/chatQa';
import { toast } from '../../../components/ui/Toast';
import type { ChatMessage } from '../../../types/chat';

import { localizeError } from '../chatPageHelpers';

export interface UseChatQaAskOptions {
  conversationId: string | undefined;
  /** Latest messages reference — used to build the history payload. */
  messagesRef: React.MutableRefObject<ChatMessage[]>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

export function useChatQaAsk(options: UseChatQaAskOptions) {
  const { conversationId, messagesRef, setMessages } = options;

  // One AbortController per in-flight chat-qa request. Aborting on (a)
  // unmount, (b) a new send arriving while the previous one is still
  // streaming.
  const askAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      askAbortRef.current?.abort();
      askAbortRef.current = null;
    };
  }, []);

  return useCallback(
    async (message: string) => {
      const stamp = new Date().toISOString();
      const history: ChatHistoryEntry[] = messagesRef.current
        .filter((m) => m.type === 'user' || m.type === 'agent' || m.type === 'chat_qa_response')
        .slice(-10)
        .map((m): ChatHistoryEntry => {
          if (m.type === 'user') return { role: 'user', content: m.content };
          if (m.type === 'chat_qa_response') return { role: 'assistant', content: m.content };
          return { role: 'assistant', content: (m as { content: string }).content };
        });

      askAbortRef.current?.abort();
      const controller = new AbortController();
      askAbortRef.current = controller;

      setMessages((prev) => [
        ...prev,
        { type: 'user', content: message, timestamp: stamp },
        {
          type: 'chat_qa_response',
          content: '',
          streaming: true,
          sourceMessage: message,
          timestamp: stamp,
        },
      ]);

      const updateLast = (
        patch: (
          prev: Extract<ChatMessage, { type: 'chat_qa_response' }>,
        ) => Extract<ChatMessage, { type: 'chat_qa_response' }>,
      ) => {
        setMessages((prev) => {
          const next = prev.slice();
          for (let i = next.length - 1; i >= 0; i -= 1) {
            const m = next[i];
            if (m.type === 'chat_qa_response') {
              next[i] = patch(m);
              return next;
            }
          }
          return prev;
        });
      };

      const collectedCitations: QACitation[] = [];
      try {
        for await (const ev of chatQaApi.ask({
          message,
          pipelineId: conversationId ?? undefined,
          history,
          signal: controller.signal,
        })) {
          if (ev.type === 'chunk') {
            updateLast((m) => ({ ...m, content: m.content + ev.text }));
          } else if (ev.type === 'citation') {
            collectedCitations.push(ev.citation);
            updateLast((m) => ({ ...m, citations: [...(m.citations ?? []), ev.citation] }));
          } else if (ev.type === 'done') {
            updateLast((m) => ({
              ...m,
              streaming: false,
              content: ev.answer || m.content,
              citations: ev.citations.length ? ev.citations : (m.citations ?? collectedCitations),
              needsBuild: ev.needsBuild,
            }));
            if (askAbortRef.current === controller) askAbortRef.current = null;
            return;
          } else if (ev.type === 'error') {
            updateLast((m) => ({ ...m, streaming: false }));
            toast(`Soru cevaplanamadı: ${ev.message}`, 'error');
            if (askAbortRef.current === controller) askAbortRef.current = null;
            return;
          }
        }
        updateLast((m) => ({ ...m, streaming: false }));
      } catch (err) {
        const isAbort = err instanceof DOMException && err.name === 'AbortError';
        updateLast((m) => ({ ...m, streaming: false }));
        if (!isAbort) {
          toast(`Soru cevaplanamadı: ${localizeError(err)}`, 'error');
        }
      } finally {
        if (askAbortRef.current === controller) askAbortRef.current = null;
      }
    },
    [conversationId, messagesRef, setMessages],
  );
}
