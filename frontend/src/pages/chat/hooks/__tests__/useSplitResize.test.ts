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

  it('clears body styles on unmount if drag is active', () => {
    const setPreviewWidth = vi.fn();
    const { result, unmount } = renderHook(() => useSplitResize({ setPreviewWidth }));

    const target = {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    } as unknown as HTMLElement;

    act(() => {
      result.current.handleDragStart({
        pointerId: 1,
        currentTarget: target,
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
    });

    expect(document.body.style.cursor).toBe('col-resize');

    unmount();

    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });
});
