import { useEffect, useRef, useState } from 'react';

import { PENDING_GITHUB_IDEA_KEY } from '../../../components/onboarding/githubConnectStorage';
import { toast } from '../../../components/ui/Toast';

const OAUTH_FLAG_KEY = 'akis-oauth-just-completed';

export interface UseGithubOAuthRestoreOptions {
  /** From `useProfileCompleteness` — flips true once the user has linked GitHub. */
  hasGitHub: boolean;
  /**
   * Forwarded from the parent `handleSend`. After OAuth completes and we
   * recover the saved idea from sessionStorage, we re-invoke `handleSend` so
   * the original pipeline-create flow runs.
   */
  handleSend: (idea: string) => Promise<unknown> | unknown;
}

export interface UseGithubOAuthRestoreReturn {
  /**
   * Held idea when the JIT gate is open. The gate component reads this for
   * its summary line; clearing it (or pressing cancel) closes the modal.
   */
  pendingGithubIdea: string | null;
  setPendingGithubIdea: React.Dispatch<React.SetStateAction<string | null>>;
}

/**
 * Just-in-time GitHub OAuth restore flow. Three concerns live here:
 *
 * 1. Phase 1 (mount): scrub `?github=connected` from the URL and stash a
 *    sessionStorage flag so phase 2 knows we just came back from OAuth.
 * 2. Phase 2 (hasGitHub flips true): if the flag is set, fire a success toast,
 *    pop the saved idea from sessionStorage, and re-invoke `handleSend`.
 *    Idempotent — storage flags are cleared after the first run so navigating
 *    back later doesn't re-fire.
 * 3. `pendingGithubIdea` state: held by the parent's send handler while the
 *    JIT gate modal is open. The gate's onConnect handler is responsible for
 *    saving the idea into sessionStorage + redirecting to OAuth.
 *
 * Extracted from ChatPage.tsx as part of F-06.
 */
export function useGithubOAuthRestore(
  options: UseGithubOAuthRestoreOptions,
): UseGithubOAuthRestoreReturn {
  const { hasGitHub, handleSend } = options;
  const [pendingGithubIdea, setPendingGithubIdea] = useState<string | null>(null);

  // handleSend is re-allocated on every parent render — route through a ref so
  // the phase-2 effect doesn't fire on every parent re-render after hasGitHub
  // has already flipped true.
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;

  // Phase 1 — runs once on mount. Detect ?github=connected, stash the flag,
  // scrub the URL. We don't read hasGitHub here because the profile fetch may
  // not have resolved yet.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('github') !== 'connected') return;
    sessionStorage.setItem(OAUTH_FLAG_KEY, '1');
    params.delete('github');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
  }, []);

  // Phase 2 — once hasGitHub flips true, if we just completed the OAuth dance,
  // toast + auto-resume. Storage flags are cleared up-front so re-mounting the
  // hook later (e.g. browser back/forward) doesn't replay the saved idea.
  useEffect(() => {
    if (!hasGitHub) return;
    if (typeof window === 'undefined') return;
    const justCompleted = sessionStorage.getItem(OAUTH_FLAG_KEY) === '1';
    if (!justCompleted) return;
    sessionStorage.removeItem(OAUTH_FLAG_KEY);
    toast('GitHub bağlandı. Pipeline başlatılıyor…', 'success');
    const savedIdea = sessionStorage.getItem(PENDING_GITHUB_IDEA_KEY);
    sessionStorage.removeItem(PENDING_GITHUB_IDEA_KEY);
    setPendingGithubIdea(null);
    if (savedIdea) {
      const result = handleSendRef.current(savedIdea);
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        (result as Promise<unknown>).catch(() => {});
      }
    }
  }, [hasGitHub]);

  return { pendingGithubIdea, setPendingGithubIdea };
}

// Exported so tests can clear the flag between runs without importing the
// key string from a deep module path.
export const OAUTH_JUST_COMPLETED_KEY = OAUTH_FLAG_KEY;
