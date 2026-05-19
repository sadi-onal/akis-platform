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

  // ─── PR-V1 edge-case regression tests (test sweep, 2026-05-19) ─────────
  //
  // The fix routed mouse handling through Pointer Events + setPointerCapture
  // so a mouseup landing over the Sandpack iframe still reached the handle.
  // The following tests guard the contract around the captured pointerId
  // (which is the load-bearing piece of the fix — a stray secondary pointer
  // moving across the handle must not steal the drag).
  describe('PR-V1 — captured-pointer contract', () => {
    function mkTarget() {
      return {
        setPointerCapture: vi.fn(),
        releasePointerCapture: vi.fn(),
      } as unknown as HTMLElement;
    }

    function pointerEvent(
      pointerId: number,
      target: HTMLElement,
      clientX: number = 0
    ): React.PointerEvent {
      return {
        pointerId,
        currentTarget: target,
        clientX,
        preventDefault: () => undefined,
      } as unknown as React.PointerEvent;
    }

    it('ignores move events whose pointerId does not match the captured pointer (touch + mouse interleave)', () => {
      const setPreviewWidth = vi.fn();
      const { result } = renderHook(() => useSplitResize({ setPreviewWidth }));
      const target = mkTarget();
      // Attach a real bounding rect via the splitContainerRef.
      const splitEl = document.createElement('div');
      splitEl.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        right: 1000,
        bottom: 800,
        width: 1000,
        height: 800,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      // @ts-expect-error — assigning to RefObject in test
      result.current.splitContainerRef.current = splitEl;

      act(() => {
        result.current.handleDragStart(pointerEvent(7, target));
      });

      // A second pointer (stray touch, mouse-while-touching) emits move
      // with a DIFFERENT pointerId. The hook must ignore it — otherwise
      // a hovering finger could yank the divider mid-drag.
      act(() => {
        result.current.handleDragMove(pointerEvent(99, target, 200));
      });
      expect(setPreviewWidth).not.toHaveBeenCalled();

      // Original pointerId still works.
      act(() => {
        result.current.handleDragMove(pointerEvent(7, target, 200));
      });
      expect(setPreviewWidth).toHaveBeenCalled();
    });

    it('ignores end events whose pointerId does not match — drag remains active', () => {
      const setPreviewWidth = vi.fn();
      const { result } = renderHook(() => useSplitResize({ setPreviewWidth }));
      const target = mkTarget();
      const splitEl = document.createElement('div');
      splitEl.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        right: 1000,
        bottom: 800,
        width: 1000,
        height: 800,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      // @ts-expect-error — RefObject test assignment
      result.current.splitContainerRef.current = splitEl;

      act(() => {
        result.current.handleDragStart(pointerEvent(7, target));
      });
      expect(document.body.style.cursor).toBe('col-resize');

      // Stray pointerup from a different pointer must NOT end the real drag.
      act(() => {
        result.current.handleDragEnd(pointerEvent(99, target));
      });
      // Body cursor is still locked — drag remains active.
      expect(document.body.style.cursor).toBe('col-resize');
      expect(
        (target as unknown as { releasePointerCapture: ReturnType<typeof vi.fn> })
          .releasePointerCapture
      ).not.toHaveBeenCalled();

      // Original pointer can still end the drag normally.
      act(() => {
        result.current.handleDragEnd(pointerEvent(7, target));
      });
      expect(document.body.style.cursor).toBe('');
    });

    it('handleDragMove with no drag in progress is a no-op (defensive)', () => {
      const setPreviewWidth = vi.fn();
      const { result } = renderHook(() => useSplitResize({ setPreviewWidth }));
      const target = mkTarget();
      // No handleDragStart called — but a stray pointermove still arrives.
      act(() => {
        result.current.handleDragMove(pointerEvent(1, target, 200));
      });
      expect(setPreviewWidth).not.toHaveBeenCalled();
    });

    it('handleDragMove is a no-op when splitContainerRef.current is null (defensive)', () => {
      const setPreviewWidth = vi.fn();
      const { result } = renderHook(() => useSplitResize({ setPreviewWidth }));
      const target = mkTarget();
      // splitContainerRef.current is null by default; start a drag but leave
      // the ref unattached — move should not crash and should not call setter.
      act(() => {
        result.current.handleDragStart(pointerEvent(1, target));
      });
      act(() => {
        result.current.handleDragMove(pointerEvent(1, target, 500));
      });
      expect(setPreviewWidth).not.toHaveBeenCalled();
      // Clean up so the body cursor is restored.
      act(() => {
        result.current.handleDragEnd(pointerEvent(1, target));
      });
    });

    it('handleDragEnd swallows a releasePointerCapture throw (lost-pointer recovery)', () => {
      // Defensive: when the page loses focus mid-drag, browsers throw
      // InvalidStateError on releasePointerCapture. The hook must still
      // restore body styles and clear its drag flag.
      const setPreviewWidth = vi.fn();
      const { result } = renderHook(() => useSplitResize({ setPreviewWidth }));
      const target = {
        setPointerCapture: vi.fn(),
        releasePointerCapture: vi.fn(() => {
          throw new Error('InvalidStateError: pointer not captured');
        }),
      } as unknown as HTMLElement;

      act(() => {
        result.current.handleDragStart(pointerEvent(1, target));
      });
      expect(document.body.style.cursor).toBe('col-resize');

      // Must not throw, must restore body styles regardless.
      expect(() => {
        act(() => {
          result.current.handleDragEnd(pointerEvent(1, target));
        });
      }).not.toThrow();
      expect(document.body.style.cursor).toBe('');
      expect(document.body.style.userSelect).toBe('');
    });

    it('unmount when no drag is active does NOT touch body styles', () => {
      // Guard: the cleanup branch is conditional on `isDraggingRef.current`.
      // Unmounting an idle hook must not stomp on someone else's body cursor.
      document.body.style.cursor = 'wait';
      document.body.style.userSelect = 'text';
      const setPreviewWidth = vi.fn();
      const { unmount } = renderHook(() => useSplitResize({ setPreviewWidth }));
      unmount();
      // Body styles are untouched — leftover from the surrounding app.
      expect(document.body.style.cursor).toBe('wait');
      expect(document.body.style.userSelect).toBe('text');
      // Cleanup so we don't bleed into the next test.
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  });
});
