import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useIterationChildPoll } from '../useIterationChildPoll';
import type { ChatMessage } from '../../../../types/chat';

vi.mock('../../../../services/api/workflows', () => ({
  workflowsApi: {
    get: vi.fn(),
  },
}));

import { workflowsApi } from '../../../../services/api/workflows';

const mockedGet = vi.mocked(workflowsApi.get);

// ── Helpers ────────────────────────────────────────

function buildChild(
  id: string,
  stage:
    | 'proto_building'
    | 'completed'
    | 'completed_partial'
    | 'failed'
    | 'cancelled' = 'proto_building',
  extra?: { filesCreated?: number; branch?: string },
) {
  return {
    id,
    title: 'Iteration child',
    status: stage === 'proto_building' ? 'running' : 'completed',
    currentStage: stage,
    traceEnabled: false,
    createdAt: '2026-05-09T12:00:00.000Z',
    updatedAt: '2026-05-09T12:00:01.000Z',
    stages: {
      scribe: { status: 'completed' as const },
      approve: { status: 'completed' as const },
      proto: {
        status: 'completed' as const,
        filesCreated: extra?.filesCreated,
        branch: extra?.branch,
      },
      trace: { status: 'idle' as const },
    },
    conversation: [],
  };
}

// ── Tests ──────────────────────────────────────────

describe('useIterationChildPoll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const refreshWorkflow = vi.fn().mockResolvedValue(undefined);
    const refreshList = vi.fn();
    const messages: ChatMessage[] = [];
    const setMessages = vi.fn((updater: (prev: ChatMessage[]) => ChatMessage[]) => {
      const next = updater(messages.slice());
      messages.splice(0, messages.length, ...next);
    });
    const hook = renderHook(() =>
      useIterationChildPoll({
        refreshWorkflow,
        refreshList,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setMessages: setMessages as any,
      }),
    );
    return { hook, refreshWorkflow, refreshList, setMessages, messages };
  }

  it('appends a completion message when the child completes', async () => {
    const { hook, refreshList, refreshWorkflow, messages } = setup();
    mockedGet.mockResolvedValueOnce(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buildChild('c-1', 'completed', { filesCreated: 3, branch: 'iter-1' }) as any,
    );

    act(() => {
      hook.result.current.startPolling('c-1');
    });

    // First tick fires at 2s
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

    expect(mockedGet).toHaveBeenCalledWith('c-1');
    expect(refreshWorkflow).toHaveBeenCalled();
    expect(refreshList).toHaveBeenCalled();
    expect(messages.at(-1)).toMatchObject({
      type: 'info',
      content: expect.stringMatching(/3 dosya güncellendi/),
    });
  });

  it('appends a failure message when the child fails', async () => {
    const { hook, messages } = setup();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGet.mockResolvedValueOnce(buildChild('c-2', 'failed') as any);

    act(() => {
      hook.result.current.startPolling('c-2');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

    expect(messages.at(-1)).toMatchObject({
      type: 'info',
      content: expect.stringMatching(/başarısız/),
    });
  });

  it('appends a cancellation message when the child is cancelled', async () => {
    const { hook, messages } = setup();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGet.mockResolvedValueOnce(buildChild('c-3', 'cancelled') as any);

    act(() => {
      hook.result.current.startPolling('c-3');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

    expect(messages.at(-1)).toMatchObject({
      type: 'info',
      content: expect.stringMatching(/iptal/),
    });
  });

  it('keeps polling on transient errors then completes on success', async () => {
    const { hook, refreshWorkflow, messages } = setup();
    mockedGet
      .mockRejectedValueOnce(new Error('flaky network'))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce(buildChild('c-4', 'completed') as any);

    act(() => {
      hook.result.current.startPolling('c-4');
    });

    // First tick — fails. Advance enough for the Fibonacci backoff tick #2.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(messages.length).toBe(0);

    // fibStep(1) → 2000ms; second tick should now succeed and append the message.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(refreshWorkflow).toHaveBeenCalledTimes(1);
    expect(messages.at(-1)).toMatchObject({
      type: 'info',
      content: expect.stringMatching(/tamamlandı/i),
    });
  });

  it('does not finalise while the child is still running', async () => {
    const { hook, messages } = setup();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGet.mockResolvedValue(buildChild('c-5', 'proto_building') as any);

    act(() => {
      hook.result.current.startPolling('c-5');
    });

    // Two ticks — both running. No terminal message should be appended.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500);
    });

    expect(messages.length).toBe(0);
    expect(mockedGet.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('aborts in-flight polling on unmount', async () => {
    const { hook, messages } = setup();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGet.mockResolvedValue(buildChild('c-6', 'proto_building') as any);

    act(() => {
      hook.result.current.startPolling('c-6');
    });

    hook.unmount();

    // Advance well past several poll cycles — no further work should fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(messages.length).toBe(0);
    // get may have been called once (the in-flight pre-unmount call), but no
    // terminal message should ever appear.
    expect(mockedGet.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('replacing the active child preempts the previous tracker', async () => {
    const { hook, messages } = setup();
    // Route the response by id — both setTimeouts fire, but only the second
    // matches the active tracker id and gets to finalise.
    mockedGet.mockImplementation((id: string) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Promise.resolve(buildChild(id, id === 'second' ? 'completed' : 'proto_building') as any),
    );

    act(() => {
      hook.result.current.startPolling('first');
    });
    act(() => {
      hook.result.current.startPolling('second');
    });

    // Drain timers — only the second child should finalise (the first tracker
    // was overwritten by the second startPolling call, so the first tick that
    // resolves for id 'first' bails out before doing any work).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

    expect(messages.at(-1)).toMatchObject({
      type: 'info',
      content: expect.stringMatching(/tamamlandı/i),
    });
  });
});
