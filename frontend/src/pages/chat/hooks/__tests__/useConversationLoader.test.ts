import { describe, it, expect, vi, beforeEach } from 'vitest';
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
      await result.current.refreshWorkflow();
    });
    expect(mockedGet).not.toHaveBeenCalled();
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
