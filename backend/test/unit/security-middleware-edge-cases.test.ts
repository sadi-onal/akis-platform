/**
 * Security Middleware & Request Processing — Edge Case Tests
 *
 * Validates CORS configuration, cookie security, error handler sanitization,
 * request parsing, and content security policies.
 *
 * All tests are pure unit/lightweight integration — no DB or external services.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import {
  formatErrorResponse,
  getStatusCodeForError,
  sendError,
  type ErrorCode,
  type ErrorEnvelope,
} from '../../src/utils/errorHandler.js';
import {
  JobNotFoundError,
  InvalidStateTransitionError,
  DatabaseError,
  AIProviderError,
  TraceAutomationError,
} from '../../src/core/errors.js';
import { corsPlugin } from '../../src/plugins/security/cors.js';
import { cookiesPlugin } from '../../src/plugins/security/cookies.js';
import { helmetPlugin } from '../../src/plugins/security/helmet.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────

function fakeRequest(id = 'req-sec-001'): { id: string } {
  return { id } as { id: string };
}

function fakeReply(): {
  statusCode: number;
  body: unknown;
  code: (c: number) => { send: (b: unknown) => void };
} {
  const state = { statusCode: 0, body: null as unknown };
  return {
    get statusCode() { return state.statusCode; },
    get body() { return state.body; },
    code(c: number) {
      state.statusCode = c;
      return {
        send(b: unknown) {
          state.body = b;
        },
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Request Sanitization — XSS, SQL injection, path traversal, Unicode
// ═══════════════════════════════════════════════════════════════════════════

describe('Security: Request Sanitization', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });

    // Register a simple echo route for body testing
    app.post('/echo', async (request) => {
      return { received: request.body };
    });

    // Route that reads URL params
    app.get('/resource/:id', async (request) => {
      const { id } = request.params as { id: string };
      return { id };
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  test('XSS in request body — angle brackets preserved in JSON (Drizzle parameterizes on DB layer)', async () => {
    const xssPayload = {
      name: '<script>alert("xss")</script>',
      description: '<img onerror="alert(1)" src=x>',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      payload: xssPayload,
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    // Fastify passes JSON through as-is; sanitization happens at the DB layer
    // via parameterized queries (Drizzle ORM) and output encoding on frontend.
    // The key invariant: the server does NOT crash on XSS payloads.
    assert.strictEqual(body.received.name, xssPayload.name);
    assert.strictEqual(body.received.description, xssPayload.description);
  });

  test('SQL injection patterns in string fields — server does not crash', async () => {
    const sqlPayloads = [
      { field: "'; DROP TABLE users; --" },
      { field: "1' OR '1'='1" },
      { field: "admin'--" },
      { field: "UNION SELECT * FROM passwords" },
      { field: "1; EXEC xp_cmdshell('dir')" },
    ];

    for (const payload of sqlPayloads) {
      const res = await app.inject({
        method: 'POST',
        url: '/echo',
        payload,
      });

      // Server must not crash; Drizzle ORM parameterizes all queries
      assert.strictEqual(res.statusCode, 200, `Should handle SQL injection payload: ${payload.field}`);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.received.field, payload.field);
    }
  });

  test('Path traversal in URL params — dots and slashes handled by router', async () => {
    // Fastify treats path segments individually; ../../etc/passwd would be
    // routed as a 404 (no matching route), not as a file traversal.
    const traversalPaths = [
      '/resource/..%2F..%2Fetc%2Fpasswd',
      '/resource/....//....//etc/passwd',
    ];

    for (const path of traversalPaths) {
      const res = await app.inject({
        method: 'GET',
        url: path,
      });

      // Must NOT return 200 with sensitive data
      // Fastify's router will either 400 or match with the encoded value
      assert.ok(
        res.statusCode === 200 || res.statusCode === 400 || res.statusCode === 404,
        `Path traversal attempt should be safely handled, got ${res.statusCode}`,
      );

      // If 200, ensure the response does not contain file system content
      if (res.statusCode === 200) {
        const body = JSON.parse(res.body);
        assert.ok(!body.id.includes('root:'), 'Must not leak /etc/passwd content');
      }
    }
  });

  test('Unicode normalization — consistent handling of special characters', async () => {
    const unicodePayloads = [
      { name: '\u0000null byte' },
      { name: 'caf\u00E9' },              // pre-composed e-acute
      { name: 'cafe\u0301' },             // decomposed e-acute
      { name: '\uFEFFBOM prefix' },       // BOM character
      { name: '\u200Bzero-width space' }, // zero-width space
      { name: 'normal text' },
    ];

    for (const payload of unicodePayloads) {
      const res = await app.inject({
        method: 'POST',
        url: '/echo',
        payload,
      });

      // Server must handle all unicode inputs without crashing
      assert.strictEqual(res.statusCode, 200, `Should handle unicode: ${JSON.stringify(payload.name)}`);
    }
  });

  test('Extremely long string in body — does not cause OOM on small payload route', async () => {
    const longString = 'A'.repeat(100_000);
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      payload: { name: longString },
    });

    // Fastify has a default body limit; if it exceeds, it returns 413
    // Otherwise it passes through (routes should validate max lengths)
    assert.ok(
      res.statusCode === 200 || res.statusCode === 413,
      `Should handle or reject long body, got ${res.statusCode}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Error Handler — Sanitization, envelope shape, no leaks
// ═══════════════════════════════════════════════════════════════════════════

describe('Security: Error Handler Sanitization', () => {
  test('formatErrorResponse — consistent envelope structure with requestId', () => {
    const error = new Error('something broke');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = formatErrorResponse(fakeRequest('req-envelope') as any, error);

    // Must have: error.code, error.message, requestId
    assert.strictEqual(typeof envelope.error, 'object');
    assert.strictEqual(typeof envelope.error.code, 'string');
    assert.strictEqual(typeof envelope.error.message, 'string');
    assert.strictEqual(envelope.requestId, 'req-envelope');
  });

  test('Unknown error types produce safe INTERNAL_ERROR', () => {
    const weirdErrors = [
      new TypeError('Cannot read property of undefined'),
      new RangeError('Maximum call stack size exceeded'),
      new SyntaxError('Unexpected token'),
      Object.assign(new Error('custom'), { code: 'ERR_SOMETHING' }),
    ];

    for (const error of weirdErrors) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const envelope = formatErrorResponse(fakeRequest() as any, error);
      assert.strictEqual(envelope.error.code, 'INTERNAL_ERROR');
      assert.strictEqual(envelope.error.message, 'Internal server error');
      assert.strictEqual(envelope.error.details, undefined, 'Must not leak internal details');
    }
  });

  test('Non-Error values (string, number, null, undefined) produce safe INTERNAL_ERROR', () => {
    for (const val of ['raw string', 42, null, undefined, { arbitrary: 'object' }, [1, 2]]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const envelope = formatErrorResponse(fakeRequest() as any, val);
      assert.strictEqual(envelope.error.code, 'INTERNAL_ERROR');
      assert.strictEqual(envelope.error.message, 'Internal server error');
    }
  });

  test('ZodError produces VALIDATION_ERROR with issue details', () => {
    const zodError = new ZodError([
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'number',
        path: ['email'],
        message: 'Expected string, received number',
      },
      {
        code: 'too_small',
        minimum: 1,
        type: 'string',
        inclusive: true,
        exact: false,
        path: ['name'],
        message: 'String must contain at least 1 character(s)',
      },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = formatErrorResponse(fakeRequest() as any, zodError);
    assert.strictEqual(envelope.error.code, 'VALIDATION_ERROR');
    assert.strictEqual(envelope.error.message, 'Request validation failed');
    assert.ok(Array.isArray(envelope.error.details), 'details must contain Zod issues');
    assert.strictEqual((envelope.error.details as unknown[]).length, 2);
  });

  test('Rate limit error code maps to 429 status', () => {
    assert.strictEqual(getStatusCodeForError('RATE_LIMITED'), 429);
    assert.strictEqual(getStatusCodeForError('AI_RATE_LIMITED'), 429);
  });

  test('Auth error codes map to 401 status', () => {
    assert.strictEqual(getStatusCodeForError('UNAUTHORIZED'), 401);
    assert.strictEqual(getStatusCodeForError('INVALID_CREDENTIALS'), 401);
  });

  test('FORBIDDEN maps to 403', () => {
    assert.strictEqual(getStatusCodeForError('FORBIDDEN'), 403);
  });

  test('No stack traces leak through formatErrorResponse', () => {
    const errorWithStack = new Error('secret DB connection string: postgres://admin:pass@host/db');
    errorWithStack.stack = 'Error: secret\n    at Object.<anonymous> (/app/src/db.ts:42:7)';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = formatErrorResponse(fakeRequest() as any, errorWithStack);

    // The entire envelope JSON must not contain stack traces or secrets
    const serialized = JSON.stringify(envelope);
    assert.ok(!serialized.includes('postgres://'), 'Must not leak connection strings');
    assert.ok(!serialized.includes('/app/src/'), 'Must not leak file paths from stack');
    assert.ok(!serialized.includes('admin:pass'), 'Must not leak credentials');
    assert.strictEqual(envelope.error.code, 'INTERNAL_ERROR');
    assert.strictEqual(envelope.error.message, 'Internal server error');
  });

  test('DatabaseError sanitizes message — no internal SQL or connection details', () => {
    const dbError = new DatabaseError(
      'FATAL: role "akis_admin" does not exist',
      new Error('connection refused at 10.0.0.5:5432'),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = formatErrorResponse(fakeRequest() as any, dbError);
    assert.strictEqual(envelope.error.code, 'DATABASE_ERROR');
    assert.strictEqual(envelope.error.message, 'Database operation failed');
    assert.strictEqual(envelope.error.details, undefined);

    const serialized = JSON.stringify(envelope);
    assert.ok(!serialized.includes('akis_admin'), 'Must not leak DB role names');
    assert.ok(!serialized.includes('10.0.0.5'), 'Must not leak internal IPs');
  });

  test('TraceAutomationError maps to correct codes', () => {
    const errors: [TraceAutomationError, number][] = [
      [new TraceAutomationError('TRACE_AUTOMATION_TIMEOUT', 'timed out'), 504],
      [new TraceAutomationError('TRACE_AUTOMATION_RUN_FAILED', 'run failed'), 502],
      [new TraceAutomationError('TRACE_AUTOMATION_LAUNCH_FAILED', 'launch failed'), 502],
    ];

    for (const [error, expectedStatus] of errors) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const envelope = formatErrorResponse(fakeRequest() as any, error);
      assert.strictEqual(envelope.error.code, error.code);
      const status = getStatusCodeForError(envelope.error.code as ErrorCode);
      assert.strictEqual(status, expectedStatus, `${error.code} should map to ${expectedStatus}`);
    }
  });

  test('UNAUTHORIZED Error message pattern is correctly detected', () => {
    const authError = new Error('UNAUTHORIZED');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = formatErrorResponse(fakeRequest() as any, authError);
    assert.strictEqual(envelope.error.code, 'UNAUTHORIZED');
    assert.strictEqual(envelope.error.message, 'Authentication required');
    assert.strictEqual(getStatusCodeForError('UNAUTHORIZED'), 401);
  });

  test('FORBIDDEN Error message pattern is correctly detected', () => {
    const forbiddenError = new Error('FORBIDDEN');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = formatErrorResponse(fakeRequest() as any, forbiddenError);
    assert.strictEqual(envelope.error.code, 'FORBIDDEN');
    assert.strictEqual(envelope.error.message, 'Forbidden');
    assert.strictEqual(getStatusCodeForError('FORBIDDEN'), 403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Fastify Global Error Handler Integration
// ═══════════════════════════════════════════════════════════════════════════

describe('Security: Middleware Global Error Handler', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });

    // Replicate the global error handler from server.app.ts
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof ZodError) {
        return reply.code(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed',
            details: error.errors,
          },
          requestId: request.id,
        });
      }

      if ('validation' in error && Array.isArray((error as { validation?: unknown[] }).validation)) {
        return reply.code(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: error.message || 'Request validation failed',
            details: (error as { validation: unknown[] }).validation,
          },
          requestId: request.id,
        });
      }

      const envelope = formatErrorResponse(request, error);
      const statusCode = getStatusCodeForError(envelope.error.code as ErrorCode);
      return reply.code(statusCode).send(envelope);
    });

    // Route that throws various errors
    app.get('/throw-zod', async () => {
      throw new ZodError([
        { code: 'invalid_type', expected: 'string', received: 'undefined', path: ['id'], message: 'Required' },
      ]);
    });

    app.get('/throw-unknown', async () => {
      throw new Error('Something internal and secret');
    });

    app.get('/throw-not-found', async () => {
      throw new JobNotFoundError('job-xyz');
    });

    app.get('/throw-auth', async () => {
      throw new Error('UNAUTHORIZED');
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  test('ZodError thrown in handler returns 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({ method: 'GET', url: '/throw-zod' });
    assert.strictEqual(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(body.error.details));
  });

  test('Unknown error returns 500 INTERNAL_ERROR without leaking message', async () => {
    const res = await app.inject({ method: 'GET', url: '/throw-unknown' });
    assert.strictEqual(res.statusCode, 500);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error.code, 'INTERNAL_ERROR');
    assert.strictEqual(body.error.message, 'Internal server error');
    assert.ok(!body.error.message.includes('secret'));
  });

  test('JobNotFoundError returns 404 NOT_FOUND', async () => {
    const res = await app.inject({ method: 'GET', url: '/throw-not-found' });
    assert.strictEqual(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error.code, 'NOT_FOUND');
  });

  test('UNAUTHORIZED error returns 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/throw-auth' });
    assert.strictEqual(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error.code, 'UNAUTHORIZED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Cookie Security Configuration
// ═══════════════════════════════════════════════════════════════════════════

describe('Security: Cookie Configuration', () => {
  test('httpOnly flag is always set on auth cookie', async () => {
    const app = Fastify({ logger: false });

    await app.register(cookiesPlugin, {
      name: 'akis_sid',
      maxAge: 604800,
      sameSite: 'lax',
      secure: false,
      domain: '',
    });

    app.get('/set-cookie', async (_request, reply) => {
      reply.setAuthCookie('test-session-token');
      return { ok: true };
    });

    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/set-cookie' });
    assert.strictEqual(res.statusCode, 200);

    const setCookie = res.headers['set-cookie'];
    assert.ok(setCookie, 'set-cookie header must be present');
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    assert.ok(cookieStr.toLowerCase().includes('httponly'), 'Cookie must have httpOnly flag');

    await app.close();
  });

  test('secure flag in production configuration', async () => {
    const app = Fastify({ logger: false });

    await app.register(cookiesPlugin, {
      name: 'akis_sid',
      maxAge: 604800,
      sameSite: 'strict',
      secure: true,  // production mode
      domain: 'akisflow.com',
    });

    app.get('/set-cookie', async (_request, reply) => {
      reply.setAuthCookie('prod-session-token');
      return { ok: true };
    });

    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/set-cookie' });
    const setCookie = res.headers['set-cookie'];
    assert.ok(setCookie, 'set-cookie header must be present');
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    assert.ok(cookieStr.toLowerCase().includes('secure'), 'Cookie must have Secure flag in production');

    await app.close();
  });

  test('sameSite is set correctly (lax or strict)', async () => {
    for (const sameSite of ['lax', 'strict'] as const) {
      const app = Fastify({ logger: false });

      await app.register(cookiesPlugin, {
        name: 'akis_sid',
        maxAge: 604800,
        sameSite,
        secure: false,
        domain: '',
      });

      app.get('/set-cookie', async (_request, reply) => {
        reply.setAuthCookie('samesite-token');
        return { ok: true };
      });

      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/set-cookie' });
      const setCookie = res.headers['set-cookie'];
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      assert.ok(
        cookieStr.toLowerCase().includes(`samesite=${sameSite}`),
        `Cookie must have SameSite=${sameSite}`,
      );

      await app.close();
    }
  });

  test('path is always /', async () => {
    const app = Fastify({ logger: false });

    await app.register(cookiesPlugin, {
      name: 'akis_sid',
      maxAge: 604800,
      sameSite: 'lax',
      secure: false,
      domain: '',
    });

    app.get('/set-cookie', async (_request, reply) => {
      reply.setAuthCookie('path-token');
      return { ok: true };
    });

    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/set-cookie' });
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    assert.ok(cookieStr.includes('Path=/'), 'Cookie path must be /');

    await app.close();
  });

  test('domain set correctly when provided', async () => {
    const app = Fastify({ logger: false });

    await app.register(cookiesPlugin, {
      name: 'akis_sid',
      maxAge: 604800,
      sameSite: 'strict',
      secure: true,
      domain: 'akisflow.com',
    });

    app.get('/set-cookie', async (_request, reply) => {
      reply.setAuthCookie('domain-token');
      return { ok: true };
    });

    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/set-cookie' });
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    assert.ok(cookieStr.includes('Domain=akisflow.com'), 'Cookie must have correct domain');

    await app.close();
  });

  test('domain omitted for localhost (empty string)', async () => {
    const app = Fastify({ logger: false });

    await app.register(cookiesPlugin, {
      name: 'akis_sid',
      maxAge: 604800,
      sameSite: 'lax',
      secure: false,
      domain: '',
    });

    app.get('/set-cookie', async (_request, reply) => {
      reply.setAuthCookie('no-domain-token');
      return { ok: true };
    });

    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/set-cookie' });
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    assert.ok(!cookieStr.includes('Domain='), 'Cookie must NOT have Domain when empty string');

    await app.close();
  });

  test('clearAuthCookie removes the cookie', async () => {
    const app = Fastify({ logger: false });

    await app.register(cookiesPlugin, {
      name: 'akis_sid',
      maxAge: 604800,
      sameSite: 'lax',
      secure: false,
      domain: '',
    });

    app.get('/clear-cookie', async (_request, reply) => {
      reply.clearAuthCookie();
      return { ok: true };
    });

    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/clear-cookie' });
    const setCookie = res.headers['set-cookie'];
    assert.ok(setCookie, 'set-cookie header must be present for clearing');
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    // Clearing sets expiry in the past or maxAge=0
    assert.ok(
      cookieStr.includes('Expires=') || cookieStr.includes('Max-Age=0'),
      'Cleared cookie must have past expiry',
    );

    await app.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. CORS Configuration
// ═══════════════════════════════════════════════════════════════════════════

describe('Security: CORS Configuration', () => {
  test('allows configured origin', async () => {
    const app = Fastify({ logger: false });

    await app.register(corsPlugin, {
      origins: ['https://akisflow.com'],
    });

    app.get('/api/test', async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/test',
      headers: {
        origin: 'https://akisflow.com',
        'access-control-request-method': 'GET',
      },
    });

    assert.ok(
      res.headers['access-control-allow-origin'] === 'https://akisflow.com',
      'Must allow configured origin',
    );

    await app.close();
  });

  test('rejects non-configured origin', async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const app = Fastify({ logger: false });

    await app.register(corsPlugin, {
      origins: ['https://akisflow.com'],
    });

    app.get('/api/test', async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/test',
      headers: {
        origin: 'https://evil-site.com',
        'access-control-request-method': 'GET',
      },
    });

    // Should not include the evil origin in allow-origin
    const allowOrigin = res.headers['access-control-allow-origin'];
    assert.ok(
      !allowOrigin || allowOrigin !== 'https://evil-site.com',
      'Must NOT allow non-configured origin',
    );

    process.env.NODE_ENV = origEnv;
    await app.close();
  });

  test('trailing slashes in origin are normalized', async () => {
    const app = Fastify({ logger: false });

    await app.register(corsPlugin, {
      origins: ['https://akisflow.com/'],  // trailing slash
    });

    app.get('/api/test', async () => ({ ok: true }));
    await app.ready();

    // Request without trailing slash should still match
    const res = await app.inject({
      method: 'GET',
      url: '/api/test',
      headers: { origin: 'https://akisflow.com' },
    });

    assert.ok(
      res.headers['access-control-allow-origin'] === 'https://akisflow.com',
      'Must normalize trailing slashes',
    );

    await app.close();
  });

  test('wildcard origin disables credentials', async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const app = Fastify({ logger: false });

    await app.register(corsPlugin, {
      origins: ['*'],
    });

    app.get('/api/test', async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/test',
      headers: { origin: 'https://any-site.com' },
    });

    // With wildcard, credentials should be false (no access-control-allow-credentials: true)
    const allowCreds = res.headers['access-control-allow-credentials'];
    assert.ok(
      allowCreds !== 'true',
      'Wildcard origin must NOT allow credentials (security risk)',
    );

    process.env.NODE_ENV = origEnv;
    await app.close();
  });

  test('no origin header (same-origin request) is allowed', async () => {
    const app = Fastify({ logger: false });

    await app.register(corsPlugin, {
      origins: ['https://akisflow.com'],
    });

    app.get('/api/test', async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/test',
      // No origin header — same-origin or server-to-server
    });

    assert.strictEqual(res.statusCode, 200, 'Same-origin requests must be allowed');

    await app.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Content Security — Content-Type validation, body limits, JSON parse
// ═══════════════════════════════════════════════════════════════════════════

describe('Security: Content Security', () => {
  test('JSON parse error returns 400 not 500', async () => {
    const app = Fastify({ logger: false });

    app.post('/api/data', async (request) => {
      return { received: request.body };
    });

    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/data',
      headers: { 'content-type': 'application/json' },
      payload: '{ invalid json }}}',
    });

    // Must be 400 (client error), NOT 500 (server error)
    assert.ok(
      res.statusCode === 400,
      `Invalid JSON should return 400, got ${res.statusCode}`,
    );

    await app.close();
  });

  test('Empty body with application/json does not crash', async () => {
    const app = Fastify({ logger: false });

    // Replicate the custom content parser from server.ts
    app.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_req: unknown, body: string, done: (err: Error | null, result?: unknown) => void) => {
        if (!body || body.trim() === '') {
          done(null, {});
          return;
        }
        try {
          done(null, JSON.parse(body));
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );

    app.post('/api/data', async (request) => {
      return { received: request.body };
    });

    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/data',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });

    // Should return 200 with empty object, not 500
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepStrictEqual(body.received, {});

    await app.close();
  });

  test('Fastify default body size limit rejects oversized payloads', async () => {
    const app = Fastify({
      logger: false,
      bodyLimit: 1024, // 1KB limit for test
    });

    app.post('/api/data', async (request) => {
      return { received: typeof request.body };
    });

    await app.ready();

    // Send a payload larger than 1KB
    const largePayload = JSON.stringify({ data: 'X'.repeat(2048) });
    const res = await app.inject({
      method: 'POST',
      url: '/api/data',
      headers: { 'content-type': 'application/json' },
      payload: largePayload,
    });

    assert.ok(
      res.statusCode === 413 || res.statusCode === 400,
      `Oversized payload should be rejected, got ${res.statusCode}`,
    );

    await app.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Helmet / Security Headers
// ═══════════════════════════════════════════════════════════════════════════

describe('Security: Helmet Security Headers', () => {
  test('X-Content-Type-Options is set to nosniff', async () => {
    const app = Fastify({ logger: false });

    await app.register(helmetPlugin, { enableCSP: false });
    app.get('/test', async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/test' });
    assert.strictEqual(
      res.headers['x-content-type-options'],
      'nosniff',
      'X-Content-Type-Options must be nosniff',
    );

    await app.close();
  });

  test('X-Frame-Options is set (clickjacking protection)', async () => {
    const app = Fastify({ logger: false });

    await app.register(helmetPlugin, { enableCSP: false });
    app.get('/test', async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/test' });
    const xfo = res.headers['x-frame-options'];
    assert.ok(
      xfo === 'DENY' || xfo === 'SAMEORIGIN',
      `X-Frame-Options must be DENY or SAMEORIGIN, got ${xfo}`,
    );

    await app.close();
  });

  test('Cross-Origin-Resource-Policy is set to same-origin', async () => {
    const app = Fastify({ logger: false });

    await app.register(helmetPlugin, { enableCSP: false });
    app.get('/test', async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/test' });
    assert.strictEqual(
      res.headers['cross-origin-resource-policy'],
      'same-origin',
      'Cross-Origin-Resource-Policy must be same-origin',
    );

    await app.close();
  });

  test('X-DNS-Prefetch-Control is present', async () => {
    const app = Fastify({ logger: false });

    await app.register(helmetPlugin, { enableCSP: false });
    app.get('/test', async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/test' });
    assert.ok(
      'x-dns-prefetch-control' in res.headers,
      'X-DNS-Prefetch-Control header must be present',
    );

    await app.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. sendError helper edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe('Security: sendError Middleware Helper', () => {
  test('sendError never includes undefined details in envelope', () => {
    const reply = fakeReply();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendError(reply as any, fakeRequest() as any, 'INTERNAL_ERROR', 'Something broke');

    const body = reply.body as ErrorEnvelope;
    const keys = Object.keys(body.error);
    assert.ok(!keys.includes('details'), 'details key must be absent when not provided');
  });

  test('sendError with details includes them in envelope', () => {
    const reply = fakeReply();
    const details = { fields: ['email', 'name'] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendError(reply as any, fakeRequest() as any, 'VALIDATION_ERROR', 'Invalid', details);

    const body = reply.body as ErrorEnvelope;
    assert.deepStrictEqual(body.error.details, details);
  });

  test('all ErrorCode values have a mapped HTTP status', () => {
    // Comprehensive check that every known error code resolves to a valid HTTP status
    const allCodes: ErrorCode[] = [
      'VALIDATION_ERROR', 'NOT_FOUND', 'INVALID_STATE', 'DATABASE_ERROR', 'INTERNAL_ERROR',
      'AI_RATE_LIMITED', 'AI_PROVIDER_ERROR', 'AI_INVALID_RESPONSE', 'AI_NETWORK_ERROR',
      'AI_AUTH_ERROR', 'AI_KEY_MISSING', 'MODEL_NOT_ALLOWED',
      'UNAUTHORIZED', 'INVALID_CREDENTIALS', 'EMAIL_IN_USE', 'EMAIL_DELIVERY_FAILED',
      'USER_NOT_FOUND', 'EMAIL_NOT_VERIFIED', 'ALREADY_VERIFIED', 'INVALID_CODE',
      'RATE_LIMITED', 'USER_DISABLED', 'INVALID_PROVIDER', 'OAUTH_NOT_CONFIGURED',
      'INVITE_INVALID', 'INVITE_EXPIRED', 'EMAIL_ALREADY_ACTIVE',
      'ENCRYPTION_NOT_CONFIGURED', 'DUPLICATE_KEY', 'FORBIDDEN',
      'TRACE_AUTOMATION_TIMEOUT', 'TRACE_AUTOMATION_RUN_FAILED', 'TRACE_AUTOMATION_LAUNCH_FAILED',
    ];

    for (const code of allCodes) {
      const status = getStatusCodeForError(code);
      assert.ok(
        status >= 400 && status < 600,
        `Error code ${code} must map to 4xx/5xx, got ${status}`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. 404 Handler Security
// ═══════════════════════════════════════════════════════════════════════════

describe('Security: 404 Not Found Handler', () => {
  test('unmatched route returns standard error envelope', async () => {
    const app = Fastify({ logger: false });

    app.setNotFoundHandler((request, reply) => {
      reply.code(404).send({
        error: {
          code: 'NOT_FOUND',
          message: `Route ${request.method} ${request.url} not found`,
        },
        requestId: request.id,
      });
    });

    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/nonexistent' });
    assert.strictEqual(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error.code, 'NOT_FOUND');
    assert.ok(body.error.message.includes('/api/nonexistent'));
    assert.ok(body.requestId, 'requestId must be present in 404 responses');

    await app.close();
  });

  test('404 does not leak internal routing information', async () => {
    const app = Fastify({ logger: false });

    app.setNotFoundHandler((request, reply) => {
      reply.code(404).send({
        error: {
          code: 'NOT_FOUND',
          message: `Route ${request.method} ${request.url} not found`,
        },
        requestId: request.id,
      });
    });

    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/admin/secret-panel' });
    assert.strictEqual(res.statusCode, 404);
    const body = JSON.parse(res.body);
    // Must not hint at which routes DO exist
    assert.ok(!body.error.message.includes('Did you mean'));
    assert.ok(!body.error.details, 'Must not leak route hints');

    await app.close();
  });
});
