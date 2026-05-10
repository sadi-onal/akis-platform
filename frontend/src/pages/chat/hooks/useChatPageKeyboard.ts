import { useEffect, useRef } from 'react';

export interface UseChatPageKeyboardOptions {
  /** Called for the Ctrl/Cmd+Shift+N shortcut. */
  onNewConversation: () => void;
}

/**
 * Pure side-effect hook — wires the two ChatPage keyboard shortcuts:
 * - Ctrl/Cmd+K → focus the sidebar search input (queried by data attribute).
 * - Ctrl/Cmd+Shift+N → invoke `onNewConversation`.
 *
 * Extracted from ChatPage.tsx as part of F-06. The callback is routed through
 * a ref so the parent doesn't have to memoize `onNewConversation` to keep this
 * effect stable.
 */
export function useChatPageKeyboard(options: UseChatPageKeyboardOptions): void {
  const { onNewConversation } = options;
  const onNewConversationRef = useRef(onNewConversation);
  onNewConversationRef.current = onNewConversation;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      // Ctrl/Cmd+K → focus sidebar search
      if (isMod && e.key === 'k') {
        e.preventDefault();
        const searchInput = document.querySelector<HTMLInputElement>('[data-sidebar-search]');
        searchInput?.focus();
      }
      // Ctrl/Cmd+Shift+N → new conversation
      if (isMod && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        onNewConversationRef.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
