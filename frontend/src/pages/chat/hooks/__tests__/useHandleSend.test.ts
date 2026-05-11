/**
 * Tests for the chat-send dispatcher (F-06 / S-1).
 *
 * Covers the four behaviour branches that matter most:
 *   (a) new-conversation send → `workflowsApi.create` + nav + sync.
 *   (b) iteration-child send (terminal pipeline + protoRepo + protoBranch)
 *       → `workflowsApi.create` with skipScribe + startIterationChildPoll.
 *   (c) JIT GitHub gate intercept when `hasGitHub === false` on the first
 *       send of a brand-new conversation.
 *   (d) sendMessage branch after the pipeline already exists — also asserts
 *       that the new stage is read from `refreshWorkflow()`'s return value
 *       (S-2) and not from a possibly-stale `activeWorkflowRef`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { MutableRefObject } from 'react';

import { useHandleSend, type UseHandleSendOptions } from '../useHandleSend';
import type { Workflow } from '../../../../types/workflow';
import type { ChatMessage } from '../../../../types/chat';

// ── Mocks ──────────────────────────────────────────

vi.mock('../../../../services/api/workflows', () => ({
  workflowsApi: {
    create: vi.fn(),
    sendMessage: vi.fn(),
  },
}));

vi.mock('../../../../services/api/chatAttach', () => ({
  attachDocumentsToChat: vi.fn(),
}));

vi.mock('../../../../components/ui/Toast', () => ({
  toast: vi.fn(),
}));

import { workflowsApi } from '../../../../services/api/workflows';
import { toast } from '../../../../components/ui/Toast';

const mockedCreate = vi.mocked(workflowsApi.create);
const mockedSendMessage = vi.mocked(workflowsApi.sendMessage);
const mockedToast = vi.mocked(toast);

// ── Helpers ────────────────────────────────────────

function buildWorkflow(
  id: string,
  stage:
    | 'scribe_clarifying'
    | 'scribe_generating'
    | 'awaiting_approval'
    | 'proto_building'
    | 'trace_testing'
    | 'completed'
    | 'completed_partial'
    | 'failed' = 'scribe_clarifying',
  extra?: { protoRepo?: string; protoBranch?: string },
): Workflow {
  return {
    id,
    title: 'Test workflow',
    status: stage === 'completed' ? 'completed' : 'running',
    currentStage: stage,
    traceEnabled: false,
    createdAt: '2026-05-09T12:00:00.000Z',
    updatedAt: '2026-05-09T12:00:01.000Z',
    stages: {
      scribe: { status: 'completed' as const },
      approve: { status: 'completed' as const },
      proto: {
        status: 'completed' as const,
        repo: extra?.protoRepo,
        branch: extra?.protoBranch,
      },
      trace: { status: 'idle' as const },
    },
    conversation: [],
  } as unknown as Workflow;
}

function makeRef<T>(value: T): MutableRefObject<T> {
  return { current: value };
}

interface Setup {
  options: UseHandleSendOptions;
  setMessages: ReturnType<typeof vi.fn>;
  messages: ChatMessage[];
  setPendingGithubIdea: ReturnType<typeof vi.fn>;
  setPendingConv: ReturnType<typeof vi.fn>;
  setActiveWorkflow: ReturnType<typeof vi.fn>;
  setCreating: ReturnType<typeof vi.fn>;
  setSelectedRepo: ReturnType<typeof vi.fn>;
  syncFromStage: ReturnType<typeof vi.fn>;
  refreshWorkflow: ReturnType<typeof vi.fn>;
  refreshList: ReturnType<typeof vi.fn>;
  startIterationChildPoll: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
}

function setup(overrides: Partial<UseHandleSendOptions> = {}): Setup {
  const messages: ChatMessage[] = [];
  // React's `setState` accepts either a value or an updater function — match
  // that polymorphism so callers that pass `setMessages(array)` directly
  // (e.g. `setMessages(conversationToChatMessages(...))`) work too.
  const setMessages = vi.fn(
    (next: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
      const resolved =
        typeof next === 'function' ? (next as (p: ChatMessage[]) => ChatMessage[])(messages.slice()) : next;
      messages.splice(0, messages.length, ...resolved);
    },
  );
  const setPendingGithubIdea = vi.fn();
  const setPendingConv = vi.fn();
  const setActiveWorkflow = vi.fn();
  const setCreating = vi.fn();
  const setSelectedRepo = vi.fn();
  const syncFromStage = vi.fn();
  const refreshWorkflow = vi.fn().mockResolvedValue(null);
  const refreshList = vi.fn();
  const startIterationChildPoll = vi.fn();
  const navigate = vi.fn();

  const options: UseHandleSendOptions = {
    conversationId: undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    navigate: navigate as any,
    hasGitHub: true,
    profileLoading: false,
    traceEnabled: false,
    pendingModel: 'claude-haiku-4-5-20251001',
    selectedRepo: null,
    setSelectedRepo,
    pendingConvRef: makeRef<{ displayName: string } | null>(null),
    activeWorkflowRef: makeRef<Workflow | null>(null),
    setPendingConv,
    setCreating,
    setActiveWorkflow,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setMessages: setMessages as any,
    loadedIdRef: makeRef<string | undefined>(undefined),
    syncFromStage,
    refreshWorkflow,
    refreshList,
    startIterationChildPoll,
    setPendingGithubIdea,
    ...overrides,
  };

  return {
    options,
    setMessages,
    messages,
    setPendingGithubIdea,
    setPendingConv,
    setActiveWorkflow,
    setCreating,
    setSelectedRepo,
    syncFromStage,
    refreshWorkflow,
    refreshList,
    startIterationChildPoll,
    navigate,
  };
}

function renderSend(setupResult: Setup) {
  return renderHook(() => useHandleSend(setupResult.options));
}

// ── Tests ──────────────────────────────────────────

describe('useHandleSend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── (a) new-conversation branch ──────────────────

  it('(a) new-conversation: creates pipeline via workflowsApi.create + navigates', async () => {
    const created = buildWorkflow('new-1', 'scribe_clarifying');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedCreate.mockResolvedValueOnce(created as any);
    const s = setup({
      conversationId: undefined,
      pendingConvRef: makeRef({ displayName: 'My new project' }),
      hasGitHub: true,
    });
    const { result } = renderSend(s);

    await act(async () => {
      await result.current('Build a todo app with React and Tailwind');
    });

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        idea: 'Build a todo app with React and Tailwind',
        traceEnabled: false,
        model: 'claude-haiku-4-5-20251001',
      }),
      undefined,
    );
    expect(s.setPendingConv).toHaveBeenCalledWith(null);
    expect(s.setActiveWorkflow).toHaveBeenCalledWith(created);
    expect(s.refreshList).toHaveBeenCalled();
    expect(s.navigate).toHaveBeenCalledWith('/chat/new-1', { replace: true });
    expect(s.syncFromStage).toHaveBeenCalledWith('scribe_clarifying');
    // First send populates the user-bubble + (after create) the message list.
    expect(s.messages.length).toBeGreaterThan(0);
  });

  it('(a) new-conversation: short idea (<10 chars) does not call create + appends error', async () => {
    const s = setup({
      conversationId: undefined,
      pendingConvRef: makeRef({ displayName: 'X' }),
      hasGitHub: true,
    });
    const { result } = renderSend(s);

    await act(async () => {
      await result.current('too short');
    });

    expect(mockedCreate).not.toHaveBeenCalled();
    // user bubble + error
    expect(s.messages.length).toBe(2);
    expect(s.messages.at(-1)).toMatchObject({ type: 'error', retryable: false });
  });

  it('(a) new-conversation: surfaces toast + error message on create failure', async () => {
    mockedCreate.mockRejectedValueOnce(new Error('Server unavailable'));
    const s = setup({
      conversationId: undefined,
      pendingConvRef: makeRef({ displayName: 'X' }),
      hasGitHub: true,
    });
    const { result } = renderSend(s);

    await act(async () => {
      await result.current('A long enough idea for create');
    });

    expect(mockedToast).toHaveBeenCalledWith(expect.any(String), 'error');
    expect(s.messages.at(-1)).toMatchObject({ type: 'error', retryable: true });
    expect(s.setCreating).toHaveBeenLastCalledWith(false);
  });

  // ── (b) iteration-child branch ──────────────────

  it('(b) iteration-child: terminal pipeline + protoRepo + protoBranch spawns a child', async () => {
    const child = buildWorkflow('child-1', 'proto_building');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedCreate.mockResolvedValueOnce(child as any);

    const parent = buildWorkflow('parent-1', 'completed', {
      protoRepo: 'octo/repo',
      protoBranch: 'feat/main',
    });
    const s = setup({
      conversationId: 'parent-1',
      pendingConvRef: makeRef(null),
      activeWorkflowRef: makeRef<Workflow | null>(parent),
      hasGitHub: true,
    });
    const { result } = renderSend(s);

    await act(async () => {
      await result.current('Add a dark-mode toggle');
    });

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        idea: 'Add a dark-mode toggle',
        existingRepo: { owner: 'octo', repo: 'repo', branch: 'feat/main' },
        parentPipelineId: 'parent-1',
        skipScribe: true,
      }),
      undefined,
    );
    expect(s.startIterationChildPoll).toHaveBeenCalledWith('child-1');
    expect(s.refreshList).toHaveBeenCalled();
    // sendMessage is NOT called on the iteration branch
    expect(mockedSendMessage).not.toHaveBeenCalled();
    // An info bubble explains the iteration started
    expect(s.messages.at(-1)).toMatchObject({
      type: 'info',
      content: expect.stringMatching(/İterasyon başlatıldı/),
    });
  });

  it('(b) iteration-child: falls through to sendMessage when terminal but no protoRepo', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedSendMessage.mockResolvedValueOnce(undefined as any);
    const parent = buildWorkflow('parent-2', 'completed', {});
    const s = setup({
      conversationId: 'parent-2',
      pendingConvRef: makeRef(null),
      activeWorkflowRef: makeRef<Workflow | null>(parent),
    });
    const { result } = renderSend(s);

    await act(async () => {
      await result.current('Without proto repo data');
    });

    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedSendMessage).toHaveBeenCalledWith('parent-2', 'Without proto repo data', undefined);
    expect(s.startIterationChildPoll).not.toHaveBeenCalled();
  });

  // ── (c) JIT GitHub gate intercept ────────────────

  it('(c) JIT GitHub gate: blocks new-conversation send when !hasGitHub + idea≥10 chars', async () => {
    const s = setup({
      conversationId: undefined,
      pendingConvRef: makeRef({ displayName: 'X' }),
      hasGitHub: false,
      profileLoading: false,
    });
    const { result } = renderSend(s);

    await act(async () => {
      await result.current('A long enough idea to trigger gate');
    });

    expect(s.setPendingGithubIdea).toHaveBeenCalledWith('A long enough idea to trigger gate');
    // The gate intercept short-circuits BEFORE any API call or message push.
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(s.messages.length).toBe(0);
  });

  it('(c) JIT GitHub gate: does NOT trigger while profile is loading', async () => {
    const created = buildWorkflow('new-2', 'scribe_clarifying');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedCreate.mockResolvedValueOnce(created as any);
    const s = setup({
      conversationId: undefined,
      pendingConvRef: makeRef({ displayName: 'X' }),
      hasGitHub: false,
      profileLoading: true, // gate suppressed while loading
    });
    const { result } = renderSend(s);

    await act(async () => {
      await result.current('A long enough idea to attempt create');
    });

    expect(s.setPendingGithubIdea).not.toHaveBeenCalled();
    expect(mockedCreate).toHaveBeenCalled();
  });

  it('(c) JIT GitHub gate: does NOT trigger on iteration sends (only first send of new conv)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedSendMessage.mockResolvedValueOnce(undefined as any);
    const parent = buildWorkflow('parent-3', 'scribe_generating');
    const s = setup({
      conversationId: 'parent-3',
      pendingConvRef: makeRef(null),
      activeWorkflowRef: makeRef<Workflow | null>(parent),
      hasGitHub: false, // gate would fire if branch logic was wrong
    });
    const { result } = renderSend(s);

    await act(async () => {
      await result.current('Iterate on the existing pipeline');
    });

    expect(s.setPendingGithubIdea).not.toHaveBeenCalled();
    expect(mockedSendMessage).toHaveBeenCalledTimes(1);
  });

  // ── (d) sendMessage branch + S-2 (refreshWorkflow return value) ──

  it('(d) sendMessage: reads currentStage from refreshWorkflow return (S-2, not the ref)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedSendMessage.mockResolvedValueOnce(undefined as any);
    // The ref is intentionally STALE (still says scribe_clarifying), but the
    // refreshed workflow returns proto_building — the new code must use the
    // returned value so the post-send info bubble matches the fresh stage.
    const refStale = buildWorkflow('p-1', 'scribe_clarifying');
    const fresh = buildWorkflow('p-1', 'proto_building');
    const s = setup({
      conversationId: 'p-1',
      pendingConvRef: makeRef(null),
      activeWorkflowRef: makeRef<Workflow | null>(refStale),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.refreshWorkflow.mockResolvedValueOnce(fresh as any);
    const { result } = renderSend(s);

    await act(async () => {
      await result.current('Note while pipeline is running');
    });

    expect(mockedSendMessage).toHaveBeenCalledWith('p-1', 'Note while pipeline is running', undefined);
    expect(s.refreshWorkflow).toHaveBeenCalled();
    // The info bubble's content must reflect the FRESH stage (proto_building),
    // not the stale ref (scribe_clarifying, which would suppress the bubble).
    expect(s.messages.at(-1)).toMatchObject({
      type: 'info',
      content: expect.stringMatching(/Proto kod üretimi/),
    });
  });

  it('(d) sendMessage: suppresses the info bubble for interactive stages (scribe_clarifying)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedSendMessage.mockResolvedValueOnce(undefined as any);
    const fresh = buildWorkflow('p-2', 'scribe_clarifying');
    const s = setup({
      conversationId: 'p-2',
      pendingConvRef: makeRef(null),
      activeWorkflowRef: makeRef<Workflow | null>(fresh),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.refreshWorkflow.mockResolvedValueOnce(fresh as any);
    const { result } = renderSend(s);

    await act(async () => {
      await result.current('A clarifying answer');
    });

    // Only the user bubble — no info bubble for scribe_clarifying / awaiting_approval.
    expect(s.messages.length).toBe(1);
    expect(s.messages[0]).toMatchObject({ type: 'user' });
  });

  it('(d) sendingRef prevents concurrent double-submits', async () => {
    // The first call resolves on a manually controlled promise so we can fire
    // a second call WHILE the first is in flight.
    let resolveSend: (() => void) | null = null;
    mockedSendMessage.mockImplementationOnce(
      () => new Promise<never>((res) => {
        resolveSend = () => res(undefined as never);
      }),
    );
    const fresh = buildWorkflow('p-3', 'proto_building');
    const s = setup({
      conversationId: 'p-3',
      pendingConvRef: makeRef(null),
      activeWorkflowRef: makeRef<Workflow | null>(fresh),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.refreshWorkflow.mockResolvedValue(fresh as any);
    const { result } = renderSend(s);

    let firstPromise: Promise<unknown> | undefined;
    act(() => {
      firstPromise = result.current('first send');
    });
    // Second call while the first is still in flight — should be a no-op.
    await act(async () => {
      await result.current('second send while inflight');
    });

    expect(mockedSendMessage).toHaveBeenCalledTimes(1);

    // Resolve the first send and let it settle.
    await act(async () => {
      resolveSend?.();
      await firstPromise;
    });
  });

  // ── Threads user image previews onto the user bubble (BUG-C) ──

  it('threads image attachments onto the user message bubble', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedSendMessage.mockResolvedValueOnce(undefined as any);
    const fresh = buildWorkflow('p-img', 'proto_building');
    const s = setup({
      conversationId: 'p-img',
      pendingConvRef: makeRef(null),
      activeWorkflowRef: makeRef<Workflow | null>(fresh),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.refreshWorkflow.mockResolvedValueOnce(fresh as any);
    const { result } = renderSend(s);

    const file = new File(['x'], 'logo.png', { type: 'image/png' });
    await act(async () => {
      await result.current('Look at this image', [
        { id: 'a1', file, preview: 'data:image/png;base64,xx', type: 'image' },
      ]);
    });

    const userMsg = s.messages.find((m) => m.type === 'user') as unknown as {
      type: 'user';
      images?: Array<{ id: string; name: string; previewUrl: string; mimeType: string }>;
    };
    expect(userMsg.images).toEqual([
      { id: 'a1', name: 'logo.png', previewUrl: 'data:image/png;base64,xx', mimeType: 'image/png' },
    ]);
  });

  // ── (b-error) iteration-child branch error path ──

  it('(b-error) iteration-child: shows error toast + retryable bubble when create rejects', async () => {
    mockedCreate.mockRejectedValueOnce(new Error('Server unavailable'));
    const parent = buildWorkflow('parent-err', 'completed', {
      protoRepo: 'octo/repo',
      protoBranch: 'feat/main',
    });
    const s = setup({
      conversationId: 'parent-err',
      pendingConvRef: makeRef(null),
      activeWorkflowRef: makeRef<Workflow | null>(parent),
    });
    const { result } = renderSend(s);

    await act(async () => {
      await result.current('Try again iteration');
    });

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(s.startIterationChildPoll).not.toHaveBeenCalled();
    expect(mockedToast).toHaveBeenCalledWith(expect.any(String), 'error');
    // Trailing retryable error bubble is appended; check messages contain one.
    const errorMsg = s.messages.find((m) => m.type === 'error') as unknown as
      | { type: 'error'; retryable: boolean; message: string }
      | undefined;
    expect(errorMsg?.retryable).toBe(true);
    expect(errorMsg?.message).toMatch(/İterasyon başlatılamadı/);
    // setCreating should be set false at the end of the finally block.
    expect(s.setCreating).toHaveBeenLastCalledWith(false);
  });

  // ── (d) document-attach branch ──

  it('(d-attach) indexes attached documents on a doc upload and toasts the parts count', async () => {
    const attachMod = await import('../../../../services/api/chatAttach');
    const mockedAttach = vi.mocked(attachMod.attachDocumentsToChat);
    mockedAttach.mockResolvedValueOnce({
      results: [
        {
          filename: 'a.md',
          documentId: 'd1',
          chunksCreated: 5,
          status: 'ok',
        },
      ],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedSendMessage.mockResolvedValueOnce(undefined as any);
    const fresh = buildWorkflow('p-attach', 'proto_building');
    const s = setup({
      conversationId: 'p-attach',
      pendingConvRef: makeRef(null),
      activeWorkflowRef: makeRef<Workflow | null>(fresh),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.refreshWorkflow.mockResolvedValueOnce(fresh as any);
    const { result } = renderSend(s);

    const file = new File(['hello'], 'a.md', { type: 'text/markdown' });
    await act(async () => {
      await result.current('with a doc', [
        { id: 'd-1', file, type: 'document' },
      ]);
    });

    expect(mockedAttach).toHaveBeenCalledWith('p-attach', [file]);
    // success toast — "1 dosya indexlendi (5 parça)"
    const successCalls = mockedToast.mock.calls.filter((c) => c[1] === 'success');
    expect(successCalls.length).toBeGreaterThanOrEqual(1);
    expect(String(successCalls[0][0])).toMatch(/1 dosya indexlendi.*5 parça/);
    // sendMessage still fires after the attach completes.
    expect(mockedSendMessage).toHaveBeenCalled();
  });

  it('(d-attach) toasts an info bubble for deduplicated documents', async () => {
    const attachMod = await import('../../../../services/api/chatAttach');
    const mockedAttach = vi.mocked(attachMod.attachDocumentsToChat);
    mockedAttach.mockResolvedValueOnce({
      results: [
        {
          filename: 'a.md',
          documentId: 'd1',
          chunksCreated: 0,
          status: 'ok',
          deduplicated: true,
        },
      ],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedSendMessage.mockResolvedValueOnce(undefined as any);
    const fresh = buildWorkflow('p-dedup', 'proto_building');
    const s = setup({
      conversationId: 'p-dedup',
      pendingConvRef: makeRef(null),
      activeWorkflowRef: makeRef<Workflow | null>(fresh),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.refreshWorkflow.mockResolvedValueOnce(fresh as any);
    const { result } = renderSend(s);

    const file = new File(['hello'], 'a.md', { type: 'text/markdown' });
    await act(async () => {
      await result.current('with dedup doc', [
        { id: 'd-1', file, type: 'document' },
      ]);
    });

    const infoCalls = mockedToast.mock.calls.filter((c) => c[1] === 'info');
    expect(infoCalls.length).toBeGreaterThanOrEqual(1);
    expect(String(infoCalls[0][0])).toMatch(/zaten indexliydi/);
  });

  it('(d-attach) toasts an error for quota-exceeded documents', async () => {
    const attachMod = await import('../../../../services/api/chatAttach');
    const mockedAttach = vi.mocked(attachMod.attachDocumentsToChat);
    mockedAttach.mockResolvedValueOnce({
      results: [
        {
          filename: 'huge.md',
          documentId: 'd1',
          chunksCreated: 0,
          status: 'quota_exceeded',
        },
        {
          filename: 'bad.md',
          documentId: 'd2',
          chunksCreated: 0,
          status: 'error',
        },
      ],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedSendMessage.mockResolvedValueOnce(undefined as any);
    const fresh = buildWorkflow('p-quota', 'proto_building');
    const s = setup({
      conversationId: 'p-quota',
      pendingConvRef: makeRef(null),
      activeWorkflowRef: makeRef<Workflow | null>(fresh),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.refreshWorkflow.mockResolvedValueOnce(fresh as any);
    const { result } = renderSend(s);

    const file1 = new File(['x'.repeat(100)], 'huge.md', { type: 'text/markdown' });
    const file2 = new File(['y'], 'bad.md', { type: 'text/markdown' });
    await act(async () => {
      await result.current('with quota/error docs', [
        { id: 'q-1', file: file1, type: 'document' },
        { id: 'q-2', file: file2, type: 'document' },
      ]);
    });

    const errorToasts = mockedToast.mock.calls.filter((c) => c[1] === 'error');
    // Two error toasts — one for quota_exceeded and one for the failed file.
    expect(errorToasts.length).toBeGreaterThanOrEqual(2);
    expect(errorToasts.some((c) => String(c[0]).includes('100 parça'))).toBe(true);
    expect(errorToasts.some((c) => String(c[0]).includes('indexlenemedi'))).toBe(true);
  });

  it('(d-attach) recovers and still sends the message when attachDocumentsToChat rejects', async () => {
    const attachMod = await import('../../../../services/api/chatAttach');
    const mockedAttach = vi.mocked(attachMod.attachDocumentsToChat);
    mockedAttach.mockRejectedValueOnce(new Error('upload backend down'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedSendMessage.mockResolvedValueOnce(undefined as any);
    const fresh = buildWorkflow('p-attach-err', 'proto_building');
    const s = setup({
      conversationId: 'p-attach-err',
      pendingConvRef: makeRef(null),
      activeWorkflowRef: makeRef<Workflow | null>(fresh),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.refreshWorkflow.mockResolvedValueOnce(fresh as any);
    const { result } = renderSend(s);

    const file = new File(['x'], 'a.md', { type: 'text/markdown' });
    await act(async () => {
      await result.current('msg with broken attach', [
        { id: 'd', file, type: 'document' },
      ]);
    });

    // The attach-failed error toast fires non-fatally...
    const errToasts = mockedToast.mock.calls.filter((c) => c[1] === 'error');
    expect(errToasts.some((c) => String(c[0]).includes('Dosya indexleme başarısız'))).toBe(true);
    // ...and the message still goes through.
    expect(mockedSendMessage).toHaveBeenCalledTimes(1);
  });

  // ── (d-error) sendMessage error path ──

  it('(d-error) sendMessage: swallows errors silently (no toast, no error bubble)', async () => {
    // The hook intentionally swallows the sendMessage error (see line 281) so
    // a transient backend hiccup doesn't blow up the chat UI mid-flow. We just
    // assert the catch-block prevents the post-send info bubble.
    mockedSendMessage.mockRejectedValueOnce(new Error('500'));
    const fresh = buildWorkflow('p-snd-err', 'proto_building');
    const s = setup({
      conversationId: 'p-snd-err',
      pendingConvRef: makeRef(null),
      activeWorkflowRef: makeRef<Workflow | null>(fresh),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.refreshWorkflow.mockResolvedValueOnce(fresh as any);
    const { result } = renderSend(s);

    await act(async () => {
      await result.current('Note that explodes server-side');
    });

    expect(mockedSendMessage).toHaveBeenCalledTimes(1);
    // refreshWorkflow + the post-send info bubble are reached only via the try
    // branch — the catch should skip them.
    expect(s.refreshWorkflow).not.toHaveBeenCalled();
    // Only the user bubble is present.
    expect(s.messages.length).toBe(1);
    expect(s.messages[0]).toMatchObject({ type: 'user' });
  });

  // ── refreshWorkflow returns null fallback ──

  it('(d) falls back to activeWorkflowRef.currentStage when refreshWorkflow returns null', async () => {
    // S-2 says the fresh stage should come from the refreshWorkflow return
    // value, but if that returns null the hook should still fall back to the
    // ref so the post-send info bubble has a stage to render against.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedSendMessage.mockResolvedValueOnce(undefined as any);
    const fresh = buildWorkflow('p-null', 'trace_testing');
    const s = setup({
      conversationId: 'p-null',
      pendingConvRef: makeRef(null),
      activeWorkflowRef: makeRef<Workflow | null>(fresh),
    });
    s.refreshWorkflow.mockResolvedValueOnce(null);
    const { result } = renderSend(s);

    await act(async () => {
      await result.current('Note while running trace');
    });

    expect(s.messages.at(-1)).toMatchObject({
      type: 'info',
      content: expect.stringMatching(/Trace test yazımı/),
    });
  });
});
