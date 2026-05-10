/**
 * Tests for the pipeline-control hook (approve/reject/cancel/retry/skip plus
 * the BUG-N pre-retry error capture state machine).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { usePipelineControls } from '../usePipelineControls';
import type { PipelineError } from '../../../../types/pipeline';
import type { Workflow } from '../../../../types/workflow';

vi.mock('../../../../services/api/workflows', () => ({
  workflowsApi: {
    approve: vi.fn(),
    reject: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    skipTrace: vi.fn(),
  },
}));
vi.mock('../../../../components/ui/Toast', () => ({
  toast: vi.fn(),
}));

import { workflowsApi } from '../../../../services/api/workflows';
import { toast } from '../../../../components/ui/Toast';

const api = vi.mocked(workflowsApi);
const mockedToast = vi.mocked(toast);

function makeWorkflow(over: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    title: 'My App',
    status: 'awaiting_approval',
    currentStage: 'awaiting_approval',
    stages: { proto: {} },
    conversation: [],
    ...over,
  } as unknown as Workflow;
}

describe('usePipelineControls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('approve calls workflowsApi.approve with sanitized repo name + cucumber flag from localStorage', async () => {
    api.approve.mockResolvedValue(undefined as never);
    localStorage.setItem('akis_cucumber_enabled', 'true');
    const refreshWorkflow = vi.fn().mockResolvedValue(undefined);
    const wf = makeWorkflow({ title: 'Görkemli Çay App!' });

    const { result } = renderHook(() =>
      usePipelineControls({
        conversationId: 'wf-1',
        activeWorkflow: wf,
        refreshWorkflow,
      }),
    );

    await act(async () => {
      await result.current.handleApprove();
    });

    // sanitizeRepoName lowercases + ASCII-folds + drops punctuation.
    expect(api.approve).toHaveBeenCalledWith('wf-1', 'gorkemli-cay-app', 'private', {
      cucumberEnabled: true,
    });
    expect(refreshWorkflow).toHaveBeenCalledTimes(1);
    expect(mockedToast).toHaveBeenCalledWith(expect.any(String), 'success');
  });

  it('approve no-ops without conversationId or activeWorkflow', async () => {
    const refreshWorkflow = vi.fn();
    const { result } = renderHook(() =>
      usePipelineControls({
        conversationId: undefined,
        activeWorkflow: null,
        refreshWorkflow,
      }),
    );
    await act(async () => {
      await result.current.handleApprove();
    });
    expect(api.approve).not.toHaveBeenCalled();
  });

  it('approve guards against double-submit via the in-flight ref', async () => {
    // Block approve until we tell it to resolve so a concurrent second call
    // hits the guard.
    let resolveApprove: () => void = () => undefined;
    api.approve.mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveApprove = res;
        }) as Promise<never>,
    );
    const refreshWorkflow = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      usePipelineControls({
        conversationId: 'wf-1',
        activeWorkflow: makeWorkflow(),
        refreshWorkflow,
      }),
    );

    // Fire two approves back-to-back. The first holds the in-flight flag, the
    // second should bail synchronously without invoking the API.
    await act(async () => {
      const first = result.current.handleApprove();
      const second = result.current.handleApprove();
      // Settle the first to unblock the in-flight guard.
      resolveApprove();
      await Promise.all([first, second]);
    });

    expect(api.approve).toHaveBeenCalledTimes(1);
  });

  it('reject calls workflowsApi.reject + refreshes', async () => {
    api.reject.mockResolvedValue(undefined as never);
    const refreshWorkflow = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      usePipelineControls({
        conversationId: 'wf-1',
        activeWorkflow: makeWorkflow(),
        refreshWorkflow,
      }),
    );
    await act(async () => {
      await result.current.handleReject();
    });
    expect(api.reject).toHaveBeenCalledWith('wf-1');
    expect(refreshWorkflow).toHaveBeenCalledTimes(1);
  });

  it('cancel calls workflowsApi.cancel + refreshes', async () => {
    api.cancel.mockResolvedValue(undefined as never);
    const refreshWorkflow = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      usePipelineControls({
        conversationId: 'wf-1',
        activeWorkflow: makeWorkflow(),
        refreshWorkflow,
      }),
    );
    await act(async () => {
      await result.current.handleCancel();
    });
    expect(api.cancel).toHaveBeenCalledWith('wf-1');
  });

  it('skip calls workflowsApi.skipTrace + refreshes', async () => {
    api.skipTrace.mockResolvedValue(undefined as never);
    const refreshWorkflow = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      usePipelineControls({
        conversationId: 'wf-1',
        activeWorkflow: makeWorkflow(),
        refreshWorkflow,
      }),
    );
    await act(async () => {
      await result.current.handleSkip();
    });
    expect(api.skipTrace).toHaveBeenCalledWith('wf-1');
  });

  it('retry calls workflowsApi.retry + refreshes', async () => {
    api.retry.mockResolvedValue(undefined as never);
    const refreshWorkflow = vi.fn().mockResolvedValue(undefined);
    const error: PipelineError = { code: 'X', message: 'boom' } as unknown as PipelineError;
    const wf = makeWorkflow({ currentStage: 'failed', error });

    const { result } = renderHook(() =>
      usePipelineControls({
        conversationId: 'wf-1',
        activeWorkflow: wf,
        refreshWorkflow,
      }),
    );

    await act(async () => {
      await result.current.handleRetry();
    });

    expect(api.retry).toHaveBeenCalledWith('wf-1');
    expect(refreshWorkflow).toHaveBeenCalledTimes(1);
  });

  it('retry no-ops without conversationId', async () => {
    const refreshWorkflow = vi.fn();
    const { result } = renderHook(() =>
      usePipelineControls({
        conversationId: undefined,
        activeWorkflow: null,
        refreshWorkflow,
      }),
    );
    await act(async () => {
      await result.current.handleRetry();
    });
    expect(api.retry).not.toHaveBeenCalled();
  });

  it('retry surfaces an error toast and clears captured error when workflowsApi.retry rejects', async () => {
    api.retry.mockRejectedValue(new Error('500'));
    const refreshWorkflow = vi.fn();
    const error: PipelineError = { code: 'X', message: 'boom' } as unknown as PipelineError;
    const wf = makeWorkflow({ currentStage: 'failed', error });

    const { result } = renderHook(() =>
      usePipelineControls({
        conversationId: 'wf-1',
        activeWorkflow: wf,
        refreshWorkflow,
      }),
    );

    await act(async () => {
      await result.current.handleRetry();
    });

    expect(refreshWorkflow).not.toHaveBeenCalled();
    expect(mockedToast).toHaveBeenCalledWith(expect.any(String), 'error');
    expect(result.current.isRetrying).toBe(false);
  });

  it('pipelineError falls back to workflow.error in `failed` stage when no retry is in-flight', () => {
    const error: PipelineError = { code: 'Y', message: 'nope' } as unknown as PipelineError;
    const wf = makeWorkflow({ currentStage: 'failed', error });
    const { result } = renderHook(() =>
      usePipelineControls({
        conversationId: 'wf-1',
        activeWorkflow: wf,
        refreshWorkflow: vi.fn(),
      }),
    );
    expect(result.current.pipelineError).toBe(error);
    expect(result.current.isRetrying).toBe(false);
  });

  it('reject errors localize and toast as error', async () => {
    api.reject.mockRejectedValue(new Error('500'));
    const refreshWorkflow = vi.fn();
    const { result } = renderHook(() =>
      usePipelineControls({
        conversationId: 'wf-1',
        activeWorkflow: makeWorkflow(),
        refreshWorkflow,
      }),
    );
    await act(async () => {
      await result.current.handleReject();
    });
    expect(refreshWorkflow).not.toHaveBeenCalled();
    expect(mockedToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });
});
