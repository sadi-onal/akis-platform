/**
 * Centralized dev-mode helper. Returns false unconditionally when
 * NODE_ENV === 'production' so that DEV_MODE=true cannot accidentally
 * enable auth bypasses or other dev-only code paths in production.
 */
export function isDevMode(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.DEV_MODE === 'true';
}
