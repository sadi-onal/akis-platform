/**
 * useSplitResize — drag-to-resize for the chat-preview split pane.
 * Uses Pointer Events + setPointerCapture so mouseup over the Sandpack
 * iframe still reaches the handle element (PR-V1, 2026-05-19).
 */
import { useCallback, useRef } from 'react';

export interface UseSplitResizeOptions {
  setPreviewWidth: (next: number) => void;
  minPercent?: number;
  maxPercent?: number;
}

export function useSplitResize(options: UseSplitResizeOptions) {
  const { setPreviewWidth, minPercent = 25, maxPercent = 70 } = options;
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);

  const handleDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    activePointerIdRef.current = e.pointerId;
    isDraggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleDragMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDraggingRef.current || !splitContainerRef.current) return;
      if (activePointerIdRef.current !== e.pointerId) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const pct = ((rect.right - e.clientX) / rect.width) * 100;
      setPreviewWidth(Math.max(minPercent, Math.min(maxPercent, pct)));
    },
    [setPreviewWidth, minPercent, maxPercent]
  );

  const handleDragEnd = useCallback((e: React.PointerEvent) => {
    if (activePointerIdRef.current !== e.pointerId) return;
    const target = e.currentTarget as HTMLElement;
    try {
      target.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer lost (blur etc.) */
    }
    activePointerIdRef.current = null;
    isDraggingRef.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  return {
    splitContainerRef,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
  };
}
