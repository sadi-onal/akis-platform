import { describe, it, expect } from 'vitest';
import { errorCodeToFriendlyMessage, isStageConflictError } from '../errorMessages';

describe('errorCodeToFriendlyMessage', () => {
  // ── 1. RATE_LIMITED → "AI sağlayıcısı yoğun" ────────────────────────────
  it('maps AI_RATE_LIMITED to a "AI sağlayıcısı yoğun" title with warn severity', () => {
    const friendly = errorCodeToFriendlyMessage('AI_RATE_LIMITED');

    expect(friendly.title).toBe('AI sağlayıcısı yoğun');
    expect(friendly.severity).toBe('warn');
    expect(friendly.matched).toBe(true);
    expect(friendly.detail.length).toBeGreaterThan(0);
  });

  // ── 2. QUOTA_EXCEEDED → "AI kotası tükendi" ─────────────────────────────
  it('maps explicit QUOTA_EXCEEDED to "AI kotası tükendi"', () => {
    const friendly = errorCodeToFriendlyMessage('QUOTA_EXCEEDED');

    expect(friendly.title).toBe('AI kotası tükendi');
    expect(friendly.severity).toBe('error');
    expect(friendly.matched).toBe(true);
  });

  it('routes AI_PROVIDER_ERROR with "insufficient credits" message to quota class', () => {
    const friendly = errorCodeToFriendlyMessage(
      'AI_PROVIDER_ERROR',
      'OpenAI account has insufficient credits. Please add credits or update your API key.'
    );

    expect(friendly.title).toBe('AI kotası tükendi');
    expect(friendly.severity).toBe('error');
    expect(friendly.matched).toBe(true);
  });

  it('routes AI_PROVIDER_ERROR with billing/balance keyword to quota class', () => {
    const friendly = errorCodeToFriendlyMessage('AI_PROVIDER_ERROR', 'Anthropic balance exhausted');

    expect(friendly.title).toBe('AI kotası tükendi');
  });

  it('keeps AI_PROVIDER_ERROR as generic provider error when no quota hint', () => {
    const friendly = errorCodeToFriendlyMessage('AI_PROVIDER_ERROR', 'Unexpected server error');

    expect(friendly.title).toBe('AI sağlayıcısı hata döndürdü');
  });

  // ── 3. TIMEOUT → "Zaman aşımı" ──────────────────────────────────────────
  it('maps TRACE_AI_CALL_TIMEOUT to a "Zaman aşımı" title', () => {
    const friendly = errorCodeToFriendlyMessage('TRACE_AI_CALL_TIMEOUT');

    expect(friendly.title).toBe('Zaman aşımı');
    expect(friendly.severity).toBe('warn');
    expect(friendly.matched).toBe(true);
  });

  it('maps PIPELINE_TIMEOUT to a timeout title', () => {
    const friendly = errorCodeToFriendlyMessage('PIPELINE_TIMEOUT');

    expect(friendly.title).toContain('zaman aşımına');
    expect(friendly.matched).toBe(true);
    expect(friendly.detail).toMatch(/teknik detay/);
    expect(friendly.detail).not.toMatch(/Tekrar deneyebilirsiniz/);
  });

  // ── 4. NETWORK_ERROR → "Ağ bağlantısı hatası" ───────────────────────────
  it('maps AI_NETWORK_ERROR to a network-failure title', () => {
    const friendly = errorCodeToFriendlyMessage('AI_NETWORK_ERROR');

    expect(friendly.title).toBe('Ağ bağlantısı hatası');
    expect(friendly.severity).toBe('error');
  });

  it('maps NETWORK_ERROR to a connection-dropped title', () => {
    const friendly = errorCodeToFriendlyMessage('NETWORK_ERROR');

    expect(friendly.title).toBe('Bağlantı kesildi');
    expect(friendly.severity).toBe('warn');
  });

  // ── 5. Fallback for unknown code ────────────────────────────────────────
  it('falls back to a generic title + raw message for an unknown code', () => {
    const friendly = errorCodeToFriendlyMessage(
      'SOMETHING_NEW_BACKEND_NEVER_SHIPPED',
      'Hata mesajı: bilinmeyen sorun.'
    );

    expect(friendly.matched).toBe(false);
    expect(friendly.detail).toBe('Hata mesajı: bilinmeyen sorun.');
    expect(friendly.title).toBe('Akış başarısız');
  });

  it('falls back to a generic detail string when no fallback message provided', () => {
    const friendly = errorCodeToFriendlyMessage('UNKNOWN');

    expect(friendly.matched).toBe(false);
    expect(friendly.detail.length).toBeGreaterThan(0);
  });

  it('handles undefined code gracefully (returns fallback)', () => {
    const friendly = errorCodeToFriendlyMessage(undefined, 'Boş kod testi');

    expect(friendly.matched).toBe(false);
    expect(friendly.detail).toBe('Boş kod testi');
  });

  // ── GitHub recoveryAction-mapped codes ──────────────────────────────────
  it('maps GITHUB_TOKEN_INVALID to a token-expired title', () => {
    const friendly = errorCodeToFriendlyMessage('GITHUB_TOKEN_INVALID');

    expect(friendly.title).toContain('GitHub');
    expect(friendly.matched).toBe(true);
  });

  it('maps AI_KEY_MISSING to an api-key-missing title', () => {
    const friendly = errorCodeToFriendlyMessage('AI_KEY_MISSING');

    expect(friendly.title).toBe('AI anahtarı eksik');
    expect(friendly.matched).toBe(true);
  });
});

// ── #637 — isStageConflictError ──────────────────────────────────────────
describe('isStageConflictError', () => {
  it('returns true for an ApiError with code INVALID_STAGE', () => {
    const err = Object.assign(new Error('Invalid stage: expected x, got y'), {
      code: 'INVALID_STAGE',
      statusCode: 400,
    });
    expect(isStageConflictError(err)).toBe(true);
  });

  it('returns true for an error whose message starts with "Invalid stage:"', () => {
    const err = new Error('Invalid stage: expected awaiting_push_confirm, got proto_building');
    expect(isStageConflictError(err)).toBe(true);
  });

  it('returns false for a generic error', () => {
    expect(isStageConflictError(new Error('something else'))).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isStageConflictError(null)).toBe(false);
    expect(isStageConflictError(undefined)).toBe(false);
  });

  it('returns false for a non-object', () => {
    expect(isStageConflictError('string')).toBe(false);
    expect(isStageConflictError(42)).toBe(false);
  });

  it('returns true for a plain object with code INVALID_STAGE', () => {
    expect(isStageConflictError({ code: 'INVALID_STAGE' })).toBe(true);
  });
});
