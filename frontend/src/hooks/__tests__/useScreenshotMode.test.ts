import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useScreenshotMode } from '../useScreenshotMode';

describe('useScreenshotMode', () => {
  const originalLocation = window.location;

  /**
   * Replace window.location with a writable mock so we can drive different
   * search strings per test. jsdom's location is read-only otherwise.
   */
  function setSearch(search: string) {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...originalLocation, search } as Location,
    });
  }

  beforeEach(() => {
    setSearch('');
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it('returns false when no query string is present', () => {
    setSearch('');
    const { result } = renderHook(() => useScreenshotMode());
    expect(result.current).toBe(false);
  });

  it('returns false when "shot" param is absent', () => {
    setSearch('?foo=bar');
    const { result } = renderHook(() => useScreenshotMode());
    expect(result.current).toBe(false);
  });

  it('returns true when shot=1', () => {
    setSearch('?shot=1');
    const { result } = renderHook(() => useScreenshotMode());
    expect(result.current).toBe(true);
  });

  it('returns false when shot has any value other than "1"', () => {
    setSearch('?shot=true');
    const { result: r1 } = renderHook(() => useScreenshotMode());
    expect(r1.current).toBe(false);

    setSearch('?shot=0');
    const { result: r2 } = renderHook(() => useScreenshotMode());
    expect(r2.current).toBe(false);

    setSearch('?shot=yes');
    const { result: r3 } = renderHook(() => useScreenshotMode());
    expect(r3.current).toBe(false);
  });

  it('handles shot=1 alongside other params', () => {
    setSearch('?foo=bar&shot=1&baz=qux');
    const { result } = renderHook(() => useScreenshotMode());
    expect(result.current).toBe(true);
  });

  it('returns the same value across re-renders (memoized)', () => {
    setSearch('?shot=1');
    const { result, rerender } = renderHook(() => useScreenshotMode());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
