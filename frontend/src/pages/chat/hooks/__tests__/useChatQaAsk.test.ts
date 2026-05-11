/**
 * Tests for the ASK-intent streaming hook (F-06 / S-1 / F-09).
 *
 * Covers the SSE state machine via a mocked async-iterable from `chatQaApi.ask`:
 *   (a) Successful stream → chunks appended to the in-flight chat_qa_response.
 *   (b) `done` event with `needsBuild=true` → flips streaming=false, exposes
 *       the needsBuild flag so the layout can render the [BUILD] CTA.
 *   (c) Abort: a second `ask` while the first is still streaming aborts the
 *       earlier signal, and an unmount aborts the in-flight stream.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { MutableRefObject } from 'react';

import { useChatQaAsk } from '../useChatQaAsk';
import type { ChatMessage } from '../../../../types/chat';
import type { QAEvent } from '../../../../services/api/chatQa';

// ── Mocks ──────────────────────────────────────────

vi.mock('../../../../services/api/chatQa', () => ({
  chatQaApi: {
    ask: vi.fn(),
  },
}));

vi.mock('../../../../components/ui/Toast', () => ({
  toast: vi.fn(),
}));

import { chatQaApi } from '../../../../services/api/chatQa';
import { toast } from '../../../../components/ui/Toast';

const mockedAsk = vi.mocked(chatQaApi.ask);
const mockedToast = vi.mocked(toast);

// ── Helpers ────────────────────────────────────────

/** Build an async iterator of QAEvents that respects an optional AbortSignal. */
function makeStream(
  events: QAEvent[],
  opts?: { signal?: AbortSignal; gap?: () => Promise<void> },
): AsyncGenerator<QAEvent> {
  async function* gen() {
    for (const ev of events) {
      if (opts?.signal?.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
      if (opts?.gap) await opts.gap();
      yield ev;
    }
  }
  return gen();
}

interface Setup {
  messages: ChatMessage[];
  messagesRef: MutableRefObject<ChatMessage[]>;
  setMessages: ReturnType<typeof vi.fn>;
}

function setup(conversationId?: string): Setup & { hook: ReturnType<typeof renderHook> } {
  const messages: ChatMessage[] = [];
  const setMessages = vi.fn((updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    const next = updater(messages.slice());
    messages.splice(0, messages.length, ...next);
  });
  const messagesRef: MutableRefObject<ChatMessage[]> = { current: messages };

  const hook = renderHook(() =>
    useChatQaAsk({
      conversationId,
      messagesRef,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setMessages: setMessages as any,
    }),
  );
  return { messages, messagesRef, setMessages, hook };
}

// ── Tests ──────────────────────────────────────────

describe('useChatQaAsk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── (a) successful SSE stream → chunks appended ──

  it('(a) appends chunks + citations onto a single streaming chat_qa_response', async () => {
    mockedAsk.mockImplementationOnce(() =>
      makeStream([
        { type: 'chunk', text: 'Hello ' },
        { type: 'chunk', text: 'world.' },
        { type: 'citation', citation: { source: 'spec', excerpt: 'X is a foo.' } },
        { type: 'done', answer: 'Hello world.', citations: [], needsBuild: false },
      ]),
    );

    const s = setup('conv-1');

    await act(async () => {
      // Cast to the callback type returned by renderHook.
      const askFn = s.hook.result.current as unknown as (m: string) => Promise<void>;
      await askFn('What is X?');
    });

    // user bubble + chat_qa_response
    expect(s.messages.length).toBe(2);
    expect(s.messages[0]).toMatchObject({ type: 'user', content: 'What is X?' });
    const qa = s.messages[1] as Extract<ChatMessage, { type: 'chat_qa_response' }>;
    expect(qa.type).toBe('chat_qa_response');
    expect(qa.content).toBe('Hello world.');
    expect(qa.streaming).toBe(false);
    expect(qa.citations?.length).toBeGreaterThanOrEqual(1);
    expect(qa.citations?.[0]).toMatchObject({ source: 'spec' });
  });

  // ── (b) done event with needsBuild=true ──────────

  it('(b) `done` event with needsBuild=true → exposes needsBuild flag on the message', async () => {
    mockedAsk.mockImplementationOnce(() =>
      makeStream([
        { type: 'chunk', text: 'Yes.' },
        {
          type: 'done',
          answer: 'Yes — you should build this.',
          citations: [{ source: 'findings', excerpt: 'Build recommended' }],
          needsBuild: true,
        },
      ]),
    );

    const s = setup('conv-2');

    await act(async () => {
      const askFn = s.hook.result.current as unknown as (m: string) => Promise<void>;
      await askFn('Should I build the v2?');
    });

    const qa = s.messages.at(-1) as Extract<ChatMessage, { type: 'chat_qa_response' }>;
    expect(qa.streaming).toBe(false);
    expect(qa.needsBuild).toBe(true);
    expect(qa.content).toBe('Yes — you should build this.');
    expect(qa.sourceMessage).toBe('Should I build the v2?');
    // No error toast on success
    expect(mockedToast).not.toHaveBeenCalled();
  });

  // ── (c) abort cancels in-flight stream ───────────

  it('(c) a second ask aborts the in-flight signal of the first', async () => {
    const signals: AbortSignal[] = [];
    mockedAsk.mockImplementation(({ signal }) => {
      if (signal) signals.push(signal);
      return makeStream(
        [
          { type: 'chunk', text: 'partial' },
          { type: 'done', answer: 'partial', citations: [], needsBuild: false },
        ],
        { signal, gap: () => new Promise((r) => setTimeout(r, 5)) },
      );
    });

    const s = setup('conv-3');

    await act(async () => {
      const askFn = s.hook.result.current as unknown as (m: string) => Promise<void>;
      // Don't await the first — let the second one trigger the abort.
      void askFn('first question');
      await askFn('second question');
    });

    expect(signals.length).toBe(2);
    // First call's signal must have been aborted by the time the second one
    // ran (the hook calls `askAbortRef.current?.abort()` before opening the
    // new stream).
    expect(signals[0].aborted).toBe(true);
  });

  it('(c) unmount aborts the in-flight stream (cleanup effect)', async () => {
    let capturedSignal: AbortSignal | null = null;
    mockedAsk.mockImplementation(({ signal }) => {
      if (signal) capturedSignal = signal;
      return makeStream(
        [
          { type: 'chunk', text: 'slow…' },
          { type: 'done', answer: 'slow…', citations: [], needsBuild: false },
        ],
        // Delay both events so the unmount happens before completion.
        { signal, gap: () => new Promise((r) => setTimeout(r, 20)) },
      );
    });

    const s = setup('conv-4');

    act(() => {
      const askFn = s.hook.result.current as unknown as (m: string) => Promise<void>;
      void askFn('long-running');
    });

    // Wait until the hook has captured the signal (i.e. the async iterator
    // started consuming) before unmounting.
    await waitFor(() => expect(capturedSignal).not.toBeNull());

    act(() => {
      s.hook.unmount();
    });

    // The cleanup effect calls `askAbortRef.current?.abort()` on unmount.
    await waitFor(() => expect(capturedSignal?.aborted).toBe(true));
  });

  // ── error event surfaces a toast ──────────────────

  it('error event flips streaming=false + surfaces an error toast', async () => {
    mockedAsk.mockImplementationOnce(() =>
      makeStream([
        { type: 'chunk', text: 'partial answer…' },
        { type: 'error', code: 'CHAT_QA_FAILED', message: 'Hata oluştu' },
      ]),
    );

    const s = setup('conv-5');

    await act(async () => {
      const askFn = s.hook.result.current as unknown as (m: string) => Promise<void>;
      await askFn('boom');
    });

    const qa = s.messages.at(-1) as Extract<ChatMessage, { type: 'chat_qa_response' }>;
    expect(qa.streaming).toBe(false);
    expect(mockedToast).toHaveBeenCalledWith(expect.stringMatching(/Hata oluştu/), 'error');
  });
});
