/**
 * useSplitResize — drag-to-resize for the chat-preview split pane. Extracted
 * from ChatPage.tsx as a small helper hook. Returns the container ref + the
 * `mousedown` handler to attach to the drag handle.
 *
 * TODO(F-06 Phase 2): generalise into a reusable split-pane primitive
 * (vertical orientation, touch support, persisted width).
 */
import { useCallback, useRef } from 'react';

export interface UseSplitResizeOptions {
  /** Setter for the current preview-pane width (percent of the split container). */
  setPreviewWidth: (next: number) => void;
  /** Minimum preview width (percent). Defaults to 25. */
  minPercent?: number;
  /** Maximum preview width (percent). Defaults to 70. */
  maxPercent?: number;
}

export function useSplitResize(options: UseSplitResizeOptions) {
  const { setPreviewWidth, minPercent = 25, maxPercent = 70 } = options;
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDraggingRef.current = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (ev: MouseEvent) => {
        if (!isDraggingRef.current || !splitContainerRef.current) return;
        const rect = splitContainerRef.current.getBoundingClientRect();
        const pct = ((rect.right - ev.clientX) / rect.width) * 100;
        setPreviewWidth(Math.max(minPercent, Math.min(maxPercent, pct)));
      };

      const onUp = () => {
        isDraggingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [setPreviewWidth, minPercent, maxPercent],
  );

  return { splitContainerRef, handleDragStart };
}
