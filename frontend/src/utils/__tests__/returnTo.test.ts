import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  sanitizeReturnTo,
  getReturnTo,
  setReturnTo,
  clearReturnTo,
} from '../returnTo';

// ─────────────────────────────────────────────────────────
// sanitizeReturnTo — open-redirect protection
// ─────────────────────────────────────────────────────────

describe('sanitizeReturnTo', () => {
  it('returns null for undefined input', () => {
    expect(sanitizeReturnTo(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(sanitizeReturnTo('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(sanitizeReturnTo('   ')).toBeNull();
  });

  it('returns null for plain "/" root', () => {
    expect(sanitizeReturnTo('/')).toBeNull();
  });

  it('returns null for paths not starting with /', () => {
    expect(sanitizeReturnTo('dashboard')).toBeNull();
    expect(sanitizeReturnTo('settings/profile')).toBeNull();
  });

  it('rejects protocol-relative URLs (// prefix)', () => {
    // Open-redirect vector: //evil.com is treated as a host by browsers.
    expect(sanitizeReturnTo('//evil.com')).toBeNull();
    expect(sanitizeReturnTo('//evil.com/path')).toBeNull();
  });

  it('rejects absolute external URLs', () => {
    expect(sanitizeReturnTo('https://evil.com')).toBeNull();
    expect(sanitizeReturnTo('http://attacker.example')).toBeNull();
  });

  it('rejects non-string inputs cast through type assertion', () => {
    // Function guards against null/non-string at runtime.
    // @ts-expect-error — intentional misuse to exercise the guard
    expect(sanitizeReturnTo(null)).toBeNull();
    // @ts-expect-error — intentional misuse
    expect(sanitizeReturnTo(123)).toBeNull();
  });

  it('accepts valid same-origin paths', () => {
    expect(sanitizeReturnTo('/dashboard')).toBe('/dashboard');
    expect(sanitizeReturnTo('/settings/profile')).toBe('/settings/profile');
    expect(sanitizeReturnTo('/chat/123')).toBe('/chat/123');
  });

  it('preserves query strings', () => {
    expect(sanitizeReturnTo('/chat?id=abc&mode=plan')).toBe('/chat?id=abc&mode=plan');
  });

  it('preserves hash fragments', () => {
    expect(sanitizeReturnTo('/dashboard#section')).toBe('/dashboard#section');
  });

  it('trims whitespace before validating', () => {
    expect(sanitizeReturnTo('  /dashboard  ')).toBe('/dashboard');
  });
});

// ─────────────────────────────────────────────────────────
// getReturnTo / setReturnTo / clearReturnTo — sessionStorage interaction
// ─────────────────────────────────────────────────────────

describe('returnTo sessionStorage helpers', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  describe('setReturnTo', () => {
    it('stores a valid path in sessionStorage', () => {
      setReturnTo('/dashboard');
      expect(sessionStorage.getItem('akis_returnTo')).toBe('/dashboard');
    });

    it('does not store invalid paths', () => {
      setReturnTo('https://evil.com');
      expect(sessionStorage.getItem('akis_returnTo')).toBeNull();
    });

    it('does not store protocol-relative URLs', () => {
      setReturnTo('//evil.com/path');
      expect(sessionStorage.getItem('akis_returnTo')).toBeNull();
    });

    it('overwrites previously stored value with new valid path', () => {
      setReturnTo('/first');
      setReturnTo('/second');
      expect(sessionStorage.getItem('akis_returnTo')).toBe('/second');
    });
  });

  describe('getReturnTo', () => {
    it('returns null when nothing is stored', () => {
      expect(getReturnTo()).toBeNull();
    });

    it('returns the stored value when valid', () => {
      sessionStorage.setItem('akis_returnTo', '/dashboard');
      expect(getReturnTo()).toBe('/dashboard');
    });

    it('returns null when stored value is invalid (defence-in-depth)', () => {
      // If somehow tampered, sanitizer rejects it.
      sessionStorage.setItem('akis_returnTo', 'https://evil.com');
      expect(getReturnTo()).toBeNull();
    });

    it('returns null on sessionStorage read error (e.g. private mode)', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('storage disabled');
      });
      expect(getReturnTo()).toBeNull();
    });
  });

  describe('clearReturnTo', () => {
    it('removes stored value', () => {
      sessionStorage.setItem('akis_returnTo', '/dashboard');
      clearReturnTo();
      expect(sessionStorage.getItem('akis_returnTo')).toBeNull();
    });

    it('is safe to call when no value is stored', () => {
      expect(() => clearReturnTo()).not.toThrow();
    });
  });
});
