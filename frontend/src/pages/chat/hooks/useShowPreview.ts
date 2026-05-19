/**
 * useShowPreview — owns the chat/preview split-pane state for ChatPage.
 *
 * Combines three small pieces extracted from ChatPage.tsx in F-06 Phase 2:
 *   - `showPreview` boolean (toggle the preview pane on/off).
 *   - `previewWidth` percent (drag-to-resize, clamped to 25–70%).
 *   - the drag wiring that updates `previewWidth` on `pointermove`.
 *
 * Internally delegates the drag plumbing to the existing `useSplitResize`
 * primitive so we don't duplicate the listener logic. From the caller's view
 * this is one hook; the split-resize helper remains usable elsewhere.
 *
 * Returns:
 *   - `showPreview` / `setShowPreview` — current visibility + setter.
 *   - `previewWidth` — current pane width as a percent (number).
 *   - `splitContainerRef` — attach to the flex parent that holds chat + preview.
 *   - `handleDragStart` — wire to the drag handle's `onPointerDown`.
 *   - `handleDragMove` / `handleDragEnd` — wire to `onPointerMove` / `onPointerUp`
 *     (and `onPointerCancel`) on the same handle element.
 */
import { useEffect, useRef, useState } from 'react';
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
  /**
   * Current chat session id. When this changes the hook resets `showPreview`
   * to `false` so the panel doesn't sticky-open into a new session that has
   * no preview content (PR-V9 — preview panel session leak fix).
   *
   * ChatPage uses a single splat route `/chat/*` so the component is not
   * remounted on navigation; without this reset the boolean leaks across
   * sessions. Pass `undefined` if you want to opt out of the reset.
   */
  sessionId?: string;
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
    sessionId,
  } = options;

  const [showPreview, setShowPreview] = useState<boolean>(initialShowPreview);
  const [previewWidth, setPreviewWidth] = useState<number>(initialPreviewWidth);

  // PR-V9: ChatPage lives behind a splat route (`/chat/*`) so it is NOT
  // unmounted on session switch — only the URL param changes. Without this
  // effect, an open preview panel "leaks" into a freshly-opened session that
  // has no code to render, leaving an empty Sandpack on screen. We reset
  // visibility whenever the session id transitions; the user can re-open the
  // preview within the new session via the header toggle.
  const previousSessionIdRef = useRef<string | undefined>(sessionId);
  useEffect(() => {
    if (previousSessionIdRef.current !== sessionId) {
      previousSessionIdRef.current = sessionId;
      setShowPreview(false);
    }
  }, [sessionId]);

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
