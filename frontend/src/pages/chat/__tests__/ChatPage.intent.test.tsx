/**
 * Tests for the FEEDBACK-intent routing wired in ChatPage (T3 of
 * preview-unify). The actual implementation lives in
 * `pages/chat/hooks/useHandleIntentFeedback.ts` — we exercise that hook
 * directly so we don't have to mount the full ChatPage tree just to
 * cover four routing branches.
 *
 * Spec: docs/superpowers/specs/2026-05-14-preview-unify-chat-iterate-design.md § T3
 *
 * Coverage matrix:
 *   1. awaiting_push_confirm + pipelineId → calls iterateWithFeedback
 *   2. !awaiting_push_confirm → falls back to placeholder
 *   3. optimistic echo (user msg + system info) appended before API resolves
 *   4. iterate error → toast surfaced
 *   5. missing pipelineId → falls back to placeholder (defensive)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import { useHandleIntentFeedback } from '../hooks/useHandleIntentFeedback';
import { I18nProvider } from '../../../i18n/I18nProvider';
import type { ChatMessage, ConversationUIState } from '../../../types/chat';

// ── Mocks ──────────────────────────────────────────

vi.mock('../../../services/api/workflows', () => ({
  workflowsApi: {
    iterateWithFeedback: vi.fn(),
  },
}));

vi.mock('../../../components/ui/Toast', () => ({
  toast: vi.fn(),
}));

import { workflowsApi } from '../../../services/api/workflows';
import { toast } from '../../../components/ui/Toast';

const mockedIterate = vi.mocked(workflowsApi.iterateWithFeedback);
const mockedToast = vi.mocked(toast);

// ── Helpers ────────────────────────────────────────

function wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider>{children}</I18nProvider>;
}

interface HookHarness {
  messages: ChatMessage[];
  setMessages: ReturnType<typeof vi.fn>;
  fallback: ReturnType<typeof vi.fn>;
  /** Always points at the latest hook return — safe to call after I18n loads. */
  getHandle: () => (message: string) => Promise<void> | void;
}

interface SetupOpts {
  pipelineId?: string | undefined;
}

async function setup(uiState: ConversationUIState, opts?: SetupOpts): Promise<HookHarness> {
  // Default to a real id when caller doesn't pass an opts bag. Caller can
  // pass `{ pipelineId: undefined }` explicitly to exercise the defensive
  // fallback path.
  const resolvedPipelineId: string | undefined =
    opts && 'pipelineId' in opts ? opts.pipelineId : 'pipe-1';
  const messages: ChatMessage[] = [];
  const setMessages = vi.fn((updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
    if (typeof updater === 'function') {
      const next = updater(messages);
      messages.splice(0, messages.length, ...next);
    } else {
      messages.splice(0, messages.length, ...updater);
    }
  });
  const fallback = vi.fn();

  const { result } = renderHook(
    () =>
      useHandleIntentFeedback({
        uiState,
        pipelineId: resolvedPipelineId,
        setMessages,
        fallback,
      }),
    { wrapper }
  );

  // I18nProvider mounts async — wait until the hook is wired before letting
  // the test invoke it. The hook returns a stable callback once useI18n is
  // ready inside the provider.
  await waitFor(() => {
    expect(typeof result.current).toBe('function');
  });

  return {
    messages,
    setMessages,
    fallback,
    getHandle: () => result.current,
  };
}

// ── Tests ──────────────────────────────────────────

describe('useHandleIntentFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls workflowsApi.iterateWithFeedback when state is awaiting_push_confirm', async () => {
    mockedIterate.mockResolvedValue({} as never);
    const { getHandle, fallback } = await setup('awaiting_push_confirm');

    await act(async () => {
      await getHandle()('renkleri pembe yap');
    });

    await waitFor(() => {
      expect(mockedIterate).toHaveBeenCalledTimes(1);
    });
    expect(mockedIterate).toHaveBeenCalledWith('pipe-1', 'renkleri pembe yap');
    // Fallback must NOT fire when we're at the gate — we took the real path.
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back to placeholder when state is not awaiting_push_confirm', async () => {
    const { getHandle, fallback } = await setup('idle');

    await act(async () => {
      await getHandle()('rastgele bir şey');
    });

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith('Geribildirim', 'rastgele bir şey');
    expect(mockedIterate).not.toHaveBeenCalled();
  });

  it('falls back to placeholder when pipelineId is missing (defensive)', async () => {
    const { getHandle, fallback } = await setup('awaiting_push_confirm', {
      pipelineId: undefined,
    });

    await act(async () => {
      await getHandle()('renkleri pembe yap');
    });

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(mockedIterate).not.toHaveBeenCalled();
  });

  it('appends optimistic echo (user msg + system info) before the API resolves', async () => {
    // Keep iterate pending so we can inspect setMessages BEFORE resolution.
    let resolveIterate: () => void = () => {};
    mockedIterate.mockImplementation(
      () =>
        new Promise<never>((res) => {
          resolveIterate = () => res({} as never);
        })
    );

    const { getHandle, setMessages, messages } = await setup('awaiting_push_confirm');

    await act(async () => {
      // Don't await — let the optimistic update apply, inspect, then resolve.
      void getHandle()('başlığı büyült');
      // Give the optimistic setMessages a microtask.
      await Promise.resolve();
    });

    expect(setMessages).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ type: 'user', content: 'başlığı büyült' });
    expect(messages[1]).toMatchObject({ type: 'info' });
    // The info bubble copy must be the optimistic-echo string — not the key.
    expect(messages[1].content).not.toBe('chat.feedback.optimisticEcho');
    expect(typeof messages[1].content).toBe('string');
    expect((messages[1].content as string).length).toBeGreaterThan(0);

    await act(async () => {
      resolveIterate();
      await Promise.resolve();
    });
  });

  it('surfaces a toast when iterateWithFeedback rejects', async () => {
    mockedIterate.mockRejectedValue(new Error('pipeline busy'));
    const { getHandle } = await setup('awaiting_push_confirm');

    await act(async () => {
      await getHandle()('başlığı büyült');
    });

    await waitFor(() => {
      expect(mockedToast).toHaveBeenCalledTimes(1);
    });
    expect(mockedToast).toHaveBeenCalledWith('pipeline busy', 'error');
  });

  it('skips empty / whitespace-only messages without firing anything', async () => {
    const { getHandle, fallback } = await setup('awaiting_push_confirm');

    await act(async () => {
      await getHandle()('   ');
    });

    expect(mockedIterate).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });
});
