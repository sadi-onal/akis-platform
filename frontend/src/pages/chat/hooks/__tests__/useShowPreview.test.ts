/**
 * Tests for the chat/preview split-pane hook. Covers:
 *   1. Defaults: hidden by default, 50% width.
 *   2. Toggling visibility.
 *   3. Drag updates `previewWidth` and clamps to the 25–70% bounds.
 *   4. The drag listeners are removed on `mouseup`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useShowPreview } from '../useShowPreview';

// `getBoundingClientRect` is undefined for synthetic divs in jsdom — stub one
// onto the element the hook will read. Width = 1000 lets us reason about
// percent maths with simple numbers.
function attachContainerRect(
  ref: { current: HTMLDivElement | null },
  rect: Partial<DOMRect>,
) {
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

function dispatchMouse(type: 'mousemove' | 'mouseup', clientX: number) {
  const evt = new MouseEvent(type, { clientX, bubbles: true });
  document.dispatchEvent(evt);
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
      useShowPreview({ initialShowPreview: true, initialPreviewWidth: 60 }),
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

  it('drag updates previewWidth based on mouse position', () => {
    const { result } = renderHook(() => useShowPreview());
    attachContainerRect(result.current.splitContainerRef, { right: 1000, width: 1000 });

    act(() => {
      result.current.handleDragStart({
        preventDefault: () => undefined,
      } as unknown as React.MouseEvent);
    });
    // pct = ((right - clientX) / width) * 100. clientX = 600 → pct = 40.
    act(() => dispatchMouse('mousemove', 600));
    expect(result.current.previewWidth).toBe(40);

    act(() => dispatchMouse('mouseup', 600));
  });

  it('clamps drag to the lower bound (25%)', () => {
    const { result } = renderHook(() => useShowPreview());
    attachContainerRect(result.current.splitContainerRef, { right: 1000, width: 1000 });

    act(() => {
      result.current.handleDragStart({
        preventDefault: () => undefined,
      } as unknown as React.MouseEvent);
    });
    // clientX = 950 would give pct = 5; expect clamp to 25.
    act(() => dispatchMouse('mousemove', 950));
    expect(result.current.previewWidth).toBe(25);
    act(() => dispatchMouse('mouseup', 950));
  });

  it('clamps drag to the upper bound (70%)', () => {
    const { result } = renderHook(() => useShowPreview());
    attachContainerRect(result.current.splitContainerRef, { right: 1000, width: 1000 });

    act(() => {
      result.current.handleDragStart({
        preventDefault: () => undefined,
      } as unknown as React.MouseEvent);
    });
    // clientX = 100 → pct = 90; expect clamp to 70.
    act(() => dispatchMouse('mousemove', 100));
    expect(result.current.previewWidth).toBe(70);
    act(() => dispatchMouse('mouseup', 100));
  });

  it('removes the drag listeners on mouseup', () => {
    const { result } = renderHook(() => useShowPreview());
    attachContainerRect(result.current.splitContainerRef, { right: 1000, width: 1000 });

    act(() => {
      result.current.handleDragStart({
        preventDefault: () => undefined,
      } as unknown as React.MouseEvent);
    });
    act(() => dispatchMouse('mousemove', 600));
    expect(result.current.previewWidth).toBe(40);

    act(() => dispatchMouse('mouseup', 600));

    // After mouseup, further moves should not change width.
    act(() => dispatchMouse('mousemove', 300));
    expect(result.current.previewWidth).toBe(40);
  });

  it('respects custom min/max percent bounds', () => {
    const { result } = renderHook(() =>
      useShowPreview({ minPercent: 10, maxPercent: 90, initialPreviewWidth: 30 }),
    );
    attachContainerRect(result.current.splitContainerRef, { right: 1000, width: 1000 });

    act(() => {
      result.current.handleDragStart({
        preventDefault: () => undefined,
      } as unknown as React.MouseEvent);
    });
    act(() => dispatchMouse('mousemove', 950)); // pct = 5 → clamp to 10
    expect(result.current.previewWidth).toBe(10);
    act(() => dispatchMouse('mouseup', 950));
  });
});
