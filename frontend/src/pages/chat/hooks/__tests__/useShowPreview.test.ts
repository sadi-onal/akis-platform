/**
 * Tests for the chat/preview split-pane hook. Covers:
 *   1. Defaults: hidden by default, 50% width.
 *   2. Toggling visibility.
 *   3. Drag updates `previewWidth` and clamps to the 25–70% bounds.
 *   4. Drag stops updating after pointerup.
 *
 * PR-V1 (2026-05-19): rewired to Pointer Events + setPointerCapture so that
 * mouseup over the Sandpack iframe still reaches the handle. Tests now drive
 * the hook via the three React synthetic-event handlers it returns.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useShowPreview } from '../useShowPreview';

// `getBoundingClientRect` is undefined for synthetic divs in jsdom — stub one
// onto the element the hook will read. Width = 1000 lets us reason about
// percent maths with simple numbers.
function attachContainerRect(ref: { current: HTMLDivElement | null }, rect: Partial<DOMRect>) {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 1000,
    bottom: 800,
    width: 1000,
    height: 800,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...rect,
  });
  // @ts-expect-error — assigning to RefObject during the test is intentional.
  ref.current = el;
}

function makePointerTarget() {
  return {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  } as unknown as HTMLElement;
}

function pointerEvent(pointerId: number, target: HTMLElement, clientX: number): React.PointerEvent {
  return {
    pointerId,
    currentTarget: target,
    clientX,
    preventDefault: () => undefined,
  } as unknown as React.PointerEvent;
}

describe('useShowPreview', () => {
  beforeEach(() => {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  it('defaults showPreview=false and previewWidth=50', () => {
    const { result } = renderHook(() => useShowPreview());
    expect(result.current.showPreview).toBe(false);
    expect(result.current.previewWidth).toBe(50);
  });

  it('respects explicit initial values', () => {
    const { result } = renderHook(() =>
      useShowPreview({ initialShowPreview: true, initialPreviewWidth: 60 })
    );
    expect(result.current.showPreview).toBe(true);
    expect(result.current.previewWidth).toBe(60);
  });

  it('setShowPreview toggles visibility', () => {
    const { result } = renderHook(() => useShowPreview());
    act(() => result.current.setShowPreview(true));
    expect(result.current.showPreview).toBe(true);
    act(() => result.current.setShowPreview((prev) => !prev));
    expect(result.current.showPreview).toBe(false);
  });

  it('drag updates previewWidth based on pointer position', () => {
    const { result } = renderHook(() => useShowPreview());
    attachContainerRect(result.current.splitContainerRef, { right: 1000, width: 1000 });
    const target = makePointerTarget();

    act(() => {
      result.current.handleDragStart(pointerEvent(1, target, 0));
    });
    // pct = ((right - clientX) / width) * 100. clientX = 600 → pct = 40.
    act(() => {
      result.current.handleDragMove(pointerEvent(1, target, 600));
    });
    expect(result.current.previewWidth).toBe(40);

    act(() => {
      result.current.handleDragEnd(pointerEvent(1, target, 600));
    });
  });

  it('clamps drag to the lower bound (25%)', () => {
    const { result } = renderHook(() => useShowPreview());
    attachContainerRect(result.current.splitContainerRef, { right: 1000, width: 1000 });
    const target = makePointerTarget();

    act(() => {
      result.current.handleDragStart(pointerEvent(1, target, 0));
    });
    // clientX = 950 would give pct = 5; expect clamp to 25.
    act(() => {
      result.current.handleDragMove(pointerEvent(1, target, 950));
    });
    expect(result.current.previewWidth).toBe(25);
    act(() => {
      result.current.handleDragEnd(pointerEvent(1, target, 950));
    });
  });

  it('clamps drag to the upper bound (70%)', () => {
    const { result } = renderHook(() => useShowPreview());
    attachContainerRect(result.current.splitContainerRef, { right: 1000, width: 1000 });
    const target = makePointerTarget();

    act(() => {
      result.current.handleDragStart(pointerEvent(1, target, 0));
    });
    // clientX = 100 → pct = 90; expect clamp to 70.
    act(() => {
      result.current.handleDragMove(pointerEvent(1, target, 100));
    });
    expect(result.current.previewWidth).toBe(70);
    act(() => {
      result.current.handleDragEnd(pointerEvent(1, target, 100));
    });
  });

  it('stops updating previewWidth after pointerup', () => {
    const { result } = renderHook(() => useShowPreview());
    attachContainerRect(result.current.splitContainerRef, { right: 1000, width: 1000 });
    const target = makePointerTarget();

    act(() => {
      result.current.handleDragStart(pointerEvent(1, target, 0));
    });
    act(() => {
      result.current.handleDragMove(pointerEvent(1, target, 600));
    });
    expect(result.current.previewWidth).toBe(40);

    act(() => {
      result.current.handleDragEnd(pointerEvent(1, target, 600));
    });

    // After pointerup, further moves should not change width.
    act(() => {
      result.current.handleDragMove(pointerEvent(1, target, 300));
    });
    expect(result.current.previewWidth).toBe(40);
  });

  it('respects custom min/max percent bounds', () => {
    const { result } = renderHook(() =>
      useShowPreview({ minPercent: 10, maxPercent: 90, initialPreviewWidth: 30 })
    );
    attachContainerRect(result.current.splitContainerRef, { right: 1000, width: 1000 });
    const target = makePointerTarget();

    act(() => {
      result.current.handleDragStart(pointerEvent(1, target, 0));
    });
    act(() => {
      result.current.handleDragMove(pointerEvent(1, target, 950)); // pct = 5 → clamp to 10
    });
    expect(result.current.previewWidth).toBe(10);
    act(() => {
      result.current.handleDragEnd(pointerEvent(1, target, 950));
    });
  });

  // ─── PR-V9 deferred-coverage notes (test sweep, 2026-05-19) ────────────
  //
  // The PR-V9 fix (session reset on sessionId change) lives on the
  // `pr-v9-preview-session-leak` branch; the V9 happy-path tests there
  // cover sessionId transitions. The two tests below pin the *current*
  // hook contract on main so a future regression — or a botched rebase
  // that loses the V9 logic — surfaces immediately.

  it('setShowPreview is idempotent for repeated `true` calls (no extra renders observable)', () => {
    const { result } = renderHook(() => useShowPreview());
    act(() => result.current.setShowPreview(true));
    expect(result.current.showPreview).toBe(true);
    act(() => result.current.setShowPreview(true));
    expect(result.current.showPreview).toBe(true);
  });

  it('previewWidth stays at initial value when no drag has occurred', () => {
    const { result } = renderHook(() => useShowPreview({ initialPreviewWidth: 42 }));
    expect(result.current.previewWidth).toBe(42);
    // Just toggling showPreview must not perturb previewWidth.
    act(() => result.current.setShowPreview(true));
    expect(result.current.previewWidth).toBe(42);
  });
});

describe('useShowPreview session leak fix (PR-V9)', () => {
  it('resets showPreview when sessionId changes', () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useShowPreview({ sessionId: id }),
      { initialProps: { id: 'sess-A' as string | undefined } }
    );

    act(() => {
      result.current.setShowPreview(true);
    });
    expect(result.current.showPreview).toBe(true);

    // Navigate to a different session — sticky-open preview should reset.
    rerender({ id: 'sess-B' });

    expect(result.current.showPreview).toBe(false);
  });

  it('does NOT reset when sessionId stays the same', () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useShowPreview({ sessionId: id }),
      { initialProps: { id: 'sess-A' as string | undefined } }
    );

    act(() => {
      result.current.setShowPreview(true);
    });
    expect(result.current.showPreview).toBe(true);

    // Re-render with the same id — must NOT clobber user's toggle.
    rerender({ id: 'sess-A' });
    expect(result.current.showPreview).toBe(true);
  });

  it('resets when sessionId transitions from undefined → defined (new chat navigation)', () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useShowPreview({ sessionId: id }),
      { initialProps: { id: undefined as string | undefined } }
    );

    act(() => {
      result.current.setShowPreview(true);
    });
    expect(result.current.showPreview).toBe(true);

    rerender({ id: 'sess-A' });
    expect(result.current.showPreview).toBe(false);
  });

  it('resets when sessionId transitions from defined → undefined (back to /chat root)', () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useShowPreview({ sessionId: id }),
      { initialProps: { id: 'sess-A' as string | undefined } }
    );

    act(() => {
      result.current.setShowPreview(true);
    });
    expect(result.current.showPreview).toBe(true);

    rerender({ id: undefined });
    expect(result.current.showPreview).toBe(false);
  });
});
