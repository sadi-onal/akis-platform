/**
 * Tests for the proto-files resolver. The hook merges two sources:
 *   - the active workflow's `proto_result` conversation message (preferred)
 *   - `workflowsApi.getProtoFiles(id)` (fallback for terminal stages)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import { useProtoFiles } from '../useProtoFiles';
import type { Workflow } from '../../../../types/workflow';

vi.mock('../../../../services/api/workflows', () => ({
  workflowsApi: {
    getProtoFiles: vi.fn(),
  },
}));

import { workflowsApi } from '../../../../services/api/workflows';

const mockedGetProtoFiles = vi.mocked(workflowsApi.getProtoFiles);

function makeWorkflow(over: Partial<Workflow> = {}): Workflow {
  // Minimal cast so the test stays focused — the hook only reads
  // `conversation` + `currentStage` and never the rest.
  return {
    id: 'wf-1',
    title: 'Test',
    status: 'completed',
    currentStage: 'completed',
    stages: { proto: {} },
    conversation: [],
    ...over,
  } as unknown as Workflow;
}

describe('useProtoFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no conversation and no API fallback (non-terminal stage)', () => {
    const wf = makeWorkflow({ currentStage: 'scribe_clarifying', conversation: [] });
    const { result } = renderHook(() =>
      useProtoFiles({ conversationId: 'wf-1', activeWorkflow: wf })
    );
    expect(result.current).toBeNull();
    expect(mockedGetProtoFiles).not.toHaveBeenCalled();
  });

  it('extracts proto_result.files from the conversation when present', () => {
    const wf = makeWorkflow({
      conversation: [
        {
          type: 'proto_result',
          protoResult: {
            files: [{ path: 'src/index.ts', content: 'export const x = 1;' }],
          },
        },
      ] as unknown as Workflow['conversation'],
    });
    const { result } = renderHook(() =>
      useProtoFiles({ conversationId: 'wf-1', activeWorkflow: wf })
    );
    expect(result.current).toEqual({ 'src/index.ts': 'export const x = 1;' });
    expect(mockedGetProtoFiles).not.toHaveBeenCalled();
  });

  it('falls back to workflowsApi.getProtoFiles when conversation has no proto_result and stage is terminal', async () => {
    mockedGetProtoFiles.mockResolvedValue({ 'a.ts': 'a' });
    const wf = makeWorkflow({ currentStage: 'completed', conversation: [] });
    const { result } = renderHook(() =>
      useProtoFiles({ conversationId: 'wf-1', activeWorkflow: wf })
    );

    await waitFor(() => expect(result.current).toEqual({ 'a.ts': 'a' }));
    expect(mockedGetProtoFiles).toHaveBeenCalledWith('wf-1');
  });

  it('does not call the API for non-terminal stages', () => {
    const wf = makeWorkflow({ currentStage: 'scribe_clarifying', conversation: [] });
    renderHook(() => useProtoFiles({ conversationId: 'wf-1', activeWorkflow: wf }));
    expect(mockedGetProtoFiles).not.toHaveBeenCalled();
  });

  it('triggers API for completed_partial', () => {
    mockedGetProtoFiles.mockResolvedValue({ 'b.ts': 'b' });
    const wf = makeWorkflow({ currentStage: 'completed_partial', conversation: [] });
    renderHook(() => useProtoFiles({ conversationId: 'wf-1', activeWorkflow: wf }));
    expect(mockedGetProtoFiles).toHaveBeenCalledWith('wf-1');
  });

  it('triggers API for trace_testing', () => {
    mockedGetProtoFiles.mockResolvedValue({ 'c.ts': 'c' });
    const wf = makeWorkflow({ currentStage: 'trace_testing', conversation: [] });
    renderHook(() => useProtoFiles({ conversationId: 'wf-1', activeWorkflow: wf }));
    expect(mockedGetProtoFiles).toHaveBeenCalledWith('wf-1');
  });

  it('ignores empty API responses', async () => {
    mockedGetProtoFiles.mockResolvedValue({});
    const wf = makeWorkflow({ currentStage: 'completed', conversation: [] });
    const { result } = renderHook(() =>
      useProtoFiles({ conversationId: 'wf-1', activeWorkflow: wf })
    );
    await waitFor(() => expect(mockedGetProtoFiles).toHaveBeenCalled());
    // Empty object is treated as "no fallback" — protoFiles stays null.
    expect(result.current).toBeNull();
  });

  it('swallows API errors silently (returns null)', async () => {
    mockedGetProtoFiles.mockRejectedValue(new Error('500'));
    const wf = makeWorkflow({ currentStage: 'completed', conversation: [] });
    const { result } = renderHook(() =>
      useProtoFiles({ conversationId: 'wf-1', activeWorkflow: wf })
    );
    await waitFor(() => expect(mockedGetProtoFiles).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('skips API call when conversationId is undefined', () => {
    const wf = makeWorkflow({ currentStage: 'completed', conversation: [] });
    renderHook(() => useProtoFiles({ conversationId: undefined, activeWorkflow: wf }));
    expect(mockedGetProtoFiles).not.toHaveBeenCalled();
  });

  // Bulgu F — stale preview drawer.
  it('clears API cache when conversationId changes (no stale files from prior pipeline)', async () => {
    mockedGetProtoFiles.mockResolvedValueOnce({ 'old.ts': 'old' });
    const wfOld = makeWorkflow({ currentStage: 'completed', conversation: [] });
    const wfNew = makeWorkflow({
      id: 'wf-2',
      currentStage: 'scribe_clarifying',
      conversation: [],
    });

    const { result, rerender } = renderHook(
      ({ id, wf }: { id: string; wf: Workflow }) =>
        useProtoFiles({ conversationId: id, activeWorkflow: wf }),
      { initialProps: { id: 'wf-1', wf: wfOld } }
    );

    await waitFor(() => expect(result.current).toEqual({ 'old.ts': 'old' }));

    rerender({ id: 'wf-2', wf: wfNew });
    expect(result.current).toBeNull();
  });

  it('clears API cache when pipeline re-enters a build stage (iterate scenario)', async () => {
    mockedGetProtoFiles.mockResolvedValueOnce({ 'old.ts': 'old' });
    const wfReady = makeWorkflow({
      currentStage: 'awaiting_push_confirm',
      conversation: [],
    });
    const wfIterating = makeWorkflow({
      currentStage: 'proto_building',
      conversation: [],
    });

    const { result, rerender } = renderHook(
      ({ wf }: { wf: Workflow }) => useProtoFiles({ conversationId: 'wf-1', activeWorkflow: wf }),
      { initialProps: { wf: wfReady } }
    );

    await waitFor(() => expect(result.current).toEqual({ 'old.ts': 'old' }));

    rerender({ wf: wfIterating });
    expect(result.current).toBeNull();
  });
});
