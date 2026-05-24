import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePipelineStream, type PipelineActivity } from '../usePipelineStream';

class MockEventSource {
  static instances: MockEventSource[] = [];

  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  emitOpen() {
    this.onopen?.();
  }

  emitMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

const makeActivity = (overrides: Partial<PipelineActivity> = {}): PipelineActivity => ({
  pipelineId: 'p-1',
  stage: 'proto',
  step: 'gate_open',
  message: 'Preview gate opened',
  progress: 100,
  timestamp: '2026-05-24T20:00:02.000Z',
  ...overrides,
});

describe('usePipelineStream', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ activities: [] }),
      }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the stream open when the pipeline is paused at a gate', async () => {
    const { result, unmount } = renderHook(() => usePipelineStream('p-1', false));

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    const es = MockEventSource.instances[0]!;
    expect(es.url).toBe('/api/pipelines/p-1/stream');
    expect(es.close).not.toHaveBeenCalled();

    act(() => {
      es.emitOpen();
      es.emitMessage(makeActivity());
    });

    expect(result.current.isConnected).toBe(true);
    expect(result.current.currentStep?.step).toBe('gate_open');
    expect(result.current.activities).toHaveLength(1);

    unmount();
    expect(es.close).toHaveBeenCalledTimes(1);
  });

  it('closes the previous stream only when the pipeline id changes', async () => {
    const { rerender } = renderHook(({ id }) => usePipelineStream(id, true), {
      initialProps: { id: 'p-1' },
    });

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });
    const first = MockEventSource.instances[0]!;

    rerender({ id: 'p-2' });

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(2);
    });
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(MockEventSource.instances[1]!.url).toBe('/api/pipelines/p-2/stream');
  });
});
