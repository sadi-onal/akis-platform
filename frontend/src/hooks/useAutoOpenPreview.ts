import { useEffect, useRef } from 'react';
import type { ConversationUIState } from '../types/chat';

/**
 * Auto-open the right-side Preview Panel when the pipeline transitions
 * into `awaiting_push_confirm` or `awaiting_critic_resolution`.
 * Extracted to a hook so the layout-level effect is testable in
 * isolation (T3 of preview-unify plan).
 *
 * Behaviour:
 * - Fires `setShowPreview(true)` only when state *transitions* into
 *   one of the gate states. If the user manually closes the panel
 *   while still at the gate, we do not reopen it on every render.
 * - Other transitions (gate → proto_building → gate again after iterate)
 *   trigger a fresh auto-open: each entry into the gate is treated as a
 *   new "you need to look at this" event.
 *
 * Spec: docs/superpowers/specs/2026-05-14-preview-unify-chat-iterate-design.md § T3
 */
export function useAutoOpenPreview(
  uiState: ConversationUIState | string,
  showPreview: boolean,
  setShowPreview: (open: boolean) => void
): void {
  const prevStateRef = useRef<string>(uiState);

  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = uiState;

    // Only act on the transition INTO a gate state — not on every render
    // while we're already at the gate. This lets the user close the panel
    // manually without it bouncing back on the next render.
    // #636: also auto-open at `awaiting_critic_resolution` so users can see
    // the generated code while deciding whether to override critic findings.
    const isEnteringPushGate =
      uiState === 'awaiting_push_confirm' && prev !== 'awaiting_push_confirm';
    const isEnteringCriticGate =
      uiState === 'awaiting_critic_resolution' && prev !== 'awaiting_critic_resolution';

    if ((isEnteringPushGate || isEnteringCriticGate) && !showPreview) {
      setShowPreview(true);
    }
    // Note: showPreview is intentionally excluded from deps — we don't want
    // to re-evaluate when the user toggles the panel; only when uiState
    // changes. We read showPreview at the transition point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiState, setShowPreview]);
}
