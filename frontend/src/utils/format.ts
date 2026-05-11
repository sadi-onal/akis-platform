/**
 * Central confidence formatting — handles both 0-1 float and 0-100 integer.
 * Backend (Scribe) returns 0-1 float (e.g., 0.85).
 * This function normalizes to "85%" display string.
 */
export function formatConfidence(raw: number | string | undefined | null): string {
  if (raw === undefined || raw === null) return 'N/A';
  const num = typeof raw === 'string' ? parseFloat(raw) : raw;
  if (isNaN(num)) return 'N/A';

  // 0-1 float -> multiply by 100
  if (num > 0 && num <= 1) return `${Math.round(num * 100)}%`;
  // 1-100 -> already percentage
  if (num > 1 && num <= 100) return `${Math.round(num)}%`;
  // 0 (and -0, since -0 === 0 in JS) -> 0%
  if (num === 0) return '0%';
  // fallback
  return `${Math.round(num)}%`;
}

/**
 * Return confidence as a 0-100 number for progress bars etc.
 */
export function confidenceToPercent(raw: number | undefined | null): number {
  if (raw === undefined || raw === null) return 0;
  if (raw > 0 && raw <= 1) return Math.round(raw * 100);
  if (raw > 1 && raw <= 100) return Math.round(raw);
  return 0;
}
