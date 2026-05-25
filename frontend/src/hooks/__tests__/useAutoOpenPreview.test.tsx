import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAutoOpenPreview } from '../useAutoOpenPreview';
import type { ConversationUIState } from '../../types/chat';

describe('useAutoOpenPreview', () => {
  it('opens preview when uiState transitions into awaiting_push_confirm', () => {
    const setShowPreview = vi.fn();
    const { rerender } = renderHook(
      ({ s, o }: { s: ConversationUIState; o: boolean }) => useAutoOpenPreview(s, o, setShowPreview),
      { initialProps: { s: 'idle' as ConversationUIState, o: false } }
    );

    // Initial mount at idle/closed: should not auto-open (no transition into push state).
    expect(setShowPreview).not.toHaveBeenCalled();

    // Transition into awaiting_push_confirm should trigger setShowPreview(true).
    rerender({ s: 'awaiting_push_confirm' as ConversationUIState, o: false });
    expect(setShowPreview).toHaveBeenCalledTimes(1);
    expect(setShowPreview).toHaveBeenCalledWith(true);
  });

  it('does not re-open when user manually closed the panel while still at the gate', () => {
    const setShowPreview = vi.fn();
    // Start already at the gate with preview open — no transition, no call.
    const { rerender } = renderHook(
      ({ s, o }: { s: ConversationUIState; o: boolean }) => useAutoOpenPreview(s, o, setShowPreview),
      { initialProps: { s: 'awaiting_push_confirm' as ConversationUIState, o: true } }
    );
    expect(setShowPreview).not.toHaveBeenCalled();

    // User closes the panel — still at the gate, state didn't transition.
    // Hook must not bounce the panel back open.
    rerender({ s: 'awaiting_push_confirm' as ConversationUIState, o: false });
    expect(setShowPreview).not.toHaveBeenCalled();
  });

  it('re-opens on a fresh transition (gate → proto_running → gate again)', () => {
    const setShowPreview = vi.fn();
    const { rerender } = renderHook(
      ({ s, o }: { s: ConversationUIState; o: boolean }) => useAutoOpenPreview(s, o, setShowPreview),
      { initialProps: { s: 'awaiting_push_confirm' as ConversationUIState, o: true } }
    );
    expect(setShowPreview).not.toHaveBeenCalled();

    // Leave the gate (iterate kicks proto). User closes the panel meanwhile.
    rerender({ s: 'proto_running' as ConversationUIState, o: false });
    expect(setShowPreview).not.toHaveBeenCalled();

    // Pipeline lands back at the gate — auto-open should fire again.
    rerender({ s: 'awaiting_push_confirm' as ConversationUIState, o: false });
    expect(setShowPreview).toHaveBeenCalledTimes(1);
    expect(setShowPreview).toHaveBeenCalledWith(true);
  });

  it('does not call setShowPreview when transitioning into push_confirm with preview already open', () => {
    const setShowPreview = vi.fn();
    const { rerender } = renderHook(
      ({ s, o }: { s: ConversationUIState; o: boolean }) => useAutoOpenPreview(s, o, setShowPreview),
      { initialProps: { s: 'proto_running' as ConversationUIState, o: true } }
    );
    rerender({ s: 'awaiting_push_confirm' as ConversationUIState, o: true });
    // Already open — no need to call the setter (avoids redundant renders).
    expect(setShowPreview).not.toHaveBeenCalled();
  });

  // #636: awaiting_critic_resolution should also auto-open the preview panel
  it('opens preview when uiState transitions into awaiting_critic_resolution', () => {
    const setShowPreview = vi.fn();
    const { rerender } = renderHook(
      ({ s, o }: { s: ConversationUIState; o: boolean }) => useAutoOpenPreview(s, o, setShowPreview),
      { initialProps: { s: 'critic_reviewing_code' as ConversationUIState, o: false } }
    );

    expect(setShowPreview).not.toHaveBeenCalled();

    rerender({ s: 'awaiting_critic_resolution' as ConversationUIState, o: false });
    expect(setShowPreview).toHaveBeenCalledTimes(1);
    expect(setShowPreview).toHaveBeenCalledWith(true);
  });

  it('does not re-open during awaiting_critic_resolution when user manually closed the panel', () => {
    const setShowPreview = vi.fn();
    const { rerender } = renderHook(
      ({ s, o }: { s: ConversationUIState; o: boolean }) => useAutoOpenPreview(s, o, setShowPreview),
      { initialProps: { s: 'awaiting_critic_resolution' as ConversationUIState, o: true } }
    );
    expect(setShowPreview).not.toHaveBeenCalled();

    // User closes the panel — still at the gate, state didn't transition.
    rerender({ s: 'awaiting_critic_resolution' as ConversationUIState, o: false });
    expect(setShowPreview).not.toHaveBeenCalled();
  });

  it('does not call setShowPreview when transitioning into critic_resolution with preview already open', () => {
    const setShowPreview = vi.fn();
    const { rerender } = renderHook(
      ({ s, o }: { s: ConversationUIState; o: boolean }) => useAutoOpenPreview(s, o, setShowPreview),
      { initialProps: { s: 'critic_reviewing_code' as ConversationUIState, o: true } }
    );
    rerender({ s: 'awaiting_critic_resolution' as ConversationUIState, o: true });
    expect(setShowPreview).not.toHaveBeenCalled();
  });

  it('re-opens on a fresh transition through critic_resolution (gate → proto → gate again)', () => {
    const setShowPreview = vi.fn();
    const { rerender } = renderHook(
      ({ s, o }: { s: ConversationUIState; o: boolean }) => useAutoOpenPreview(s, o, setShowPreview),
      { initialProps: { s: 'awaiting_critic_resolution' as ConversationUIState, o: true } }
    );
    expect(setShowPreview).not.toHaveBeenCalled();

    // Leave the gate (iterate kicks proto). User closes the panel meanwhile.
    rerender({ s: 'proto_running' as ConversationUIState, o: false });
    expect(setShowPreview).not.toHaveBeenCalled();

    // Pipeline lands back at critic resolution — auto-open should fire again.
    rerender({ s: 'awaiting_critic_resolution' as ConversationUIState, o: false });
    expect(setShowPreview).toHaveBeenCalledTimes(1);
    expect(setShowPreview).toHaveBeenCalledWith(true);
  });
});
