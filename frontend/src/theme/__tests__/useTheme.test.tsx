import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useTheme } from '../useTheme';
import { ThemeContext, type ThemeContextValue } from '../ThemeContext';

/**
 * useTheme is a thin context consumer. Two things to verify:
 *   1. Returns the context value when wrapped in a provider.
 *   2. Throws with a helpful message when called outside a provider.
 *
 * We intentionally do NOT use ThemeProvider here — that's a separate
 * component with its own side effects (localStorage, matchMedia, dataset
 * mutation). Testing useTheme in isolation gives a focused unit test.
 */

function makeWrapper(value: ThemeContextValue) {
  return ({ children }: { children: ReactNode }) => (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

describe('useTheme', () => {
  it('returns the context value when consumed inside ThemeContext.Provider', () => {
    const setTheme = () => {};
    const toggleTheme = () => {};
    const value: ThemeContextValue = {
      theme: 'dark',
      isDark: true,
      isLight: false,
      setTheme,
      toggleTheme,
    };

    const { result } = renderHook(() => useTheme(), {
      wrapper: makeWrapper(value),
    });

    expect(result.current).toBe(value);
    expect(result.current.theme).toBe('dark');
    expect(result.current.isDark).toBe(true);
    expect(result.current.isLight).toBe(false);
    expect(result.current.setTheme).toBe(setTheme);
    expect(result.current.toggleTheme).toBe(toggleTheme);
  });

  it('returns light-theme context shape too', () => {
    const value: ThemeContextValue = {
      theme: 'light',
      isDark: false,
      isLight: true,
      setTheme: () => {},
      toggleTheme: () => {},
    };

    const { result } = renderHook(() => useTheme(), {
      wrapper: makeWrapper(value),
    });

    expect(result.current.theme).toBe('light');
    expect(result.current.isDark).toBe(false);
    expect(result.current.isLight).toBe(true);
  });

  it('throws when called outside a ThemeProvider', () => {
    // renderHook surfaces the thrown error on .result.error in older RTL,
    // newer (RTL 16) re-throws synchronously when rendering. We catch via
    // expect().toThrow which executes the render in a try/catch.
    // Silence the React error boundary console.error spam for this test.
    const originalError = console.error;
    console.error = () => {};
    try {
      expect(() => renderHook(() => useTheme())).toThrow(
        /useTheme must be used within a ThemeProvider/,
      );
    } finally {
      console.error = originalError;
    }
  });
});
