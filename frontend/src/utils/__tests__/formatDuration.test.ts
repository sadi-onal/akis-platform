import { describe, it, expect } from 'vitest';
import { formatDuration } from '../formatDuration';

describe('formatDuration', () => {
  it('returns empty string when durationMs is undefined', () => {
    expect(formatDuration(undefined)).toBe('');
  });

  it('returns empty string for negative input', () => {
    expect(formatDuration(-100)).toBe('');
  });

  it('formats under 60 seconds as "X sn"', () => {
    expect(formatDuration(3000)).toBe('3 sn');
    expect(formatDuration(59999)).toBe('59 sn');
  });

  it('formats 60s-3599s as "X dk Y sn" or "X dk"', () => {
    expect(formatDuration(60000)).toBe('1 dk');
    expect(formatDuration(98000)).toBe('1 dk 38 sn');
    expect(formatDuration(134000)).toBe('2 dk 14 sn');
    expect(formatDuration(125000)).toBe('2 dk 5 sn');
    // edge: when seconds < 5, suppress ("1 dk" not "1 dk 3 sn")
    expect(formatDuration(63000)).toBe('1 dk');
  });

  it('formats >= 1 hour as "X sa Y dk"', () => {
    expect(formatDuration(3600000)).toBe('1 sa');
    expect(formatDuration(3720000)).toBe('1 sa 2 dk');
    expect(formatDuration(7260000)).toBe('2 sa 1 dk');
  });
});
