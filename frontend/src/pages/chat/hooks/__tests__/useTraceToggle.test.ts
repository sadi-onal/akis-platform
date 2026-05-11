import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useTraceToggle } from '../useTraceToggle';

describe('useTraceToggle', () => {
  it('defaults traceEnabled to true', () => {
    const { result } = renderHook(() => useTraceToggle());
    expect(result.current.traceEnabled).toBe(true);
  });

  it('respects an explicit initial value', () => {
    const { result } = renderHook(() => useTraceToggle(false));
    expect(result.current.traceEnabled).toBe(false);
  });

  it('flips traceEnabled via setTraceEnabled(false)', () => {
    const { result } = renderHook(() => useTraceToggle());
    act(() => result.current.setTraceEnabled(false));
    expect(result.current.traceEnabled).toBe(false);
  });

  it('flips traceEnabled back to true', () => {
    const { result } = renderHook(() => useTraceToggle(false));
    act(() => result.current.setTraceEnabled(true));
    expect(result.current.traceEnabled).toBe(true);
  });
});
