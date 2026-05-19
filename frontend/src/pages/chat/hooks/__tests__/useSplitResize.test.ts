import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSplitResize } from '../useSplitResize';

describe('useSplitResize', () => {
  it('calls setPointerCapture on pointerdown', () => {
    const setPreviewWidth = vi.fn();
    const { result } = renderHook(() => useSplitResize({ setPreviewWidth }));

    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    const target = { setPointerCapture, releasePointerCapture } as unknown as HTMLElement;

    const downEvent = {
      pointerId: 7,
      currentTarget: target,
      preventDefault: vi.fn(),
    } as unknown as React.PointerEvent;

    act(() => {
      result.current.handleDragStart(downEvent);
    });

    expect(setPointerCapture).toHaveBeenCalledWith(7);
  });

  it('exposes pointer move + end handlers', () => {
    const setPreviewWidth = vi.fn();
    const { result } = renderHook(() =>
      useSplitResize({ setPreviewWidth, minPercent: 25, maxPercent: 70 })
    );
    expect(result.current.handleDragStart).toBeTypeOf('function');
    expect(result.current.handleDragMove).toBeTypeOf('function');
    expect(result.current.handleDragEnd).toBeTypeOf('function');
  });
});
