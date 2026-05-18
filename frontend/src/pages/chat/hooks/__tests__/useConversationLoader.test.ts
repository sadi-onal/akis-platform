import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useConversationLoader } from '../useConversationLoader';

// ── Mocks ──────────────────────────────────────────

vi.mock('../../../../services/api/workflows', () => ({
  workflowsApi: {
    get: vi.fn(),
  },
}));

vi.mock('../../../../components/ui/Toast', () => ({
  toast: vi.fn(),
}));

import { workflowsApi } from '../../../../services/api/workflows';

const mockedGet = vi.mocked(workflowsApi.get);

// ── Helpers ────────────────────────────────────────

function buildWorkflow(id: string, content: string, ts = '2026-05-09T12:00:00.500Z') {
  return {
    id,
    title: 'Test workflow',
    status: 'completed' as const,
    currentStage: 'completed' as const,
    traceEnabled: false,
    createdAt: '2026-05-09T12:00:00.000Z',
    updatedAt: '2026-05-09T12:00:01.000Z',
    stages: {
      scribe: { status: 'completed' as const },
      approve: { status: 'completed' as const },
      proto: { status: 'completed' as const },
      trace: { status: 'idle' as const },
    },
    conversation: [
      {
        role: 'user' as const,
        type: 'message' as const,
        content,
        timestamp: ts,
      },
    ],
  };
}

interface HookProps {
  conversationId: string | undefined;
  isConnected?: boolean;
}

function renderLoader(
  props: HookProps,
  extra?: { onWorkflowSnapshot?: (w: ReturnType<typeof buildWorkflow>) => void },
) {
  const navigate = vi.fn();
  const syncFromStage = vi.fn();
  const onWorkflowSnapshot = extra?.onWorkflowSnapshot ?? vi.fn();
  const { rerender, result, unmount } = renderHook(
    ({ conversationId, isConnected }: HookProps) =>
      useConversationLoader({
        conversationId,
        isConnected: isConnected ?? false,
        syncFromStage,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onWorkflowSnapshot: onWorkflowSnapshot as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        navigate: navigate as any,
      }),
    { initialProps: props },
  );
  return { rerender, result, unmount, navigate, syncFromStage, onWorkflowSnapshot };
}

// ── Tests ──────────────────────────────────────────

describe('useConversationLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads the conversation when conversationId is provided', async () => {
    const wf = buildWorkflow('A', 'hello A');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGet.mockResolvedValueOnce(wf as any);
    const { result, syncFromStage, onWorkflowSnapshot } = renderLoader({ conversationId: 'A' });

    await waitFor(() => {
      expect(result.current.activeWorkflow?.id).toBe('A');
    });

    expect(mockedGet).toHaveBeenCalledWith('A');
    expect(result.current.messages.length).toBeGreaterThan(0);
    expect(syncFromStage).toHaveBeenCalledWith('completed');
    // onWorkflowSnapshot is for the polling path only — initial load doesn't fire it
    expect(onWorkflowSnapshot).not.toHaveBeenCalled();
  });

  it('does not re-fetch when the same conversationId re-renders', async () => {
    const wf = buildWorkflow('A', 'hello A');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGet.mockResolvedValueOnce(wf as any);
    const { result, rerender } = renderLoader({ conversationId: 'A' });

    await waitFor(() => expect(result.current.activeWorkflow?.id).toBe('A'));
    expect(mockedGet).toHaveBeenCalledTimes(1);

    rerender({ conversationId: 'A' });
    rerender({ conversationId: 'A' });
    // Same id — no new fetch
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it('fetches new workflow and resets messages when conversationId changes', async () => {
    const a = buildWorkflow('A', 'hello A');
    const b = buildWorkflow('B', 'hello B');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGet.mockResolvedValueOnce(a as any).mockResolvedValueOnce(b as any);
    const { result, rerender } = renderLoader({ conversationId: 'A' });

    await waitFor(() => expect(result.current.activeWorkflow?.id).toBe('A'));

    rerender({ conversationId: 'B' });

    await waitFor(() => expect(result.current.activeWorkflow?.id).toBe('B'));
    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(mockedGet).toHaveBeenNthCalledWith(2, 'B');
  });

  // PR-E bulgu #1: prior behaviour was to keep the old conversation visible
  // until the new fetch resolved (~3–5s). Switching chats should now clear
  // synchronously so the old messages never bleed into the new view.
  it('clears messages + workflow synchronously when conversationId switches to a different id', async () => {
    const a = buildWorkflow('A', 'hello A');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGet.mockResolvedValueOnce(a as any);
    const { result, rerender } = renderLoader({ conversationId: 'A' });

    await waitFor(() => expect(result.current.activeWorkflow?.id).toBe('A'));
    expect(result.current.messages.length).toBeGreaterThan(0);

    // Stage a pending fetch for B so the rerender doesn't immediately resolve.
    let resolveB: (w: ReturnType<typeof buildWorkflow>) => void = () => {};
    mockedGet.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveB = res as typeof resolveB;
        }),
    );

    rerender({ conversationId: 'B' });

    // BEFORE B resolves — old A messages must already be gone.
    expect(result.current.activeWorkflow).toBeNull();
    expect(result.current.messages).toEqual([]);

    const b = buildWorkflow('B', 'hello B');
    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolveB(b as any);
    });
    await waitFor(() => expect(result.current.activeWorkflow?.id).toBe('B'));
  });

  it('clears workflow + messages + refs when conversationId becomes undefined', async () => {
    const wf = buildWorkflow('A', 'hello A');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGet.mockResolvedValueOnce(wf as any);
    const { result, rerender } = renderLoader({ conversationId: 'A' });

    await waitFor(() => expect(result.current.activeWorkflow?.id).toBe('A'));

    rerender({ conversationId: undefined });

    expect(result.current.activeWorkflow).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(result.current.loadedIdRef.current).toBeUndefined();
    expect(result.current.lastMessagesKeyRef.current).toBe('');
  });

  it('navigates to /chat when the fetch fails (404 path)', async () => {
    mockedGet.mockRejectedValueOnce(new Error('Not found'));
    const { navigate, result } = renderLoader({ conversationId: 'missing' });

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/chat', { replace: true }));
    expect(result.current.lastMessagesKeyRef.current).toBe('');
  });

  it('skips redundant setMessages when the cache key matches', async () => {
    // Same content, same timestamp → same cache key on re-load.
    const wf = buildWorkflow('A', 'hello A', '2026-05-09T12:00:00.500Z');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGet.mockResolvedValueOnce(wf as any);
    const { result } = renderLoader({ conversationId: 'A' });

    await waitFor(() => expect(result.current.activeWorkflow?.id).toBe('A'));
    const firstMessages = result.current.messages;

    // Re-fire refreshWorkflow with the same payload — key matches, setMessages skipped.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGet.mockResolvedValueOnce(wf as any);
    await act(async () => {
      await result.current.refreshWorkflow();
    });

    // Reference equality — setMessages did not fire
    expect(result.current.messages).toBe(firstMessages);
  });

  it('refreshWorkflow calls onWorkflowSnapshot so the sidebar stays in sync', async () => {
    const wf = buildWorkflow('A', 'hello A');
    const wf2 = buildWorkflow('A', 'hello A new ts', '2026-05-09T13:00:00.000Z');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGet.mockResolvedValueOnce(wf as any).mockResolvedValueOnce(wf2 as any);
    const onWorkflowSnapshot = vi.fn();
    const { result } = renderLoader({ conversationId: 'A' }, { onWorkflowSnapshot });

    await waitFor(() => expect(result.current.activeWorkflow?.id).toBe('A'));
    expect(onWorkflowSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.refreshWorkflow();
    });

    expect(onWorkflowSnapshot).toHaveBeenCalledTimes(1);
    expect(onWorkflowSnapshot.mock.calls[0][0]).toMatchObject({ id: 'A' });
  });

  it('refreshWorkflow no-ops when there is no conversationId', async () => {
    const { result } = renderLoader({ conversationId: undefined });
    await act(async () => {
      const r = await result.current.refreshWorkflow();
      expect(r).toBeNull();
    });
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('refreshWorkflow returns the fetched Workflow (S-2: callers read fresh fields)', async () => {
    const wf = buildWorkflow('A', 'hello A');
    const wf2 = buildWorkflow('A', 'hello A v2', '2026-05-09T13:00:00.000Z');
    wf2.currentStage = 'proto_building' as typeof wf2.currentStage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGet.mockResolvedValueOnce(wf as any).mockResolvedValueOnce(wf2 as any);
    const { result } = renderLoader({ conversationId: 'A' });

    await waitFor(() => expect(result.current.activeWorkflow?.id).toBe('A'));

    // Force-read the returned value — callers that need post-await fields
    // (e.g. useHandleSend reading currentStage after refresh) rely on this
    // instead of the activeWorkflowRef.
    await act(async () => {
      const r = await result.current.refreshWorkflow();
      expect(r).not.toBeNull();
      expect(r?.currentStage).toBe('proto_building');
    });
  });

  it('exposes a derived isRunning flag based on the workflow stage', async () => {
    const running = buildWorkflow('R', 'still running');
    running.currentStage = 'proto_building' as typeof running.currentStage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGet.mockResolvedValueOnce(running as any);
    const { result } = renderLoader({ conversationId: 'R' });

    await waitFor(() => expect(result.current.activeWorkflow?.id).toBe('R'));
    expect(result.current.isRunning).toBe(true);
  });

  it('isRunning is false for completed pipelines', async () => {
    const wf = buildWorkflow('A', 'hello');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGet.mockResolvedValueOnce(wf as any);
    const { result } = renderLoader({ conversationId: 'A' });

    await waitFor(() => expect(result.current.activeWorkflow?.id).toBe('A'));
    expect(result.current.isRunning).toBe(false);
  });

  it('exposes mutable lastMessagesKeyRef + loadedIdRef so external callers can reset them', async () => {
    const wf = buildWorkflow('A', 'hello A');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGet.mockResolvedValueOnce(wf as any);
    const { result } = renderLoader({ conversationId: 'A' });

    await waitFor(() => expect(result.current.activeWorkflow?.id).toBe('A'));
    expect(result.current.lastMessagesKeyRef.current).not.toBe('');
    expect(result.current.loadedIdRef.current).toBe('A');

    // Simulate the handleNewConversation reset path
    result.current.lastMessagesKeyRef.current = '';
    result.current.loadedIdRef.current = undefined;
    expect(result.current.lastMessagesKeyRef.current).toBe('');
    expect(result.current.loadedIdRef.current).toBeUndefined();
  });
});

// ── Polling tests (the heavy effect on lines 186–230) ─────────────────────────
// These use fake timers so we can advance through the Fibonacci backoff schedule
// without waiting in real time. The poll effect only runs while the workflow is
// in a RUNNING_STAGES stage, so we seed the loader with one and then advance.

describe('useConversationLoader — polling', () => {
  beforeEach(() => {
    // `mockReset` clears persistent .mockResolvedValue / .mockRejectedValue
    // implementations queued from a prior test as well as call history. Using
    // `clearAllMocks` here leaks the previous fallback into the next test's
    // initial-load fetch.
    mockedGet.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildRunningWorkflow(
    id: string,
    convLen = 1,
    ts = '2026-05-09T12:00:00.000Z',
    stage: 'scribe_clarifying' | 'proto_building' | 'trace_testing' = 'proto_building',
  ) {
    return {
      id,
      title: 'Running workflow',
      status: 'running' as const,
      currentStage: stage,
      traceEnabled: false,
      createdAt: '2026-05-09T11:50:00.000Z',
      updatedAt: ts,
      stages: {
        scribe: { status: 'completed' as const },
        approve: { status: 'completed' as const },
        proto: { status: 'running' as const },
        trace: { status: 'idle' as const },
      },
      conversation: Array.from({ length: convLen }, (_, i) => ({
        role: 'user' as const,
        type: 'message' as const,
        content: `msg-${i}`,
        timestamp: ts,
      })),
    };
  }

  /**
   * Flush all pending microtasks under fake timers — needed after the initial
   * load promise resolves but before the rendered state is observable.
   */
  async function flushMicrotasks() {
    // advanceTimersByTimeAsync(0) drains the microtask queue alongside timers.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it('polls workflow on schedule while the pipeline is running (SSE up → 20s)', async () => {
    // Two snapshots back-to-back so we can verify the poll picked up the
    // conversation-length change and called setMessages + syncFromStage.
    const first = buildRunningWorkflow('P-1', 1, '2026-05-09T12:00:00.000Z');
    const second = buildRunningWorkflow('P-1', 2, '2026-05-09T12:00:01.000Z');

    mockedGet
      // initial load
      .mockResolvedValueOnce(first as unknown as ReturnType<typeof buildRunningWorkflow>)
      // first poll tick
      .mockResolvedValueOnce(second as unknown as ReturnType<typeof buildRunningWorkflow>);

    const onWorkflowSnapshot = vi.fn();
    const { result, syncFromStage } = renderLoader(
      { conversationId: 'P-1', isConnected: true },
      { onWorkflowSnapshot },
    );

    // Initial-load promise resolves on next microtask.
    await flushMicrotasks();
    expect(result.current.activeWorkflow?.id).toBe('P-1');
    expect(result.current.isRunning).toBe(true);

    // Advance past the 20s SSE-up interval → first poll tick fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_500);
    });

    expect(mockedGet).toHaveBeenCalledTimes(2);
    // The sidebar updater fires on a successful poll snapshot whenever
    // convLen changes or stage advances.
    expect(onWorkflowSnapshot).toHaveBeenCalled();
    expect(onWorkflowSnapshot.mock.calls.at(-1)?.[0]).toMatchObject({ id: 'P-1' });
    // syncFromStage from the polling snapshot (still proto_building).
    expect(syncFromStage).toHaveBeenLastCalledWith('proto_building');
  });

  it('polls every 5s for interactive (scribe_clarifying) stages', async () => {
    const first = buildRunningWorkflow('P-2', 1, '2026-05-09T12:00:00.000Z', 'scribe_clarifying');
    const second = buildRunningWorkflow('P-2', 2, '2026-05-09T12:00:01.000Z', 'scribe_clarifying');

    mockedGet
      .mockResolvedValueOnce(first as unknown as ReturnType<typeof buildRunningWorkflow>)
      .mockResolvedValueOnce(second as unknown as ReturnType<typeof buildRunningWorkflow>);

    const { result } = renderLoader({ conversationId: 'P-2', isConnected: true });

    await flushMicrotasks();
    expect(result.current.activeWorkflow?.id).toBe('P-2');
    expect(result.current.activeWorkflow?.currentStage).toBe('scribe_clarifying');

    // 5s interactive cadence — advancing 5.5s should be enough for one tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500);
    });

    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it('skips setMessages when the polled snapshot has identical convLen + lastTs', async () => {
    // The poll tick fires setActiveWorkflow + onWorkflowSnapshot the first time
    // (because prevConvLenRef starts at 0 while convLen=1), but the inner
    // `key !== lastMessagesKeyRef.current` guard short-circuits setMessages.
    // We assert on message-list reference equality only.
    const same = buildRunningWorkflow('P-3', 1, '2026-05-09T12:00:00.000Z');
    mockedGet
      .mockResolvedValueOnce(same as unknown as ReturnType<typeof buildRunningWorkflow>)
      // Polling tick — same convLen + lastTs.
      .mockResolvedValueOnce(same as unknown as ReturnType<typeof buildRunningWorkflow>);

    const { result } = renderLoader({ conversationId: 'P-3', isConnected: true });

    await flushMicrotasks();
    expect(result.current.activeWorkflow?.id).toBe('P-3');
    const firstMessages = result.current.messages;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_500);
    });

    expect(mockedGet).toHaveBeenCalledTimes(2);
    // Reference equality — the inner cache hit short-circuited setMessages.
    expect(result.current.messages).toBe(firstMessages);
  });

  it('skips setActiveWorkflow + onWorkflowSnapshot when convLen AND stage are unchanged', async () => {
    // After the first poll tick has cached convLen=1, a SECOND tick with the
    // same payload should hit the outer `convLen !== prev || stageChanged`
    // false-branch and not call the sidebar updater again.
    const same = buildRunningWorkflow('P-3b', 1, '2026-05-09T12:00:00.000Z');
    mockedGet.mockResolvedValue(same as unknown as ReturnType<typeof buildRunningWorkflow>);

    const onWorkflowSnapshot = vi.fn();
    const { result } = renderLoader(
      { conversationId: 'P-3b', isConnected: true },
      { onWorkflowSnapshot },
    );

    await flushMicrotasks();
    expect(result.current.activeWorkflow?.id).toBe('P-3b');

    // First poll tick — prevConvLenRef=0, convLen=1 → triggers updates.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_500);
    });
    expect(onWorkflowSnapshot).toHaveBeenCalledTimes(1);

    // Second poll tick — prevConvLenRef=1, convLen=1, stage unchanged →
    // outer guard short-circuits, no further onWorkflowSnapshot call.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_500);
    });
    expect(onWorkflowSnapshot).toHaveBeenCalledTimes(1);
  });

  it('keeps polling and surfaces the lost-connection warning toast after 5 consecutive errors', async () => {
    const first = buildRunningWorkflow('P-4', 1, '2026-05-09T12:00:00.000Z');
    mockedGet.mockResolvedValueOnce(first as unknown as ReturnType<typeof buildRunningWorkflow>);
    // All subsequent ticks fail.
    mockedGet.mockRejectedValue(new Error('flaky'));

    const { result } = renderLoader({ conversationId: 'P-4', isConnected: true });

    await flushMicrotasks();
    expect(result.current.activeWorkflow?.id).toBe('P-4');

    // Drain enough virtual time for 5+ backed-off retries.
    // Sequence: 20s, 40s (capped at 30s after this), 30s, 30s, 30s, 30s.
    for (let i = 0; i < 8; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
    }

    expect(mockedGet.mock.calls.length).toBeGreaterThanOrEqual(5);
    const { toast } = await import('../../../../components/ui/Toast');
    const mockedToast = vi.mocked(toast);
    const warnCalls = mockedToast.mock.calls.filter((c) => c[1] === 'warning');
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('toasts "Bağlantı yeniden kuruldu" once polling recovers after the lost-connection latch', async () => {
    // 5 errors → latch flips → next success → "reconnected" toast fires once.
    const first = buildRunningWorkflow('P-5', 1, '2026-05-09T12:00:00.000Z');
    const recovered = buildRunningWorkflow('P-5', 2, '2026-05-09T12:00:01.000Z');
    mockedGet.mockResolvedValueOnce(first as unknown as ReturnType<typeof buildRunningWorkflow>);
    mockedGet.mockRejectedValueOnce(new Error('flaky-1'));
    mockedGet.mockRejectedValueOnce(new Error('flaky-2'));
    mockedGet.mockRejectedValueOnce(new Error('flaky-3'));
    mockedGet.mockRejectedValueOnce(new Error('flaky-4'));
    mockedGet.mockRejectedValueOnce(new Error('flaky-5'));
    mockedGet.mockResolvedValueOnce(
      recovered as unknown as ReturnType<typeof buildRunningWorkflow>,
    );

    const { result } = renderLoader({ conversationId: 'P-5', isConnected: true });
    await flushMicrotasks();
    expect(result.current.activeWorkflow?.id).toBe('P-5');

    // Drain enough virtual time to step through 5 error ticks + 1 success.
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
    }

    const { toast } = await import('../../../../components/ui/Toast');
    const mockedToast = vi.mocked(toast);
    const successCalls = mockedToast.mock.calls.filter((c) => c[1] === 'success');
    expect(successCalls.length).toBeGreaterThanOrEqual(1);
    // The success toast string contains 'yeniden kuruldu' Turkish for "re-established".
    expect(successCalls.some((c) => String(c[0]).includes('yeniden kuruldu'))).toBe(true);
  });

  it('stops polling on unmount (no further fetches after teardown)', async () => {
    const first = buildRunningWorkflow('P-6', 1, '2026-05-09T12:00:00.000Z');
    mockedGet.mockResolvedValue(first as unknown as ReturnType<typeof buildRunningWorkflow>);

    const { result, unmount } = renderLoader({
      conversationId: 'P-6',
      isConnected: true,
    });

    await flushMicrotasks();
    expect(result.current.activeWorkflow?.id).toBe('P-6');
    const callsBefore = mockedGet.mock.calls.length;

    unmount();

    // Advance well past several poll intervals — controller.abort + clearTimeout
    // should prevent any more get() calls.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(mockedGet.mock.calls.length).toBeLessThanOrEqual(callsBefore + 1);
  });

  it('uses 8s polling interval when SSE is down (isConnected=false)', async () => {
    const first = buildRunningWorkflow('P-7', 1, '2026-05-09T12:00:00.000Z');
    const second = buildRunningWorkflow('P-7', 2, '2026-05-09T12:00:01.000Z');
    mockedGet
      .mockResolvedValueOnce(first as unknown as ReturnType<typeof buildRunningWorkflow>)
      .mockResolvedValueOnce(second as unknown as ReturnType<typeof buildRunningWorkflow>);

    const { result } = renderLoader({ conversationId: 'P-7', isConnected: false });

    await flushMicrotasks();
    expect(result.current.activeWorkflow?.id).toBe('P-7');

    // 8s tick — advancing 8.5s should be enough.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_500);
    });

    expect(mockedGet).toHaveBeenCalledTimes(2);
  });
});
