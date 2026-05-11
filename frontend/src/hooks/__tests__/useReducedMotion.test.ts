import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReducedMotion } from '../useReducedMotion';

/**
 * Minimal MediaQueryList stand-in. We control:
 *   - the `matches` boolean (initial state),
 *   - the change listener so we can fire it from the test.
 */
type Listener = (e: MediaQueryListEvent) => void;
interface MockMQL {
  matches: boolean;
  media: string;
  addEventListener: (type: string, l: Listener) => void;
  removeEventListener: (type: string, l: Listener) => void;
  // legacy:
  addListener: () => void;
  removeListener: () => void;
  dispatchEvent: () => boolean;
  onchange: null;
}

function makeMockMatchMedia(initial: boolean): {
  matchMedia: (q: string) => MockMQL;
  trigger: (matches: boolean) => void;
} {
  let listener: Listener | null = null;
  const mql: MockMQL = {
    matches: initial,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_type, l) => {
      listener = l;
    },
    removeEventListener: (_type, _l) => {
      listener = null;
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
    onchange: null,
  };
  return {
    matchMedia: (_q: string) => mql,
    trigger: (matches: boolean) => {
      mql.matches = matches;
      listener?.({ matches } as MediaQueryListEvent);
    },
  };
}

describe('useReducedMotion', () => {
  const original = window.matchMedia;

  beforeEach(() => {
    // Reset to a stable default before each test
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: original,
    });
    vi.restoreAllMocks();
  });

  it('returns false when prefers-reduced-motion is "no-preference"', () => {
    const mock = makeMockMatchMedia(false);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: mock.matchMedia,
    });
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });

  it('returns true when prefers-reduced-motion is "reduce"', () => {
    const mock = makeMockMatchMedia(true);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: mock.matchMedia,
    });
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
  });

  it('updates when the media query changes (false → true)', () => {
    const mock = makeMockMatchMedia(false);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: mock.matchMedia,
    });
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);

    act(() => {
      mock.trigger(true);
    });
    expect(result.current).toBe(true);
  });

  it('updates when the media query changes (true → false)', () => {
    const mock = makeMockMatchMedia(true);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: mock.matchMedia,
    });
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);

    act(() => {
      mock.trigger(false);
    });
    expect(result.current).toBe(false);
  });

  it('returns false and does not throw when window.matchMedia is undefined', () => {
    // Older browsers / minimal test stubs lack matchMedia. The hook must
    // degrade to a safe `false` instead of throwing.
    // matchMedia is already set to `undefined` by beforeEach.
    expect(window.matchMedia).toBeUndefined();
    const { result, unmount } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
    // And cleanup must be a no-op (not throw on unmount either).
    expect(() => unmount()).not.toThrow();
  });

  it('removes the event listener on unmount', () => {
    const removeSpy = vi.fn();
    const addSpy = vi.fn();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (_q: string) => ({
        matches: false,
        media: '(prefers-reduced-motion: reduce)',
        addEventListener: addSpy,
        removeEventListener: removeSpy,
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
        onchange: null,
      }),
    });

    const { unmount } = renderHook(() => useReducedMotion());
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).not.toHaveBeenCalled();

    unmount();
    expect(removeSpy).toHaveBeenCalledTimes(1);
    // Same handler reference added and removed
    expect(removeSpy.mock.calls[0][0]).toBe(addSpy.mock.calls[0][0]);
    expect(removeSpy.mock.calls[0][1]).toBe(addSpy.mock.calls[0][1]);
  });
});
