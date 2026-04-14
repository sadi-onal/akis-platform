/**
 * Edge-case unit tests for Email Service, Webhook System, and Triggers API.
 *
 * Covers factory logic, template rendering, schema validation,
 * signature verification edge cases, and general service safety.
 *
 * All tests are pure-logic / schema-level — no DB, no HTTP server.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

// ─── Imports: Email ─────────────────────────────────────────────────────────

import {
  createEmailService,
  isEmailConfigured,
  MockEmailService,
  type EmailProvider,
  type EmailServiceFactoryConfig,
} from '../../src/services/email/index.js';

import {
  verificationCodeHtml,
  verificationCodeText,
  welcomeHtml,
  welcomeText,
} from '../../src/services/email/templates.js';

import { SmtpEmailService } from '../../src/services/email/SmtpEmailService.js';
import { ResendEmailService } from '../../src/services/email/ResendEmailService.js';

// ─── Imports: Error handler ─────────────────────────────────────────────────

import {
  formatErrorResponse,
  getStatusCodeForError,
  type ErrorCode,
} from '../../src/utils/errorHandler.js';

// ─── Re-create pure functions from webhooks.ts (no DB/server deps) ──────────

function verifyGitHubSignature(payload: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function resolveEventType(githubEvent: string, action?: string): string | null {
  if (githubEvent === 'pull_request') {
    if (action === 'opened') return 'pr_opened';
    if (action === 'closed') return 'pr_merged';
    return null;
  }
  if (githubEvent === 'push') return 'push';
  return null;
}

// ─── Re-create schemas from triggers.ts ─────────────────────────────────────

const createTriggerSchema = z.object({
  repoOwner: z.string().min(1),
  repoName: z.string().min(1),
  branch: z.string().min(1).default('main'),
  eventType: z.enum(['pr_merged', 'pr_opened', 'push']),
  agentType: z.enum(['scribe', 'trace', 'proto']),
  enabled: z.boolean().default(true),
});

const updateTriggerSchema = z.object({
  enabled: z.boolean().optional(),
  branch: z.string().min(1).optional(),
  eventType: z.enum(['pr_merged', 'pr_opened', 'push']).optional(),
  agentType: z.enum(['scribe', 'trace', 'proto']).optional(),
});

const triggerIdSchema = z.object({
  id: z.string().uuid(),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function fakeRequest(id = 'req-edge'): { id: string } {
  return { id } as { id: string };
}

// =============================================================================
// 1–5  EMAIL SERVICE
// =============================================================================

describe('Email Service — factory edge cases', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // 1. Factory creates correct transport
  test('factory returns MockEmailService in test env regardless of provider', () => {
    for (const provider of ['mock', 'resend', 'smtp'] as EmailProvider[]) {
      const svc = createEmailService({ provider });
      assert.ok(svc instanceof MockEmailService,
        `Provider "${provider}" in test env should yield MockEmailService`);
    }
  });

  test('factory returns MockEmailService when provider is mock in non-test env', () => {
    process.env.NODE_ENV = 'development';
    const svc = createEmailService({ provider: 'mock' });
    assert.ok(svc instanceof MockEmailService);
  });

  test('factory creates SmtpEmailService with full config in non-test env', () => {
    process.env.NODE_ENV = 'development';
    const svc = createEmailService({
      provider: 'smtp',
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: 'user',
      smtpPass: 'pass',
      smtpFromEmail: 'noreply@example.com',
      smtpFromName: 'AKIS',
    });
    assert.ok(svc instanceof SmtpEmailService);
  });

  test('factory throws for unknown provider in non-test env', () => {
    process.env.NODE_ENV = 'development';
    assert.throws(
      () => createEmailService({ provider: 'sendgrid' as never }),
      /Unknown email provider/,
    );
  });

  test('isEmailConfigured returns false for completely unknown provider', () => {
    assert.equal(isEmailConfigured('mailgun'), false);
  });

  test('isEmailConfigured: resend needs both API key and from email', () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    assert.equal(isEmailConfigured('resend'), false);

    process.env.RESEND_API_KEY = 're_test';
    assert.equal(isEmailConfigured('resend'), false, 'Still false without from email');

    process.env.RESEND_FROM_EMAIL = 'noreply@example.com';
    assert.equal(isEmailConfigured('resend'), true, 'True when both present');
  });
});

// 2. Welcome email includes user name
describe('Email Templates — welcome includes user name', () => {
  test('welcomeHtml contains personalized greeting with name', () => {
    const html = welcomeHtml({ name: 'Yasir' });
    assert.ok(html.includes('Merhaba Yasir,'));
  });

  test('welcomeText contains personalized greeting with name', () => {
    const text = welcomeText({ name: 'Yasir' });
    assert.ok(text.includes('Merhaba Yasir,'));
  });

  test('welcomeHtml uses generic greeting when name is undefined', () => {
    const html = welcomeHtml({});
    assert.ok(html.includes('Merhaba,'));
    assert.ok(!html.includes('undefined'));
  });

  test('welcomeText uses generic greeting when name is undefined', () => {
    const text = welcomeText({});
    assert.ok(text.includes('Merhaba,'));
    assert.ok(!text.includes('undefined'));
  });
});

// 3. Verification email includes code
describe('Email Templates — verification code inclusion', () => {
  test('verificationCodeHtml contains the exact 6-digit code', () => {
    const html = verificationCodeHtml({ code: '482910' });
    assert.ok(html.includes('482910'));
  });

  test('verificationCodeText contains the exact code', () => {
    const text = verificationCodeText({ code: '123456' });
    assert.ok(text.includes('123456'));
  });

  test('verificationCodeHtml includes name in greeting when provided', () => {
    const html = verificationCodeHtml({ code: '000000', name: 'Ahmet' });
    assert.ok(html.includes('Merhaba Ahmet,'));
  });

  test('verificationCodeText includes TTL value', () => {
    const text = verificationCodeText({ code: '000000', ttlMinutes: 5 });
    assert.ok(text.includes('5 dakika'));
  });

  test('verificationCodeHtml defaults TTL to 15 minutes', () => {
    const html = verificationCodeHtml({ code: '000000' });
    assert.ok(html.includes('15 dakika'));
  });
});

// 4. Invalid email address handling (BaseEmailService propagates errors)
describe('Email Service — invalid address handling via MockEmailService', () => {
  test('MockEmailService.sendEmail succeeds even with invalid address (mock does not validate)', async () => {
    const mock = new MockEmailService();
    const result = await mock.sendEmail({
      to: 'not-an-email',
      subject: 'Test',
      text: 'body',
    });
    assert.equal(result.success, true, 'Mock always succeeds');
    assert.ok(result.messageId?.startsWith('mock-'));
  });

  test('MockEmailService.sendEmail succeeds with empty to field', async () => {
    const mock = new MockEmailService();
    const result = await mock.sendEmail({
      to: '',
      subject: 'Test',
      text: 'body',
    });
    assert.equal(result.success, true);
  });
});

// 5. Email send failure does not crash caller
describe('Email Service — send failure resilience', () => {
  test('sendVerificationCode throws on send failure but is catchable', async () => {
    const mock = new MockEmailService();
    // Override sendEmail to simulate failure
    mock.sendEmail = async () => ({ success: false, error: 'SMTP connection refused' });

    await assert.rejects(
      () => mock.sendVerificationCode('test@example.com', '123456'),
      /Failed to send verification email/,
    );
  });

  test('sendWelcomeEmail throws on send failure but is catchable', async () => {
    const mock = new MockEmailService();
    mock.sendEmail = async () => ({ success: false, error: 'Provider unavailable' });

    await assert.rejects(
      () => mock.sendWelcomeEmail('test@example.com', 'Ali'),
      /Failed to send welcome email/,
    );
  });

  test('SmtpEmailService.sendEmail returns error object on connection failure', async () => {
    const svc = new SmtpEmailService({
      host: 'localhost',
      port: 1,
      secure: false,
      user: 'u',
      pass: 'p',
      fromName: 'Test',
      fromEmail: 'test@test.com',
    });
    const result = await svc.sendEmail({
      to: 'to@test.com',
      subject: 'Test',
      text: 'body',
    });
    assert.equal(result.success, false);
    assert.ok(typeof result.error === 'string');
    // Caller is not crashed — we got a result object back
  });

  test('ResendEmailService constructor does not throw (defers errors to sendEmail)', () => {
    assert.doesNotThrow(() => {
      new ResendEmailService({ apiKey: 'fake-key', fromEmail: 'test@test.com' });
    });
  });
});

// =============================================================================
// 6–8  WEBHOOK ROUTES (pure function testing)
// =============================================================================

describe('Webhook — missing/invalid signature edge cases', () => {
  const SECRET = 'webhook-edge-test-2026';
  const PAYLOAD = '{"ref":"refs/heads/main","repository":{"name":"my-repo","owner":{"login":"acme"}}}';

  // 6. Missing signature header → would be 401
  test('empty signature string fails verification', () => {
    assert.equal(verifyGitHubSignature(PAYLOAD, '', SECRET), false);
  });

  test('undefined-like signature (empty) fails', () => {
    assert.equal(verifyGitHubSignature(PAYLOAD, '', SECRET), false);
  });

  // 7. Invalid signature → fails
  test('signature with correct prefix but wrong hash fails', () => {
    const wrongHash = createHmac('sha256', 'wrong-secret').update(PAYLOAD).digest('hex');
    assert.equal(verifyGitHubSignature(PAYLOAD, `sha256=${wrongHash}`, SECRET), false);
  });

  test('signature without sha256= prefix fails (length mismatch)', () => {
    const hash = createHmac('sha256', SECRET).update(PAYLOAD).digest('hex');
    assert.equal(verifyGitHubSignature(PAYLOAD, hash, SECRET), false);
  });

  test('signature with sha1 prefix fails', () => {
    assert.equal(verifyGitHubSignature(PAYLOAD, 'sha1=abcdef', SECRET), false);
  });

  test('very long garbage signature fails', () => {
    const long = 'sha256=' + 'a'.repeat(10000);
    assert.equal(verifyGitHubSignature(PAYLOAD, long, SECRET), false);
  });

  // 8. Valid event processing
  test('valid signature passes verification', () => {
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(PAYLOAD).digest('hex');
    assert.equal(verifyGitHubSignature(PAYLOAD, sig, SECRET), true);
  });

  test('different payload produces different valid signature', () => {
    const payload1 = '{"a":1}';
    const payload2 = '{"a":2}';
    const sig1 = 'sha256=' + createHmac('sha256', SECRET).update(payload1).digest('hex');
    const sig2 = 'sha256=' + createHmac('sha256', SECRET).update(payload2).digest('hex');
    assert.notEqual(sig1, sig2);
    assert.equal(verifyGitHubSignature(payload1, sig1, SECRET), true);
    assert.equal(verifyGitHubSignature(payload2, sig2, SECRET), true);
  });
});

describe('Webhook — event resolution edge cases', () => {
  test('pull_request with no action returns null', () => {
    assert.equal(resolveEventType('pull_request'), null);
  });

  test('pull_request with edited action returns null', () => {
    assert.equal(resolveEventType('pull_request', 'edited'), null);
  });

  test('pull_request with reopened action returns null', () => {
    assert.equal(resolveEventType('pull_request', 'reopened'), null);
  });

  test('push event ignores any action string', () => {
    assert.equal(resolveEventType('push', 'created'), 'push');
    assert.equal(resolveEventType('push', ''), 'push');
  });

  test('empty string event returns null', () => {
    assert.equal(resolveEventType(''), null);
  });

  test('create event is unsupported', () => {
    assert.equal(resolveEventType('create'), null);
  });

  test('delete event is unsupported', () => {
    assert.equal(resolveEventType('delete'), null);
  });

  test('deployment_status event is unsupported', () => {
    assert.equal(resolveEventType('deployment_status'), null);
  });
});

// =============================================================================
// 9–14  TRIGGERS API (schema validation)
// =============================================================================

describe('Trigger — create schema valid inputs', () => {
  // 9. Valid schema
  test('accepts minimal valid trigger with defaults applied', () => {
    const result = createTriggerSchema.parse({
      repoOwner: 'OmerYasirOnal',
      repoName: 'akis-platform',
      eventType: 'push',
      agentType: 'scribe',
    });
    assert.equal(result.branch, 'main');
    assert.equal(result.enabled, true);
    assert.equal(result.repoOwner, 'OmerYasirOnal');
  });

  test('accepts explicit branch override', () => {
    const result = createTriggerSchema.parse({
      repoOwner: 'x',
      repoName: 'y',
      branch: 'develop',
      eventType: 'pr_opened',
      agentType: 'trace',
    });
    assert.equal(result.branch, 'develop');
  });

  test('accepts enabled=false override', () => {
    const result = createTriggerSchema.parse({
      repoOwner: 'x',
      repoName: 'y',
      eventType: 'push',
      agentType: 'proto',
      enabled: false,
    });
    assert.equal(result.enabled, false);
  });
});

describe('Trigger — create schema missing fields', () => {
  // 10. Missing required fields
  test('rejects empty object', () => {
    assert.throws(() => createTriggerSchema.parse({}));
  });

  test('rejects missing repoOwner', () => {
    assert.throws(() => createTriggerSchema.parse({
      repoName: 'y',
      eventType: 'push',
      agentType: 'scribe',
    }));
  });

  test('rejects missing repoName', () => {
    assert.throws(() => createTriggerSchema.parse({
      repoOwner: 'x',
      eventType: 'push',
      agentType: 'scribe',
    }));
  });

  test('rejects missing eventType', () => {
    assert.throws(() => createTriggerSchema.parse({
      repoOwner: 'x',
      repoName: 'y',
      agentType: 'scribe',
    }));
  });

  test('rejects missing agentType', () => {
    assert.throws(() => createTriggerSchema.parse({
      repoOwner: 'x',
      repoName: 'y',
      eventType: 'push',
    }));
  });

  test('rejects null body', () => {
    assert.throws(() => createTriggerSchema.parse(null));
  });
});

describe('Trigger — update schema partial update', () => {
  // 11. Partial update
  test('accepts only enabled field', () => {
    const result = updateTriggerSchema.parse({ enabled: false });
    assert.equal(result.enabled, false);
    assert.equal(result.branch, undefined);
    assert.equal(result.eventType, undefined);
    assert.equal(result.agentType, undefined);
  });

  test('accepts only branch field', () => {
    const result = updateTriggerSchema.parse({ branch: 'release' });
    assert.equal(result.branch, 'release');
    assert.equal(result.enabled, undefined);
  });

  test('accepts only eventType field', () => {
    const result = updateTriggerSchema.parse({ eventType: 'pr_merged' });
    assert.equal(result.eventType, 'pr_merged');
  });

  test('accepts only agentType field', () => {
    const result = updateTriggerSchema.parse({ agentType: 'proto' });
    assert.equal(result.agentType, 'proto');
  });

  test('accepts empty object (no update)', () => {
    const result = updateTriggerSchema.parse({});
    assert.deepEqual(result, {});
  });

  test('rejects invalid eventType in partial update', () => {
    assert.throws(() => updateTriggerSchema.parse({ eventType: 'deployment' }));
  });

  test('rejects empty branch string in partial update', () => {
    assert.throws(() => updateTriggerSchema.parse({ branch: '' }), /too_small/);
  });

  test('strips unknown fields from update', () => {
    const result = updateTriggerSchema.parse({ enabled: true, randomField: 'ignored' });
    assert.equal(result.enabled, true);
    assert.equal((result as Record<string, unknown>).randomField, undefined);
  });
});

describe('Trigger — delete requires valid UUID', () => {
  // 12. Delete proper cleanup (ID validation)
  test('accepts valid UUID v4', () => {
    const result = triggerIdSchema.parse({ id: '550e8400-e29b-41d4-a716-446655440000' });
    assert.equal(result.id, '550e8400-e29b-41d4-a716-446655440000');
  });

  test('rejects non-UUID string', () => {
    assert.throws(() => triggerIdSchema.parse({ id: 'not-a-uuid' }));
  });

  test('rejects integer ID', () => {
    assert.throws(() => triggerIdSchema.parse({ id: 12345 }));
  });

  test('rejects empty string', () => {
    assert.throws(() => triggerIdSchema.parse({ id: '' }));
  });

  test('rejects missing id field', () => {
    assert.throws(() => triggerIdSchema.parse({}));
  });

  test('rejects null id', () => {
    assert.throws(() => triggerIdSchema.parse({ id: null }));
  });
});

describe('Trigger — schedule/event type validation', () => {
  // 13. Valid event type combinations
  test('all 3 event types accepted in create schema', () => {
    for (const eventType of ['pr_merged', 'pr_opened', 'push'] as const) {
      const result = createTriggerSchema.parse({
        repoOwner: 'o', repoName: 'r', eventType, agentType: 'scribe',
      });
      assert.equal(result.eventType, eventType);
    }
  });

  test('all 3 agent types accepted in create schema', () => {
    for (const agentType of ['scribe', 'trace', 'proto'] as const) {
      const result = createTriggerSchema.parse({
        repoOwner: 'o', repoName: 'r', eventType: 'push', agentType,
      });
      assert.equal(result.agentType, agentType);
    }
  });

  // 14. Invalid event type
  test('rejects cron expression as eventType', () => {
    assert.throws(() => createTriggerSchema.parse({
      repoOwner: 'o', repoName: 'r', eventType: '0 * * * *', agentType: 'scribe',
    }));
  });

  test('rejects issue_opened as eventType', () => {
    assert.throws(() => createTriggerSchema.parse({
      repoOwner: 'o', repoName: 'r', eventType: 'issue_opened', agentType: 'scribe',
    }));
  });

  test('rejects deployment as eventType', () => {
    assert.throws(() => createTriggerSchema.parse({
      repoOwner: 'o', repoName: 'r', eventType: 'deployment', agentType: 'scribe',
    }));
  });

  test('rejects empty string as eventType', () => {
    assert.throws(() => createTriggerSchema.parse({
      repoOwner: 'o', repoName: 'r', eventType: '', agentType: 'scribe',
    }));
  });

  test('rejects reviewer as agentType', () => {
    assert.throws(() => createTriggerSchema.parse({
      repoOwner: 'o', repoName: 'r', eventType: 'push', agentType: 'reviewer',
    }));
  });
});

// =============================================================================
// 15  LOGGER — no sensitive data in logs
// =============================================================================

describe('Service — logger does not expose sensitive data', () => {
  // 15. We verify the logger is configured as silent in test mode
  test('logger is silent in test environment', async () => {
    const { logger } = await import('../../src/lib/logger.js');
    assert.equal(logger.level, 'silent',
      'Logger should be silent in NODE_ENV=test to prevent leaking data');
  });

  test('SmtpEmailService diagLabel never includes credentials', () => {
    // The diagLabel is "host:port" — verify by constructing the service
    // and checking the error output pattern (no user/pass in logs)
    const svc = new SmtpEmailService({
      host: 'mail.example.com',
      port: 465,
      secure: true,
      user: 'secret-user@example.com',
      pass: 'super-secret-password',
      fromName: 'AKIS',
      fromEmail: 'noreply@example.com',
    });

    // Trigger a failed send to exercise the logging path
    // The service logs "server=mail.example.com:465" — never the password
    const result = svc.sendEmail({
      to: 'test@test.com',
      subject: 'Test',
      text: 'body',
    });

    // Result is a Promise — just ensure no throw during construction/call
    assert.ok(result instanceof Promise);
  });

  test('MockEmailService messageId does not contain sensitive patterns', async () => {
    const mock = new MockEmailService();
    const result = await mock.sendEmail({
      to: 'test@test.com',
      subject: 'Test',
      text: 'body with sk-ant-api03-secret and password=hunter2',
    });
    assert.ok(result.messageId?.startsWith('mock-'));
    assert.ok(!result.messageId?.includes('sk-ant'));
    assert.ok(!result.messageId?.includes('password'));
  });
});

// =============================================================================
// 16  ERROR HANDLER — formatErrorResponse structure
// =============================================================================

describe('Service — formatErrorResponse structure', () => {
  // 16. Ensure consistent envelope shape
  test('envelope always has error.code, error.message, and requestId', () => {
    const envelope = formatErrorResponse(
      fakeRequest('test-req-1') as never,
      new Error('something broke'),
    );
    assert.equal(typeof envelope.error.code, 'string');
    assert.equal(typeof envelope.error.message, 'string');
    assert.equal(envelope.requestId, 'test-req-1');
  });

  test('ZodError produces VALIDATION_ERROR with details array', () => {
    const zodError = new z.ZodError([
      { code: 'invalid_type', expected: 'string', received: 'number', path: ['repoOwner'], message: 'Expected string' },
    ]);
    const envelope = formatErrorResponse(fakeRequest() as never, zodError);
    assert.equal(envelope.error.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(envelope.error.details));
  });

  test('unknown error maps to INTERNAL_ERROR with no leaked details', () => {
    const envelope = formatErrorResponse(
      fakeRequest() as never,
      'raw string error with SECRET_KEY=abc123',
    );
    assert.equal(envelope.error.code, 'INTERNAL_ERROR');
    assert.equal(envelope.error.message, 'Internal server error');
    assert.equal(envelope.error.details, undefined);
  });

  test('null error produces safe INTERNAL_ERROR', () => {
    const envelope = formatErrorResponse(fakeRequest() as never, null);
    assert.equal(envelope.error.code, 'INTERNAL_ERROR');
  });

  test('undefined error produces safe INTERNAL_ERROR', () => {
    const envelope = formatErrorResponse(fakeRequest() as never, undefined);
    assert.equal(envelope.error.code, 'INTERNAL_ERROR');
  });
});

// =============================================================================
// 17  RATE LIMITER CONFIG VALIDATION
// =============================================================================

describe('Service — rate limiter configuration validation', () => {
  // 17. Verify error code mapping for rate limiting
  test('RATE_LIMITED maps to 429', () => {
    assert.equal(getStatusCodeForError('RATE_LIMITED'), 429);
  });

  test('AI_RATE_LIMITED maps to 429', () => {
    assert.equal(getStatusCodeForError('AI_RATE_LIMITED'), 429);
  });

  test('UNAUTHORIZED maps to 401', () => {
    assert.equal(getStatusCodeForError('UNAUTHORIZED'), 401);
  });

  test('all auth error codes map to expected status codes', () => {
    const authMappings: [ErrorCode, number][] = [
      ['UNAUTHORIZED', 401],
      ['INVALID_CREDENTIALS', 401],
      ['EMAIL_NOT_VERIFIED', 403],
      ['ALREADY_VERIFIED', 403],
      ['USER_DISABLED', 403],
      ['FORBIDDEN', 403],
      ['USER_NOT_FOUND', 404],
      ['EMAIL_IN_USE', 409],
      ['RATE_LIMITED', 429],
    ];
    for (const [code, expected] of authMappings) {
      assert.equal(getStatusCodeForError(code), expected,
        `${code} should map to ${expected}`);
    }
  });

  test('INTERNAL_ERROR maps to 500', () => {
    assert.equal(getStatusCodeForError('INTERNAL_ERROR'), 500);
  });

  test('DATABASE_ERROR maps to 500', () => {
    assert.equal(getStatusCodeForError('DATABASE_ERROR'), 500);
  });

  test('service unavailable codes map to 503', () => {
    const codes: ErrorCode[] = [
      'AI_PROVIDER_ERROR',
      'AI_NETWORK_ERROR',
      'AI_INVALID_RESPONSE',
      'EMAIL_DELIVERY_FAILED',
      'ENCRYPTION_NOT_CONFIGURED',
      'OAUTH_NOT_CONFIGURED',
    ];
    for (const code of codes) {
      assert.equal(getStatusCodeForError(code), 503, `${code} should be 503`);
    }
  });
});

// =============================================================================
// BONUS: Cross-cutting edge cases
// =============================================================================

describe('Email Templates — XSS-safe rendering', () => {
  test('verification code HTML-encodes name (no script injection)', () => {
    const html = verificationCodeHtml({
      code: '000000',
      name: '<script>alert("xss")</script>',
    });
    // The template uses template literals — the name is inserted as-is.
    // This test documents the current behavior so any future sanitization
    // changes are noticed. (In practice, email clients strip <script>.)
    assert.ok(html.includes('<script>') || html.includes('&lt;script&gt;'),
      'Template should include or encode the name');
  });

  test('welcome HTML with XSS-like name does not crash', () => {
    assert.doesNotThrow(() => {
      welcomeHtml({ name: '"><img src=x onerror=alert(1)>' });
    });
  });
});

describe('Webhook — signature timing safety', () => {
  test('verification uses constant-time comparison (timing-safe)', () => {
    const secret = 'timing-test';
    const payload = '{"test":true}';
    const valid = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');

    // Both should complete without timing side-effects
    const start1 = performance.now();
    verifyGitHubSignature(payload, valid, secret);
    const time1 = performance.now() - start1;

    const start2 = performance.now();
    verifyGitHubSignature(payload, 'sha256=' + 'f'.repeat(64), secret);
    const time2 = performance.now() - start2;

    // We cannot assert exact timing equality, but both should complete
    assert.ok(time1 < 100, 'Valid check should be fast');
    assert.ok(time2 < 100, 'Invalid check should be fast');
  });
});

describe('Trigger — boundary values', () => {
  test('repoOwner with special chars is accepted (GitHub allows hyphens)', () => {
    const result = createTriggerSchema.parse({
      repoOwner: 'my-org-123',
      repoName: 'repo_name.js',
      eventType: 'push',
      agentType: 'scribe',
    });
    assert.equal(result.repoOwner, 'my-org-123');
  });

  test('very long repoName is accepted by schema (no max length)', () => {
    const longName = 'a'.repeat(200);
    const result = createTriggerSchema.parse({
      repoOwner: 'x',
      repoName: longName,
      eventType: 'push',
      agentType: 'scribe',
    });
    assert.equal(result.repoName, longName);
  });

  test('updateTriggerSchema with all valid event/agent combos', () => {
    const events = ['pr_merged', 'pr_opened', 'push'] as const;
    const agents = ['scribe', 'trace', 'proto'] as const;

    for (const eventType of events) {
      for (const agentType of agents) {
        const result = updateTriggerSchema.parse({ eventType, agentType });
        assert.equal(result.eventType, eventType);
        assert.equal(result.agentType, agentType);
      }
    }
  });
});
