/**
 * useShowPreview — owns the chat/preview split-pane state for ChatPage.
 *
 * Combines three small pieces extracted from ChatPage.tsx in F-06 Phase 2:
 *   - `showPreview` boolean (toggle the preview pane on/off).
 *   - `previewWidth` percent (drag-to-resize, clamped to 25–70%).
 *   - the drag wiring that updates `previewWidth` on `mousemove`.
 *
 * Internally delegates the drag plumbing to the existing `useSplitResize`
 * primitive so we don't duplicate the listener logic. From the caller's view
 * this is one hook; the split-resize helper remains usable elsewhere.
 *
 * Returns:
 *   - `showPreview` / `setShowPreview` — current visibility + setter.
 *   - `previewWidth` — current pane width as a percent (number).
 *   - `splitContainerRef` — attach to the flex parent that holds chat + preview.
 *   - `handleDragStart` — wire to the drag handle's `onMouseDown`.
 */
import { useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';

import { useSplitResize } from './useSplitResize';

export interface UseShowPreviewOptions {
  /** Initial visibility. Defaults to false (hidden until the user toggles). */
  initialShowPreview?: boolean;
  /** Initial width percent. Defaults to 50 (matches the original ChatPage). */
  initialPreviewWidth?: number;
  /** Lower bound (percent) for the drag clamp. Defaults to 25. */
  minPercent?: number;
  /** Upper bound (percent) for the drag clamp. Defaults to 70. */
  maxPercent?: number;
}

export interface UseShowPreviewResult {
  showPreview: boolean;
  setShowPreview: (next: boolean | ((prev: boolean) => boolean)) => void;
  previewWidth: number;
  splitContainerRef: RefObject<HTMLDivElement | null>;
  handleDragStart: (e: ReactPointerEvent) => void;
  handleDragMove: (e: ReactPointerEvent) => void;
  handleDragEnd: (e: ReactPointerEvent) => void;
}

export function useShowPreview(options: UseShowPreviewOptions = {}): UseShowPreviewResult {
  const {
    initialShowPreview = false,
    initialPreviewWidth = 50,
    minPercent = 25,
    maxPercent = 70,
  } = options;

  const [showPreview, setShowPreview] = useState<boolean>(initialShowPreview);
  const [previewWidth, setPreviewWidth] = useState<number>(initialPreviewWidth);

  const { splitContainerRef, handleDragStart, handleDragMove, handleDragEnd } = useSplitResize({
    setPreviewWidth,
    minPercent,
    maxPercent,
  });

  return {
    showPreview,
    setShowPreview,
    previewWidth,
    splitContainerRef,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
  };
}
