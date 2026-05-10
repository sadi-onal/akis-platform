/**
 * Tests for the JIT GitHub OAuth restore hook. Covers the two-phase contract:
 *   1. On mount with `?github=connected`, the URL is scrubbed + a flag is set.
 *   2. When `hasGitHub` flips true and the flag is present, the saved idea is
 *      pulled out of sessionStorage and `handleSend(idea)` is invoked once.
 * Idempotency: a second mount after the flag has been cleared does not re-fire.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import {
  useGithubOAuthRestore,
  OAUTH_JUST_COMPLETED_KEY,
} from '../useGithubOAuthRestore';
import { PENDING_GITHUB_IDEA_KEY } from '../../../../components/onboarding/githubConnectStorage';

vi.mock('../../../../components/ui/Toast', () => ({
  toast: vi.fn(),
}));

import { toast } from '../../../../components/ui/Toast';

const mockedToast = vi.mocked(toast);

// ── Helpers ────────────────────────────────────────

function setUrl(pathname: string, search = '') {
  window.history.replaceState({}, '', pathname + (search ? `?${search}` : ''));
}

describe('useGithubOAuthRestore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    setUrl('/chat');
  });

  // ── Phase 1 ──────────────────────────────────────

  it('phase 1: scrubs ?github=connected from the URL and stashes the flag', () => {
    setUrl('/chat', 'github=connected&foo=bar');
    renderHook(() =>
      useGithubOAuthRestore({ hasGitHub: false, handleSend: vi.fn() }),
    );

    expect(window.location.search).toBe('?foo=bar');
    expect(sessionStorage.getItem(OAUTH_JUST_COMPLETED_KEY)).toBe('1');
  });

  it('phase 1: scrubbing leaves an empty query string when ?github was the only param', () => {
    setUrl('/chat', 'github=connected');
    renderHook(() =>
      useGithubOAuthRestore({ hasGitHub: false, handleSend: vi.fn() }),
    );
    expect(window.location.search).toBe('');
    expect(sessionStorage.getItem(OAUTH_JUST_COMPLETED_KEY)).toBe('1');
  });

  it('phase 1: no-ops when the URL does not have the github param', () => {
    setUrl('/chat', 'other=1');
    renderHook(() =>
      useGithubOAuthRestore({ hasGitHub: false, handleSend: vi.fn() }),
    );
    expect(window.location.search).toBe('?other=1');
    expect(sessionStorage.getItem(OAUTH_JUST_COMPLETED_KEY)).toBeNull();
  });

  // ── Phase 2 ──────────────────────────────────────

  it('phase 2: when hasGitHub flips true with the flag set, toasts + replays the saved idea', async () => {
    sessionStorage.setItem(OAUTH_JUST_COMPLETED_KEY, '1');
    sessionStorage.setItem(PENDING_GITHUB_IDEA_KEY, 'my saved idea');
    const handleSend = vi.fn().mockResolvedValue(undefined);

    const { rerender } = renderHook(
      ({ hasGitHub }: { hasGitHub: boolean }) =>
        useGithubOAuthRestore({ hasGitHub, handleSend }),
      { initialProps: { hasGitHub: false } },
    );

    expect(handleSend).not.toHaveBeenCalled();

    rerender({ hasGitHub: true });

    await waitFor(() => {
      expect(handleSend).toHaveBeenCalledWith('my saved idea');
    });
    expect(handleSend).toHaveBeenCalledTimes(1);
    expect(mockedToast).toHaveBeenCalledWith(expect.stringMatching(/GitHub bağlandı/), 'success');
    // Flag + idea cleared so a later re-render doesn't replay
    expect(sessionStorage.getItem(OAUTH_JUST_COMPLETED_KEY)).toBeNull();
    expect(sessionStorage.getItem(PENDING_GITHUB_IDEA_KEY)).toBeNull();
  });

  it('phase 2: when hasGitHub flips true without the flag, no-op (user already had GitHub)', () => {
    const handleSend = vi.fn();
    const { rerender } = renderHook(
      ({ hasGitHub }: { hasGitHub: boolean }) =>
        useGithubOAuthRestore({ hasGitHub, handleSend }),
      { initialProps: { hasGitHub: false } },
    );
    rerender({ hasGitHub: true });
    expect(handleSend).not.toHaveBeenCalled();
    expect(mockedToast).not.toHaveBeenCalled();
  });

  it('phase 2: when flag is set but no idea is stored, still toasts + clears flag', async () => {
    sessionStorage.setItem(OAUTH_JUST_COMPLETED_KEY, '1');
    const handleSend = vi.fn();
    const { rerender } = renderHook(
      ({ hasGitHub }: { hasGitHub: boolean }) =>
        useGithubOAuthRestore({ hasGitHub, handleSend }),
      { initialProps: { hasGitHub: false } },
    );
    rerender({ hasGitHub: true });
    await waitFor(() => {
      expect(mockedToast).toHaveBeenCalledWith(expect.stringMatching(/GitHub bağlandı/), 'success');
    });
    expect(handleSend).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(OAUTH_JUST_COMPLETED_KEY)).toBeNull();
  });

  it('phase 2: a second mount after the flag is cleared does not replay (idempotent)', async () => {
    sessionStorage.setItem(OAUTH_JUST_COMPLETED_KEY, '1');
    sessionStorage.setItem(PENDING_GITHUB_IDEA_KEY, 'idea');
    const handleSend = vi.fn().mockResolvedValue(undefined);

    const first = renderHook(
      ({ hasGitHub }: { hasGitHub: boolean }) =>
        useGithubOAuthRestore({ hasGitHub, handleSend }),
      { initialProps: { hasGitHub: true } },
    );

    await waitFor(() => expect(handleSend).toHaveBeenCalledTimes(1));
    first.unmount();

    // Simulate a fresh navigation back to /chat — fresh mount, no flag.
    renderHook(
      ({ hasGitHub }: { hasGitHub: boolean }) =>
        useGithubOAuthRestore({ hasGitHub, handleSend }),
      { initialProps: { hasGitHub: true } },
    );
    // Total send count stays at one — phase 2 did not re-fire.
    expect(handleSend).toHaveBeenCalledTimes(1);
  });

  it('phase 2: swallows handleSend promise rejection (does not bubble to React)', async () => {
    sessionStorage.setItem(OAUTH_JUST_COMPLETED_KEY, '1');
    sessionStorage.setItem(PENDING_GITHUB_IDEA_KEY, 'idea');
    const handleSend = vi.fn().mockRejectedValue(new Error('send failed'));

    const { rerender } = renderHook(
      ({ hasGitHub }: { hasGitHub: boolean }) =>
        useGithubOAuthRestore({ hasGitHub, handleSend }),
      { initialProps: { hasGitHub: false } },
    );

    rerender({ hasGitHub: true });

    await waitFor(() => expect(handleSend).toHaveBeenCalledTimes(1));
    // No unhandled rejection — if one slipped through, vitest would fail the suite.
  });

  // ── pendingGithubIdea state ──────────────────────

  it('exposes pendingGithubIdea state for the JIT gate modal', () => {
    const { result } = renderHook(() =>
      useGithubOAuthRestore({ hasGitHub: false, handleSend: vi.fn() }),
    );
    expect(result.current.pendingGithubIdea).toBeNull();
  });

  it('handleSend ref captures the latest closure across renders', async () => {
    sessionStorage.setItem(OAUTH_JUST_COMPLETED_KEY, '1');
    sessionStorage.setItem(PENDING_GITHUB_IDEA_KEY, 'idea');
    // Two distinct mocks — the first is set up before the OAuth-complete render
    // but should NOT be called once phase 2 runs with hasGitHub=true.
    const stale = vi.fn();
    const fresh = vi.fn();

    const { rerender } = renderHook(
      ({ hasGitHub, handleSend }: { hasGitHub: boolean; handleSend: typeof stale }) =>
        useGithubOAuthRestore({ hasGitHub, handleSend }),
      { initialProps: { hasGitHub: false, handleSend: stale } },
    );

    rerender({ hasGitHub: false, handleSend: fresh });
    rerender({ hasGitHub: true, handleSend: fresh });

    await waitFor(() => expect(fresh).toHaveBeenCalledWith('idea'));
    expect(stale).not.toHaveBeenCalled();
  });
});
