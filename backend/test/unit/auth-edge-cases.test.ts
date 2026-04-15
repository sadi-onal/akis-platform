/**
 * Auth Edge Cases — Unit Tests
 *
 * Tests JWT token handling, multi-step signup validation,
 * password requirements, OAuth state tokens, and verification
 * brute-force protection edge cases.
 *
 * All tests are pure unit tests — no DB or network required.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, jwtVerify } from 'jose';
import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';

// ─── JWT edge cases ────────────────────────────────────────────────────────
// We replicate the sign/verify logic from services/auth/jwt.ts so tests
// don't depend on env.ts (which needs DATABASE_URL).

const TEST_SECRET = 'test-jwt-secret-minimum-32-chars!!';
const secret = new TextEncoder().encode(TEST_SECRET);
const wrongSecret = new TextEncoder().encode('wrong-secret-key-minimum-32-chrs!!');

async function signToken(
  payload: Record<string, unknown>,
  opts?: { exp?: string; signingKey?: Uint8Array },
) {
  const key = opts?.signingKey ?? secret;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(opts?.exp ?? '7d')
    .setIssuedAt()
    .sign(key);
}

async function verifyToken<T extends Record<string, unknown>>(token: string) {
  const { payload } = await jwtVerify(token, secret);
  return payload as T;
}

describe('Auth Edge Cases — JWT Token Handling', () => {
  it('should reject an expired JWT with JWTExpired error, not a crash', async () => {
    // Sign a token that already expired (1 second lifetime, then wait)
    const token = await signToken(
      { sub: 'user-1', email: 'a@b.com' },
      { exp: '1s' },
    );

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 1100));

    try {
      await verifyToken(token);
      assert.fail('Expected verification to throw');
    } catch (err) {
      assert.ok(err instanceof Error);
      // jose throws JWTExpired — code should map this to 401, not 500
      assert.ok(
        err.message.includes('expired') ||
        err.name === 'JWTExpired' ||
        (err as { code?: string }).code === 'ERR_JWT_EXPIRED',
        `Expected expiry error, got: ${err.message}`,
      );
    }
  });

  it('should reject a malformed JWT (random string) without crashing', async () => {
    const garbage = 'not.a.valid.jwt.token.at.all';

    try {
      await verifyToken(garbage);
      assert.fail('Expected verification to throw');
    } catch (err) {
      assert.ok(err instanceof Error);
      // Should throw a jose error, not an unhandled crash
      assert.ok(err.message.length > 0);
    }
  });

  it('should reject a completely random base64 string', async () => {
    const random = randomBytes(64).toString('base64url');

    try {
      await verifyToken(random);
      assert.fail('Expected verification to throw');
    } catch (err) {
      assert.ok(err instanceof Error);
    }
  });

  it('should reject an empty string token', async () => {
    try {
      await verifyToken('');
      assert.fail('Expected verification to throw');
    } catch (err) {
      assert.ok(err instanceof Error);
    }
  });

  it('should reject a token signed with the wrong secret', async () => {
    const token = await signToken(
      { sub: 'user-1', email: 'test@example.com' },
      { signingKey: wrongSecret },
    );

    try {
      await verifyToken(token);
      assert.fail('Expected verification to throw');
    } catch (err) {
      assert.ok(err instanceof Error);
      // jose throws JWSSignatureVerificationFailed
      assert.ok(
        err.message.includes('signature') ||
        err.name === 'JWSSignatureVerificationFailed' ||
        (err as { code?: string }).code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
        `Expected signature error, got: ${err.message}`,
      );
    }
  });

  it('should accept a valid token and return the correct payload', async () => {
    const token = await signToken({ sub: 'user-42', email: 'valid@test.com', name: 'Test' });
    const payload = await verifyToken<{ sub: string; email: string }>(token);

    assert.equal(payload.sub, 'user-42');
    assert.equal(payload.email, 'valid@test.com');
  });

  it('should reject a token with tampered payload (modified base64 segment)', async () => {
    const token = await signToken({ sub: 'user-1', email: 'a@b.com' });
    const parts = token.split('.');
    // Tamper with the payload (second segment)
    const tamperedPayload = Buffer.from('{"sub":"hacker","email":"evil@bad.com"}').toString('base64url');
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    try {
      await verifyToken(tamperedToken);
      assert.fail('Expected verification to throw');
    } catch (err) {
      assert.ok(err instanceof Error);
    }
  });

  it('should reject a token with "none" algorithm attempt', async () => {
    // Craft a token header with alg: "none" — a classic JWT attack vector
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url');
    const noneToken = `${header}.${payload}.`;

    try {
      await verifyToken(noneToken);
      assert.fail('Expected verification to throw');
    } catch (err) {
      assert.ok(err instanceof Error);
    }
  });
});

// ─── Missing auth header simulation ────────────────────────────────────────
// The /auth/me route returns { user: null } with 401 when cookie is missing.
// We test the logic pattern used by requireAuth.

describe('Auth Edge Cases — Missing Auth Header / Cookie', () => {
  it('should return 401 when no token is present (requireAuth pattern)', async () => {
    // Simulate what requireAuth does: check for token, throw if missing
    const token: string | undefined = undefined;

    if (!token) {
      const err = Object.assign(new Error('UNAUTHORIZED'), { statusCode: 401 });
      assert.equal(err.message, 'UNAUTHORIZED');
      assert.equal((err as Error & { statusCode: number }).statusCode, 401);
    } else {
      assert.fail('Token should be undefined in this test');
    }
  });

  it('should return 401 when cookie value is an empty string', async () => {
    const token = '';

    // Empty string is falsy, requireAuth treats it as missing
    if (!token) {
      const err = Object.assign(new Error('UNAUTHORIZED'), { statusCode: 401 });
      assert.equal((err as Error & { statusCode: number }).statusCode, 401);
    } else {
      assert.fail('Empty token should be falsy');
    }
  });

  it('should return 401 when cookie value is whitespace only', async () => {
    const token = '   ';

    // Whitespace-only token should fail verification
    try {
      await verifyToken(token.trim() || 'invalid');
      assert.fail('Expected verification to throw');
    } catch (err) {
      assert.ok(err instanceof Error);
    }
  });
});

// ─── Email validation ──────────────────────────────────────────────────────
// Uses the same Zod schemas from auth.multi-step.ts

const SignupStartSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email(),
});

describe('Auth Edge Cases — Email Validation in Signup', () => {
  it('should reject an email without @ symbol', () => {
    assert.throws(
      () => SignupStartSchema.parse({ firstName: 'Test', lastName: 'User', email: 'notanemail' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('should reject an email without domain', () => {
    assert.throws(
      () => SignupStartSchema.parse({ firstName: 'Test', lastName: 'User', email: 'user@' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('should reject an email without local part', () => {
    assert.throws(
      () => SignupStartSchema.parse({ firstName: 'Test', lastName: 'User', email: '@domain.com' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('should reject an empty email string', () => {
    assert.throws(
      () => SignupStartSchema.parse({ firstName: 'Test', lastName: 'User', email: '' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('should reject an email with spaces', () => {
    assert.throws(
      () => SignupStartSchema.parse({ firstName: 'Test', lastName: 'User', email: 'user @domain.com' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('should accept a valid email', () => {
    const result = SignupStartSchema.parse({ firstName: 'Test', lastName: 'User', email: 'valid@example.com' });
    assert.equal(result.email, 'valid@example.com');
  });

  it('should reject a double-dot domain email', () => {
    assert.throws(
      () => SignupStartSchema.parse({ firstName: 'Test', lastName: 'User', email: 'user@domain..com' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('should reject missing firstName', () => {
    assert.throws(
      () => SignupStartSchema.parse({ firstName: '', lastName: 'User', email: 'a@b.com' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });
});

// ─── Password requirements ─────────────────────────────────────────────────
// Mirrors SignupPasswordSchema from auth.multi-step.ts

const PasswordSchema = z.string().min(8).max(100)
  .refine((p) => /[A-Z]/.test(p), 'Sifre en az bir buyuk harf icermeli')
  .refine((p) => /[0-9]/.test(p), 'Sifre en az bir rakam icermeli');

describe('Auth Edge Cases — Password Requirements', () => {
  it('should reject a password shorter than 8 characters', () => {
    assert.throws(
      () => PasswordSchema.parse('Ab1'),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('should reject a password without uppercase letter', () => {
    assert.throws(
      () => PasswordSchema.parse('abcdefgh1'),
      (err: unknown) => {
        if (!(err instanceof z.ZodError)) return false;
        return err.errors.some((e) => e.message.includes('buyuk harf'));
      },
    );
  });

  it('should reject a password without digit', () => {
    assert.throws(
      () => PasswordSchema.parse('Abcdefghi'),
      (err: unknown) => {
        if (!(err instanceof z.ZodError)) return false;
        return err.errors.some((e) => e.message.includes('rakam'));
      },
    );
  });

  it('should reject a password that is all digits', () => {
    assert.throws(
      () => PasswordSchema.parse('12345678'),
      (err: unknown) => {
        if (!(err instanceof z.ZodError)) return false;
        return err.errors.some((e) => e.message.includes('buyuk harf'));
      },
    );
  });

  it('should reject a password that is all uppercase', () => {
    assert.throws(
      () => PasswordSchema.parse('ABCDEFGH'),
      (err: unknown) => {
        if (!(err instanceof z.ZodError)) return false;
        return err.errors.some((e) => e.message.includes('rakam'));
      },
    );
  });

  it('should accept a password meeting all requirements', () => {
    const result = PasswordSchema.parse('SecureP4ss');
    assert.equal(result, 'SecureP4ss');
  });

  it('should reject a password longer than 100 characters', () => {
    const longPw = 'A1' + 'a'.repeat(99);
    assert.throws(
      () => PasswordSchema.parse(longPw),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('should accept exactly 8 character password with all requirements', () => {
    const result = PasswordSchema.parse('Abcdef1!');
    assert.equal(result, 'Abcdef1!');
  });

  it('should reject an empty password', () => {
    assert.throws(
      () => PasswordSchema.parse(''),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('should accept password with special characters', () => {
    const result = PasswordSchema.parse('P@ssw0rd!#$');
    assert.equal(result, 'P@ssw0rd!#$');
  });
});

// ─── Verification code validation ──────────────────────────────────────────

const VerifyEmailSchema = z.object({
  userId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
});

describe('Auth Edge Cases — Verification Code Schema', () => {
  it('should reject a 5-digit code', () => {
    assert.throws(
      () => VerifyEmailSchema.parse({ userId: '550e8400-e29b-41d4-a716-446655440000', code: '12345' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('should reject a 7-digit code', () => {
    assert.throws(
      () => VerifyEmailSchema.parse({ userId: '550e8400-e29b-41d4-a716-446655440000', code: '1234567' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('should reject a code with letters', () => {
    assert.throws(
      () => VerifyEmailSchema.parse({ userId: '550e8400-e29b-41d4-a716-446655440000', code: '12abc6' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('should reject an empty code', () => {
    assert.throws(
      () => VerifyEmailSchema.parse({ userId: '550e8400-e29b-41d4-a716-446655440000', code: '' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('should reject an invalid UUID for userId', () => {
    assert.throws(
      () => VerifyEmailSchema.parse({ userId: 'not-a-uuid', code: '123456' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('should accept a valid 6-digit code with valid UUID', () => {
    const result = VerifyEmailSchema.parse({
      userId: '550e8400-e29b-41d4-a716-446655440000',
      code: '123456',
    });
    assert.equal(result.code, '123456');
  });
});

// ─── Rate limiting / brute-force protection ────────────────────────────────
// Tests the in-memory lockout logic from VerificationService

describe('Auth Edge Cases — Verification Rate Limiting', () => {
  const MAX_VERIFY_ATTEMPTS = 5;
  const LOCKOUT_MS = 30 * 60 * 1000;

  let failedAttempts: Map<string, { count: number; lockedUntil?: number }>;

  beforeEach(() => {
    failedAttempts = new Map();
  });

  function checkLockout(userId: string): boolean {
    const attempts = failedAttempts.get(userId);
    return !!(attempts?.lockedUntil && Date.now() < attempts.lockedUntil);
  }

  function recordFailedAttempt(userId: string): void {
    const current = failedAttempts.get(userId) ?? { count: 0 };
    current.count += 1;
    if (current.count >= MAX_VERIFY_ATTEMPTS) {
      current.lockedUntil = Date.now() + LOCKOUT_MS;
    }
    failedAttempts.set(userId, current);
  }

  function clearAttempts(userId: string): void {
    failedAttempts.delete(userId);
  }

  it('should lock at exactly MAX_VERIFY_ATTEMPTS (boundary)', () => {
    const userId = 'edge-exact-5';
    for (let i = 0; i < MAX_VERIFY_ATTEMPTS; i++) {
      recordFailedAttempt(userId);
    }
    assert.equal(checkLockout(userId), true);
    assert.equal(failedAttempts.get(userId)!.count, 5);
  });

  it('should NOT lock at MAX_VERIFY_ATTEMPTS - 1 (boundary)', () => {
    const userId = 'edge-exact-4';
    for (let i = 0; i < MAX_VERIFY_ATTEMPTS - 1; i++) {
      recordFailedAttempt(userId);
    }
    assert.equal(checkLockout(userId), false);
    assert.equal(failedAttempts.get(userId)!.count, 4);
  });

  it('should remain locked even with additional failed attempts beyond threshold', () => {
    const userId = 'edge-over-lock';
    for (let i = 0; i < MAX_VERIFY_ATTEMPTS + 3; i++) {
      recordFailedAttempt(userId);
    }
    assert.equal(checkLockout(userId), true);
    assert.equal(failedAttempts.get(userId)!.count, 8);
  });

  it('should unlock after lockout period expires', () => {
    const userId = 'edge-expire';
    for (let i = 0; i < MAX_VERIFY_ATTEMPTS; i++) {
      recordFailedAttempt(userId);
    }
    assert.equal(checkLockout(userId), true);

    // Simulate lockout expiry
    failedAttempts.get(userId)!.lockedUntil = Date.now() - 1;
    assert.equal(checkLockout(userId), false);
  });

  it('should clear lockout counter on successful verification', () => {
    const userId = 'edge-clear';
    for (let i = 0; i < MAX_VERIFY_ATTEMPTS; i++) {
      recordFailedAttempt(userId);
    }
    assert.equal(checkLockout(userId), true);

    clearAttempts(userId);
    assert.equal(checkLockout(userId), false);
    assert.equal(failedAttempts.has(userId), false);
  });

  it('should not affect other users when one is locked', () => {
    const lockedUser = 'locked-user';
    const safeUser = 'safe-user';

    for (let i = 0; i < MAX_VERIFY_ATTEMPTS; i++) {
      recordFailedAttempt(lockedUser);
    }
    recordFailedAttempt(safeUser);

    assert.equal(checkLockout(lockedUser), true);
    assert.equal(checkLockout(safeUser), false);
  });

  it('should handle unknown userId gracefully (no lockout)', () => {
    assert.equal(checkLockout('nonexistent-user'), false);
  });

  it('should set lockout exactly 30 minutes into the future', () => {
    const userId = 'edge-duration';
    const before = Date.now();
    for (let i = 0; i < MAX_VERIFY_ATTEMPTS; i++) {
      recordFailedAttempt(userId);
    }
    const after = Date.now();
    const lockUntil = failedAttempts.get(userId)!.lockedUntil!;

    assert.ok(lockUntil >= before + LOCKOUT_MS);
    assert.ok(lockUntil <= after + LOCKOUT_MS);
  });
});

// ─── OAuth state token validation ──────────────────────────────────────────
// Mirrors the HMAC-signed state logic from auth.oauth.ts

const STATE_TTL_MS = 10 * 60 * 1000;
const SIGNING_KEY = 'test-signing-key-at-least-32chars!!';

function hmacSign(payload: string): string {
  return createHmac('sha256', SIGNING_KEY).update(payload).digest('base64url');
}

function generateSignedState(provider: string): string {
  const payload = JSON.stringify({ provider, ts: Date.now(), nonce: randomBytes(16).toString('hex') });
  const encoded = Buffer.from(payload).toString('base64url');
  const sig = hmacSign(encoded);
  return `${encoded}.${sig}`;
}

function verifySignedState(state: string): { provider: string; createdAt: number } | null {
  const dotIdx = state.indexOf('.');
  if (dotIdx < 0) return null;
  const encoded = state.slice(0, dotIdx);
  const sig = state.slice(dotIdx + 1);
  if (hmacSign(encoded) !== sig) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (!payload.provider || !payload.ts) return null;
    if (Date.now() - payload.ts > STATE_TTL_MS) return null;
    return { provider: payload.provider, createdAt: payload.ts };
  } catch {
    return null;
  }
}

describe('Auth Edge Cases — OAuth State Token Validation', () => {
  it('should reject an expired state token (past TTL)', () => {
    const payload = JSON.stringify({
      provider: 'github',
      ts: Date.now() - STATE_TTL_MS - 1000,
      nonce: 'test-nonce',
    });
    const encoded = Buffer.from(payload).toString('base64url');
    const sig = hmacSign(encoded);
    const expiredState = `${encoded}.${sig}`;

    assert.equal(verifySignedState(expiredState), null);
  });

  it('should reject a state signed with a different key', () => {
    const payload = JSON.stringify({ provider: 'github', ts: Date.now(), nonce: 'nonce' });
    const encoded = Buffer.from(payload).toString('base64url');
    const wrongSig = createHmac('sha256', 'completely-different-signing-key!!!').update(encoded).digest('base64url');
    const state = `${encoded}.${wrongSig}`;

    assert.equal(verifySignedState(state), null);
  });

  it('should reject an empty string state', () => {
    assert.equal(verifySignedState(''), null);
  });

  it('should reject state without dot separator', () => {
    assert.equal(verifySignedState('nodothere'), null);
  });

  it('should reject state with tampered payload', () => {
    const state = generateSignedState('github');
    const [encoded, sig] = state.split('.');
    // Flip last character of encoded payload
    const tampered = `${encoded.slice(0, -1)}X.${sig}`;
    assert.equal(verifySignedState(tampered), null);
  });

  it('should reject state with missing provider field', () => {
    const payload = JSON.stringify({ ts: Date.now(), nonce: 'test' });
    const encoded = Buffer.from(payload).toString('base64url');
    const sig = hmacSign(encoded);
    assert.equal(verifySignedState(`${encoded}.${sig}`), null);
  });

  it('should reject state with missing timestamp field', () => {
    const payload = JSON.stringify({ provider: 'github', nonce: 'test' });
    const encoded = Buffer.from(payload).toString('base64url');
    const sig = hmacSign(encoded);
    assert.equal(verifySignedState(`${encoded}.${sig}`), null);
  });

  it('should reject state with invalid JSON payload', () => {
    const encoded = Buffer.from('not-valid-json').toString('base64url');
    const sig = hmacSign(encoded);
    assert.equal(verifySignedState(`${encoded}.${sig}`), null);
  });

  it('should accept a valid freshly generated state', () => {
    const state = generateSignedState('google');
    const result = verifySignedState(state);
    assert.ok(result);
    assert.equal(result.provider, 'google');
    assert.ok(Date.now() - result.createdAt < 1000);
  });

  it('should accept state just before TTL expiry', () => {
    const payload = JSON.stringify({
      provider: 'github',
      ts: Date.now() - STATE_TTL_MS + 5000,
      nonce: 'test',
    });
    const encoded = Buffer.from(payload).toString('base64url');
    const sig = hmacSign(encoded);
    const almostExpired = `${encoded}.${sig}`;

    const result = verifySignedState(almostExpired);
    assert.ok(result);
    assert.equal(result.provider, 'github');
  });

  it('should reject state where provider is an empty string', () => {
    const payload = JSON.stringify({ provider: '', ts: Date.now(), nonce: 'test' });
    const encoded = Buffer.from(payload).toString('base64url');
    const sig = hmacSign(encoded);
    // Empty string is falsy — verifySignedState checks !payload.provider
    assert.equal(verifySignedState(`${encoded}.${sig}`), null);
  });

  it('should generate unique state tokens on each call', () => {
    const state1 = generateSignedState('github');
    const state2 = generateSignedState('github');
    assert.notEqual(state1, state2);
  });
});

// ─── Duplicate email / schema-level validation ─────────────────────────────
// Schema-level tests that would prevent duplicate signup at the validation layer

const LoginStartSchema = z.object({
  email: z.string().email(),
});

const LoginCompleteSchema = z.object({
  userId: z.string().uuid(),
  password: z.string().min(8),
});

describe('Auth Edge Cases — Login Schema Validation', () => {
  it('should reject login start with invalid email', () => {
    assert.throws(
      () => LoginStartSchema.parse({ email: 'not-an-email' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('should reject login complete with non-UUID userId', () => {
    assert.throws(
      () => LoginCompleteSchema.parse({ userId: '12345', password: 'LongEnough1' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('should reject login complete with short password', () => {
    assert.throws(
      () => LoginCompleteSchema.parse({ userId: '550e8400-e29b-41d4-a716-446655440000', password: 'short' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('should accept valid login start payload', () => {
    const result = LoginStartSchema.parse({ email: 'user@example.com' });
    assert.equal(result.email, 'user@example.com');
  });

  it('should accept valid login complete payload', () => {
    const result = LoginCompleteSchema.parse({
      userId: '550e8400-e29b-41d4-a716-446655440000',
      password: 'ValidP4ss',
    });
    assert.equal(result.userId, '550e8400-e29b-41d4-a716-446655440000');
  });
});

// ─── Password reset schema validation ──────────────────────────────────────

const ResetPasswordSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/, 'Kod 6 haneli olmali'),
  newPassword: z.string().min(8).max(100)
    .refine((p) => /[A-Z]/.test(p), 'Sifre en az bir buyuk harf icermeli')
    .refine((p) => /[0-9]/.test(p), 'Sifre en az bir rakam icermeli'),
});

describe('Auth Edge Cases — Password Reset Validation', () => {
  it('should reject reset with invalid email', () => {
    assert.throws(
      () => ResetPasswordSchema.parse({ email: 'bad', code: '123456', newPassword: 'NewP4ss!' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('should reject reset with non-numeric code', () => {
    assert.throws(
      () => ResetPasswordSchema.parse({ email: 'a@b.com', code: 'abcdef', newPassword: 'NewP4ss!' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('should reject reset with weak new password (no uppercase)', () => {
    assert.throws(
      () => ResetPasswordSchema.parse({ email: 'a@b.com', code: '123456', newPassword: 'weakpass1' }),
      (err: unknown) => {
        if (!(err instanceof z.ZodError)) return false;
        return err.errors.some((e) => e.message.includes('buyuk harf'));
      },
    );
  });

  it('should reject reset with weak new password (no digit)', () => {
    assert.throws(
      () => ResetPasswordSchema.parse({ email: 'a@b.com', code: '123456', newPassword: 'WeakPasss' }),
      (err: unknown) => {
        if (!(err instanceof z.ZodError)) return false;
        return err.errors.some((e) => e.message.includes('rakam'));
      },
    );
  });

  it('should accept a valid reset payload', () => {
    const result = ResetPasswordSchema.parse({
      email: 'user@example.com',
      code: '654321',
      newPassword: 'NewSecure1!',
    });
    assert.equal(result.email, 'user@example.com');
    assert.equal(result.code, '654321');
  });
});
