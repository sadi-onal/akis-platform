const RETURN_TO_KEY = 'akis_returnTo';

/**
 * Sanitize returnTo path: allow only same-origin relative paths starting with /.
 * Prevents open-redirect vulnerabilities (e.g. https://evil.com).
 */
export function sanitizeReturnTo(path: string | undefined): string | null {
  if (!path || typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === '/') return null;
  if (!trimmed.startsWith('/')) return null;
  if (trimmed.startsWith('//')) return null;
  // Reject backslash-prefix open-redirect vectors. Browsers normalize `\` → `/`
  // in some URL contexts, so `\\evil.com`, `\evil.com`, `/\evil.com`,
  // and `//\evil.com` can all become protocol-relative hosts.
  if (trimmed.startsWith('\\')) return null;
  // First non-slash character must not be a backslash (handles `/\evil.com`).
  const firstNonSlash = trimmed.replace(/^\/+/, '');
  if (firstNonSlash.startsWith('\\')) return null;
  try {
    new URL(trimmed, 'https://example.com');
  } catch {
    return null;
  }
  return trimmed;
}

export function getReturnTo(): string | null {
  try {
    const stored = sessionStorage.getItem(RETURN_TO_KEY);
    return sanitizeReturnTo(stored ?? undefined);
  } catch {
    return null;
  }
}

export function setReturnTo(path: string): void {
  const safe = sanitizeReturnTo(path);
  if (!safe) return;
  try {
    sessionStorage.setItem(RETURN_TO_KEY, safe);
  } catch {
    // Safari private mode raises QuotaExceededError; swallow silently
    // to mirror getReturnTo's tolerance.
  }
}

export function clearReturnTo(): void {
  sessionStorage.removeItem(RETURN_TO_KEY);
}
