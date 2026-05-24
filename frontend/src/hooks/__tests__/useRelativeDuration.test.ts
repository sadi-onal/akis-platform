import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRelativeDuration } from '../useRelativeDuration';

describe('useRelativeDuration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty string when startedAt is null', () => {
    const { result } = renderHook(() => useRelativeDuration(null, true));
    expect(result.current).toBe('');
  });

  it('returns empty string when not live', () => {
    const { result } = renderHook(() => useRelativeDuration('2026-05-23T22:25:00Z', false));
    expect(result.current).toBe('');
  });

  it('shows "1 dakikadan az" under 60s', () => {
    const now = new Date('2026-05-23T22:25:30Z').getTime();
    vi.setSystemTime(now);
    const startedAt = '2026-05-23T22:25:00Z'; // 30s ago
    const { result } = renderHook(() => useRelativeDuration(startedAt, true));
    expect(result.current).toBe('1 dakikadan az');
  });

  it('shows "1 dakikadır çalışıyor" at exactly 1 minute', () => {
    const now = new Date('2026-05-23T22:26:00Z').getTime();
    vi.setSystemTime(now);
    const { result } = renderHook(() =>
      useRelativeDuration('2026-05-23T22:25:00Z', true)
    );
    expect(result.current).toBe('1 dakikadır çalışıyor');
  });

  it('shows "5 dakikadır çalışıyor" at 5 minutes', () => {
    const now = new Date('2026-05-23T22:30:00Z').getTime();
    vi.setSystemTime(now);
    const { result } = renderHook(() =>
      useRelativeDuration('2026-05-23T22:25:00Z', true)
    );
    expect(result.current).toBe('5 dakikadır çalışıyor');
  });

  it('updates after interval ticks', () => {
    const t0 = new Date('2026-05-23T22:25:00Z').getTime();
    vi.setSystemTime(t0);
    const { result } = renderHook(() =>
      useRelativeDuration('2026-05-23T22:25:00Z', true)
    );
    expect(result.current).toBe('1 dakikadan az');

    // Advance fake clock by 60 seconds — vitest's advanceTimersByTime moves
    // both the timer queue AND Date.now() forward. Two 30s ticks fire the
    // interval and bump elapsed time to 60s, so the hook flips to the
    // minute-floor label.
    act(() => {
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current).toBe('1 dakikadır çalışıyor');
  });
});
