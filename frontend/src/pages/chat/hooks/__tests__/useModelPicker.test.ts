/**
 * Tests for the model-picker hook. Covers the three behaviors moved out of
 * ChatPage:
 *   1. Default model = haiku (the alias used everywhere in ChatPage today).
 *   2. Pre-pipeline change (`setPendingModel`) updates state without an API
 *      call.
 *   3. Post-pipeline change (`handleModelChange`) invokes `workflowsApi.updateModel`
 *      + `refreshWorkflow` and surfaces a toast.
 *   4. The pre-pipeline guard (`conversationId === 'pending'`) prevents the
 *      API call.
 *   5. Errors localize and toast as `error` rather than throwing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useModelPicker } from '../useModelPicker';

vi.mock('../../../../services/api/workflows', () => ({
  workflowsApi: {
    updateModel: vi.fn(),
  },
}));
vi.mock('../../../../components/ui/Toast', () => ({
  toast: vi.fn(),
}));

import { workflowsApi } from '../../../../services/api/workflows';
import { toast } from '../../../../components/ui/Toast';

const mockedUpdateModel = vi.mocked(workflowsApi.updateModel);
const mockedToast = vi.mocked(toast);

describe('useModelPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults pendingModel to claude-haiku-4-5-20251001', () => {
    const { result } = renderHook(() =>
      useModelPicker({
        conversationId: undefined,
        activeWorkflow: null,
        refreshWorkflow: vi.fn(),
      }),
    );
    expect(result.current.pendingModel).toBe('claude-haiku-4-5-20251001');
  });

  it('respects an explicit initialModel', () => {
    const { result } = renderHook(() =>
      useModelPicker({
        conversationId: undefined,
        activeWorkflow: null,
        refreshWorkflow: vi.fn(),
        initialModel: 'claude-sonnet-4-5',
      }),
    );
    expect(result.current.pendingModel).toBe('claude-sonnet-4-5');
  });

  it('setPendingModel updates pendingModel without network calls (pre-pipeline)', () => {
    const { result } = renderHook(() =>
      useModelPicker({
        conversationId: undefined,
        activeWorkflow: null,
        refreshWorkflow: vi.fn(),
      }),
    );
    act(() => result.current.setPendingModel('claude-opus-4-7'));
    expect(result.current.pendingModel).toBe('claude-opus-4-7');
    expect(mockedUpdateModel).not.toHaveBeenCalled();
  });

  it('handleModelChange no-ops when conversationId is undefined', async () => {
    const refreshWorkflow = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useModelPicker({
        conversationId: undefined,
        activeWorkflow: null,
        refreshWorkflow,
      }),
    );
    await act(async () => {
      await result.current.handleModelChange('claude-sonnet-4-5');
    });
    expect(mockedUpdateModel).not.toHaveBeenCalled();
    expect(refreshWorkflow).not.toHaveBeenCalled();
  });

  it("handleModelChange no-ops when conversationId === 'pending'", async () => {
    const refreshWorkflow = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useModelPicker({
        conversationId: 'pending',
        activeWorkflow: null,
        refreshWorkflow,
      }),
    );
    await act(async () => {
      await result.current.handleModelChange('claude-sonnet-4-5');
    });
    expect(mockedUpdateModel).not.toHaveBeenCalled();
  });

  it('handleModelChange calls workflowsApi.updateModel + refreshWorkflow + toast on success', async () => {
    mockedUpdateModel.mockResolvedValue({} as never);
    const refreshWorkflow = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useModelPicker({
        conversationId: 'wf-123',
        activeWorkflow: null,
        refreshWorkflow,
      }),
    );

    await act(async () => {
      await result.current.handleModelChange('claude-sonnet-4-5');
    });

    expect(mockedUpdateModel).toHaveBeenCalledWith('wf-123', 'claude-sonnet-4-5');
    expect(refreshWorkflow).toHaveBeenCalledTimes(1);
    expect(mockedToast).toHaveBeenCalledWith(
      expect.stringContaining('claude-sonnet-4-5'),
      'info',
    );
  });

  it('handleModelChange surfaces an error toast when updateModel rejects (does not throw)', async () => {
    mockedUpdateModel.mockRejectedValue(new Error('boom'));
    const refreshWorkflow = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useModelPicker({
        conversationId: 'wf-123',
        activeWorkflow: null,
        refreshWorkflow,
      }),
    );

    await act(async () => {
      await result.current.handleModelChange('claude-sonnet-4-5');
    });

    expect(refreshWorkflow).not.toHaveBeenCalled();
    expect(mockedToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });
});
