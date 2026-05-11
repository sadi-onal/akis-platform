/**
 * ThemeProvider — context + persistence + system-preference behaviour
 *
 * Covers:
 *  - Reads stored theme from localStorage on mount; falls back to system
 *    preference (prefers-color-scheme: dark)
 *  - Falls back to "dark" when matchMedia is unavailable
 *  - Applies theme to document.documentElement (dataset + .dark class)
 *  - setTheme persists to localStorage and updates context value
 *  - toggleTheme flips dark <-> light and persists
 *  - System-preference changes only take effect when the user has not
 *    expressed an explicit preference
 *  - Localstorage throw paths swallowed gracefully
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import { ThemeProvider } from '../ThemeProvider';
import { useTheme } from '../useTheme';
import { THEME_STORAGE_KEY, DARK_MEDIA_QUERY } from '../ThemeContext';

// ── Test consumer ────────────────────────────────────

function ThemeConsumer() {
  const { theme, isDark, isLight, setTheme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="isDark">{String(isDark)}</span>
      <span data-testid="isLight">{String(isLight)}</span>
      <button onClick={() => setTheme('light')}>set-light</button>
      <button onClick={() => setTheme('dark')}>set-dark</button>
      <button onClick={toggleTheme}>toggle</button>
    </div>
  );
}

// ── matchMedia helpers ───────────────────────────────

type Listener = (event: MediaQueryListEvent) => void;

function installMatchMedia(opts: { matches?: boolean } = {}) {
  const listeners: Listener[] = [];
  const mql: MediaQueryList = {
    matches: opts.matches ?? false,
    media: DARK_MEDIA_QUERY,
    onchange: null,
    addEventListener: ((_: string, l: Listener) => {
      listeners.push(l);
    }) as MediaQueryList['addEventListener'],
    removeEventListener: ((_: string, l: Listener) => {
      const idx = listeners.indexOf(l);
      if (idx !== -1) listeners.splice(idx, 1);
    }) as MediaQueryList['removeEventListener'],
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
  const mock = vi.fn().mockReturnValue(mql);
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: mock,
  });
  return {
    fire: (matches: boolean) => {
      const event = { matches, media: DARK_MEDIA_QUERY } as MediaQueryListEvent;
      [...listeners].forEach((l) => l(event));
    },
    listenerCount: () => listeners.length,
    mock,
  };
}

// ── Tests ────────────────────────────────────────────

describe('ThemeProvider', () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    // Restore matchMedia so other suites don't see our stub.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  });

  it('initialises from localStorage when set (dark)', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    installMatchMedia({ matches: false }); // system says light, but stored beats it
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(screen.getByTestId('isDark')).toHaveTextContent('true');
    expect(screen.getByTestId('isLight')).toHaveTextContent('false');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('initialises from localStorage when set (light)', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    installMatchMedia({ matches: true });
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(screen.getByTestId('isLight')).toHaveTextContent('true');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('ignores localStorage values other than "dark"/"light" and uses system preference', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'auto');
    installMatchMedia({ matches: true });
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );
    // matchMedia.matches=true → system says dark
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
  });

  it('falls back to system preference when localStorage is empty', () => {
    installMatchMedia({ matches: true });
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
  });

  it('falls back to system preference (light)', () => {
    installMatchMedia({ matches: false });
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
  });

  it('falls back to "dark" when matchMedia is unavailable at init', () => {
    // The first call inside useState's lazy initialiser is getSystemTheme(),
    // which short-circuits to "dark" when window.matchMedia is missing.
    // We restore matchMedia synchronously after the initial render so the
    // mounting useEffect (which also calls matchMedia) doesn't blow up.
    const stash = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const mm = installMatchMedia({ matches: false });
    // Re-install undefined only for the very next access from the
    // initialiser; we approximate this by counting reads.
    // Simpler: install a getter that returns undefined the first time and
    // the real mock thereafter.
    let calls = 0;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      get() {
        calls += 1;
        return calls === 1 ? undefined : mm.mock;
      },
    });

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');

    // restore for the rest of the suite
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: stash,
    });
  });

  it('setTheme persists to localStorage and applies the theme to <html>', () => {
    installMatchMedia({ matches: false });
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('light');

    act(() => {
      screen.getByText('set-dark').click();
    });
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    act(() => {
      screen.getByText('set-light').click();
    });
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('toggleTheme flips between dark and light and persists', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    installMatchMedia({ matches: false });
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');

    act(() => {
      screen.getByText('toggle').click();
    });
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    act(() => {
      screen.getByText('toggle').click();
    });
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('responds to system-preference changes only when no explicit preference is set', () => {
    const mm = installMatchMedia({ matches: false });
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('light');

    // System flips to dark — should update because the user never picked.
    act(() => {
      mm.fire(true);
    });
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');

    // Now the user picks light explicitly.
    act(() => {
      screen.getByText('set-light').click();
    });
    expect(screen.getByTestId('theme')).toHaveTextContent('light');

    // System flips again — explicit pref locks the value.
    act(() => {
      mm.fire(true);
    });
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
  });

  it('removes its media-query listener on unmount', () => {
    const mm = installMatchMedia({ matches: false });
    const { unmount } = render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );
    expect(mm.listenerCount()).toBe(1);
    unmount();
    expect(mm.listenerCount()).toBe(0);
  });

  it('silently swallows localStorage.setItem errors (e.g. quota / private mode)', () => {
    installMatchMedia({ matches: false });
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    // Should not throw — the catch in persistTheme swallows it. State still updates.
    expect(() => {
      act(() => {
        screen.getByText('set-dark').click();
      });
    }).not.toThrow();
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');

    setItemSpy.mockRestore();
  });

  it('silently swallows localStorage.getItem errors during init', () => {
    const getItemSpy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('SecurityError');
      });
    installMatchMedia({ matches: true });

    expect(() => {
      render(
        <ThemeProvider>
          <ThemeConsumer />
        </ThemeProvider>,
      );
    }).not.toThrow();

    // Init catch returns null → falls back to system → matches=true → dark
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');

    getItemSpy.mockRestore();
  });
});
