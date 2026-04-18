/**
 * EngineerPage — Step 2 (discover) tests
 *
 * Issue #425 regression guard:
 *  - Frontend sends `{owner, repo}` to /api/engineer/discover (not a single combined string)
 *  - 60s client-side timeout surfaces a retry button if the endpoint hangs
 *  - Multi-stage loading label is shown (not the generic "analiz ediyor" alone)
 *  - Retry button re-invokes the discover call
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ── Mocks ─────────────────────────────────────────────

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

const listReposMock = vi.fn();
vi.mock('../../../services/api/github', () => ({
  githubApi: {
    listRepos: (...args: unknown[]) => listReposMock(...args),
  },
}));

const discoverTasksMock = vi.fn();
vi.mock('../../../services/api/engineer', () => ({
  engineerApi: {
    discoverTasks: (...args: unknown[]) => discoverTasksMock(...args),
    createSession: vi.fn(),
    startSession: vi.fn(),
  },
}));

// ── Imports (after mocks) ─────────────────────────────

import EngineerPage from '../EngineerPage';

// ── Helpers ───────────────────────────────────────────

const SAMPLE_REPO = {
  fullName: 'acme/widget',
  private: false,
  updatedAt: new Date('2026-04-01T00:00:00Z').toISOString(),
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/engineer']}>
      <EngineerPage />
    </MemoryRouter>,
  );
}

async function selectRepoAndEnterStep2() {
  listReposMock.mockResolvedValue([SAMPLE_REPO]);
  renderPage();
  // Real timers while we wait for the repos promise microtask to settle.
  const repoButton = await screen.findByRole('button', { name: /acme\/widget/ });
  // Swap to fake timers before clicking — clicking schedules the discover
  // call + the client-side stage/timeout timers which tests want to control.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fireEvent.click(repoButton);
}

beforeEach(() => {
  // Dismiss the intro modal via the storage key so step 2 renders cleanly.
  window.localStorage.setItem('akis_engineer_intro_seen', 'true');
  listReposMock.mockReset();
  discoverTasksMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

// ── Tests ─────────────────────────────────────────────

describe('EngineerPage Step 2 — discover payload + UX (issue #425)', () => {
  it('sends owner and repo as separate fields (not a single combined string)', async () => {
    discoverTasksMock.mockResolvedValue({
      owner: 'acme',
      repo: 'widget',
      tasks: [],
      analyzedAt: new Date().toISOString(),
    });
    await selectRepoAndEnterStep2();

    await waitFor(() => {
      expect(discoverTasksMock).toHaveBeenCalledTimes(1);
    });
    expect(discoverTasksMock).toHaveBeenCalledWith('acme', 'widget');
  });

  it('shows a multi-stage loading message that advances over time', async () => {
    // Hang the promise so we can observe stage progression.
    let resolveDiscover: (value: unknown) => void = () => {};
    discoverTasksMock.mockImplementation(
      () => new Promise((res) => { resolveDiscover = res; }),
    );

    await selectRepoAndEnterStep2();

    // Initial stage
    expect(await screen.findByText(/Mühendis reponuzu analiz ediyor/)).toBeTruthy();

    // After 5s → file-reading stage
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByText(/Repo dosyaları okunuyor/)).toBeTruthy();

    // After 15s → classification stage
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByText(/Görevler sınıflandırılıyor/)).toBeTruthy();

    // Cleanup: resolve so unmount doesn't dangle
    resolveDiscover({ owner: 'acme', repo: 'widget', tasks: [], analyzedAt: '' });
  });

  it('shows a timeout error with retry button if discover hangs > 60s', async () => {
    // Never resolve — simulate a truly stuck backend.
    discoverTasksMock.mockImplementation(() => new Promise(() => {}));

    await selectRepoAndEnterStep2();

    // Advance past the 60s client-side cap.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001);
    });

    expect(
      await screen.findByText(/Repo analizi 60 saniyeyi geçti/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tekrar dene' })).toBeTruthy();
  });

  it('retry button re-invokes the discover API', async () => {
    // First call hangs → timeout. Second call (after retry) resolves.
    let callCount = 0;
    discoverTasksMock.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise(() => {}); // hang forever
      }
      return Promise.resolve({
        owner: 'acme',
        repo: 'widget',
        tasks: [],
        analyzedAt: '',
      });
    });

    await selectRepoAndEnterStep2();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001);
    });

    const retry = await screen.findByRole('button', { name: 'Tekrar dene' });
    fireEvent.click(retry);

    await waitFor(() => {
      expect(discoverTasksMock).toHaveBeenCalledTimes(2);
    });
    // Both calls should use the separate owner/repo args.
    expect(discoverTasksMock).toHaveBeenNthCalledWith(1, 'acme', 'widget');
    expect(discoverTasksMock).toHaveBeenNthCalledWith(2, 'acme', 'widget');
  });

  it('shows a generic error state when discover rejects (non-timeout failure)', async () => {
    discoverTasksMock.mockRejectedValue(new Error('boom'));

    await selectRepoAndEnterStep2();

    await waitFor(() => {
      expect(
        screen.getByText(/Repo analizi sırasında bir hata oluştu/),
      ).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'Tekrar dene' })).toBeTruthy();
  });
});
