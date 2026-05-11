import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useChatPageKeyboard } from '../useChatPageKeyboard';

// ── Helpers ────────────────────────────────────────

function fireKeyboardShortcut(opts: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}) {
  const evt = new KeyboardEvent('keydown', {
    key: opts.key,
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(evt);
  return evt;
}

// ── Tests ──────────────────────────────────────────

describe('useChatPageKeyboard', () => {
  let sidebarSearch: HTMLInputElement;
  let focusSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sidebarSearch = document.createElement('input');
    sidebarSearch.setAttribute('data-sidebar-search', '');
    document.body.appendChild(sidebarSearch);
    focusSpy = vi.spyOn(sidebarSearch, 'focus');
  });

  afterEach(() => {
    focusSpy.mockRestore();
    document.body.removeChild(sidebarSearch);
  });

  it('focuses the sidebar search on Ctrl+K', () => {
    renderHook(() => useChatPageKeyboard({ onNewConversation: vi.fn() }));
    fireKeyboardShortcut({ key: 'k', ctrlKey: true });
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('focuses the sidebar search on Cmd+K (macOS)', () => {
    renderHook(() => useChatPageKeyboard({ onNewConversation: vi.fn() }));
    fireKeyboardShortcut({ key: 'k', metaKey: true });
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('does not focus on plain K (no modifier)', () => {
    renderHook(() => useChatPageKeyboard({ onNewConversation: vi.fn() }));
    fireKeyboardShortcut({ key: 'k' });
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('invokes onNewConversation on Ctrl+Shift+N', () => {
    const onNewConversation = vi.fn();
    renderHook(() => useChatPageKeyboard({ onNewConversation }));
    fireKeyboardShortcut({ key: 'N', ctrlKey: true, shiftKey: true });
    expect(onNewConversation).toHaveBeenCalledTimes(1);
  });

  it('invokes onNewConversation on Cmd+Shift+N', () => {
    const onNewConversation = vi.fn();
    renderHook(() => useChatPageKeyboard({ onNewConversation }));
    fireKeyboardShortcut({ key: 'N', metaKey: true, shiftKey: true });
    expect(onNewConversation).toHaveBeenCalledTimes(1);
  });

  it('does not invoke onNewConversation on Cmd+N (no shift)', () => {
    const onNewConversation = vi.fn();
    renderHook(() => useChatPageKeyboard({ onNewConversation }));
    fireKeyboardShortcut({ key: 'N', metaKey: true });
    expect(onNewConversation).not.toHaveBeenCalled();
  });

  it('prevents default for handled shortcuts', () => {
    renderHook(() => useChatPageKeyboard({ onNewConversation: vi.fn() }));
    const evt = fireKeyboardShortcut({ key: 'k', ctrlKey: true });
    expect(evt.defaultPrevented).toBe(true);
  });

  it('removes the listener on unmount', () => {
    const onNewConversation = vi.fn();
    const { unmount } = renderHook(() => useChatPageKeyboard({ onNewConversation }));
    unmount();
    fireKeyboardShortcut({ key: 'N', ctrlKey: true, shiftKey: true });
    expect(onNewConversation).not.toHaveBeenCalled();
  });

  it('reads the latest onNewConversation callback even if parent re-renders', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ onNewConversation }: { onNewConversation: () => void }) =>
        useChatPageKeyboard({ onNewConversation }),
      { initialProps: { onNewConversation: first } },
    );
    rerender({ onNewConversation: second });
    fireKeyboardShortcut({ key: 'N', ctrlKey: true, shiftKey: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
