import { describe, it, expect } from 'vitest';
import { formatConfidence, confidenceToPercent } from '../format';

// ─────────────────────────────────────────────────────────
// formatConfidence — display string formatter
// ─────────────────────────────────────────────────────────

describe('formatConfidence', () => {
  it('returns "N/A" for undefined', () => {
    expect(formatConfidence(undefined)).toBe('N/A');
  });

  it('returns "N/A" for null', () => {
    expect(formatConfidence(null)).toBe('N/A');
  });

  it('returns "N/A" for NaN number', () => {
    expect(formatConfidence(NaN)).toBe('N/A');
  });

  it('returns "N/A" for unparseable string', () => {
    expect(formatConfidence('not-a-number')).toBe('N/A');
  });

  it('formats 0-1 float as percentage (Scribe backend output)', () => {
    expect(formatConfidence(0.85)).toBe('85%');
  });

  it('formats 0-1 boundary float as 100%', () => {
    expect(formatConfidence(1)).toBe('100%');
  });

  it('formats parseable string in 0-1 range', () => {
    expect(formatConfidence('0.5')).toBe('50%');
  });

  it('formats parseable string in 1-100 range', () => {
    expect(formatConfidence('50')).toBe('50%');
  });

  it('formats 1-100 integer as percentage', () => {
    expect(formatConfidence(85)).toBe('85%');
  });

  it('formats 1-100 boundary 100 as 100%', () => {
    expect(formatConfidence(100)).toBe('100%');
  });

  it('returns "0%" for exact 0', () => {
    expect(formatConfidence(0)).toBe('0%');
  });

  it('rounds 0-1 floats to nearest percent', () => {
    expect(formatConfidence(0.876)).toBe('88%');
    expect(formatConfidence(0.124)).toBe('12%');
  });

  it('rounds 1-100 values to nearest integer', () => {
    expect(formatConfidence(85.6)).toBe('86%');
    expect(formatConfidence(85.4)).toBe('85%');
  });

  it('uses fallback formatting for values > 100', () => {
    expect(formatConfidence(150)).toBe('150%');
  });

  it('uses fallback formatting for negative values', () => {
    // negative is not 0 and not in either positive range, so hits fallback Math.round.
    // JS Math.round rounds half toward +Infinity: Math.round(-0.5) === 0.
    expect(formatConfidence(-0.5)).toBe('0%');
    expect(formatConfidence(-1.6)).toBe('-2%');
  });
});

// ─────────────────────────────────────────────────────────
// confidenceToPercent — 0-100 number for progress bars
// ─────────────────────────────────────────────────────────

describe('confidenceToPercent', () => {
  it('returns 0 for undefined', () => {
    expect(confidenceToPercent(undefined)).toBe(0);
  });

  it('returns 0 for null', () => {
    expect(confidenceToPercent(null)).toBe(0);
  });

  it('converts 0-1 float to 0-100 integer', () => {
    expect(confidenceToPercent(0.85)).toBe(85);
  });

  it('keeps 1-100 number as percentage integer', () => {
    expect(confidenceToPercent(75)).toBe(75);
  });

  it('returns 100 for boundary 1 (treated as 100%)', () => {
    expect(confidenceToPercent(1)).toBe(100);
  });

  it('returns 100 for boundary 100', () => {
    expect(confidenceToPercent(100)).toBe(100);
  });

  it('returns 0 for exact 0 (out of all positive ranges)', () => {
    expect(confidenceToPercent(0)).toBe(0);
  });

  it('returns 0 for negative numbers (out of range)', () => {
    expect(confidenceToPercent(-1)).toBe(0);
    expect(confidenceToPercent(-0.5)).toBe(0);
  });

  it('returns 0 for values > 100 (out of range)', () => {
    expect(confidenceToPercent(150)).toBe(0);
  });

  it('rounds intermediate values', () => {
    expect(confidenceToPercent(0.876)).toBe(88);
    expect(confidenceToPercent(85.4)).toBe(85);
  });
});
