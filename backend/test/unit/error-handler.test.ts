/**
 * Unit tests for AGT-6: Error handling standardization
 *
 * Tests the sendError helper, ErrorCode type coverage,
 * getStatusCodeForError mappings, formatErrorResponse,
 * and the global error handler behavior.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';

import {
  sendError,
  formatErrorResponse,
  getStatusCodeForError,
  type ErrorCode,
  type ErrorEnvelope,
} from '../../src/utils/errorHandler.js';

import { ZodError } from 'zod';
import {
  JobNotFoundError,
  InvalidStateTransitionError,
  DatabaseError,
  AIProviderError,
  AIRateLimitedError,
  MissingAIKeyError,
  ModelNotAllowedError,
} from '../../src/lib/errors.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function fakeRequest(id = 'req-123'): { id: string } {
  return { id } as { id: string };
}

function fakeReply(): {
  statusCode: number;
  body: unknown;
  code: (c: number) => { send: (b: unknown) => void };
} {
  const state = { statusCode: 0, body: null as unknown };
  return {
    get statusCode() {
      return state.statusCode;
    },
    get body() {
      return state.body;
    },
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

// ─── getStatusCodeForError ──────────────────────────────────────────────────

describe('getStatusCodeForError', () => {
  const expectations: [ErrorCode, number][] = [
    // Core
    ['VALIDATION_ERROR', 400],
    ['NOT_FOUND', 404],
    ['INVALID_STATE', 409],
    ['DATABASE_ERROR', 500],
    ['INTERNAL_ERROR', 500],
    // AI
    ['AI_RATE_LIMITED', 429],
    ['AI_AUTH_ERROR', 502],
    ['AI_KEY_MISSING', 412],
    ['MODEL_NOT_ALLOWED', 400],
    ['AI_PROVIDER_ERROR', 503],
    ['AI_NETWORK_ERROR', 503],
    ['AI_INVALID_RESPONSE', 503],
    // Auth
    ['UNAUTHORIZED', 401],
    ['INVALID_CREDENTIALS', 401],
    ['EMAIL_IN_USE', 409],
    ['EMAIL_DELIVERY_FAILED', 503],
    ['USER_NOT_FOUND', 404],
    ['EMAIL_NOT_VERIFIED', 403],
    ['ALREADY_VERIFIED', 403],
    ['INVALID_CODE', 400],
    ['RATE_LIMITED', 429],
    ['USER_DISABLED', 403],
    ['INVALID_PROVIDER', 400],
    ['OAUTH_NOT_CONFIGURED', 503],
    ['INVITE_INVALID', 404],
    ['INVITE_EXPIRED', 404],
    ['EMAIL_ALREADY_ACTIVE', 409],
    // Settings
    ['ENCRYPTION_NOT_CONFIGURED', 503],
    ['DUPLICATE_KEY', 409],
    ['FORBIDDEN', 403],
  ];

  for (const [code, expectedStatus] of expectations) {
    test(`${code} → ${expectedStatus}`, () => {
      assert.strictEqual(getStatusCodeForError(code), expectedStatus);
    });
  }
});

// ─── sendError ──────────────────────────────────────────────────────────────

describe('sendError', () => {
  test('produces standard error envelope with requestId', () => {
    const reply = fakeReply();
    const request = fakeRequest('abc-456');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendError(reply as any, request as any, 'EMAIL_IN_USE', 'Email already registered');

    assert.strictEqual(reply.statusCode, 409, 'should derive status from code');
    const body = reply.body as ErrorEnvelope;
    assert.strictEqual(body.error.code, 'EMAIL_IN_USE');
    assert.strictEqual(body.error.message, 'Email already registered');
    assert.strictEqual(body.requestId, 'abc-456');
    assert.strictEqual(body.error.details, undefined, 'details should not be present when omitted');
  });

  test('includes details when provided', () => {
    const reply = fakeReply();
    const request = fakeRequest();
    const details = [{ field: 'email', message: 'invalid' }];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendError(reply as any, request as any, 'VALIDATION_ERROR', 'Validation failed', details);

    const body = reply.body as ErrorEnvelope;
    assert.strictEqual(body.error.code, 'VALIDATION_ERROR');
    assert.deepStrictEqual(body.error.details, details);
  });

  test('allows statusCode override', () => {
    const reply = fakeReply();
    const request = fakeRequest();

    // Force 422 instead of the default 400 for VALIDATION_ERROR
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendError(reply as any, request as any, 'VALIDATION_ERROR', 'Custom status', undefined, 422);

    assert.strictEqual(reply.statusCode, 422);
  });

  test('derives correct status for auth errors', () => {
    const cases: [ErrorCode, number][] = [
      ['UNAUTHORIZED', 401],
      ['INVALID_CREDENTIALS', 401],
      ['USER_NOT_FOUND', 404],
      ['RATE_LIMITED', 429],
    ];

    for (const [code, expectedStatus] of cases) {
      const reply = fakeReply();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sendError(reply as any, fakeRequest() as any, code, 'test');
      assert.strictEqual(
        reply.statusCode,
        expectedStatus,
        `${code} should return ${expectedStatus}`
      );
    }
  });
});

// ─── formatErrorResponse ────────────────────────────────────────────────────

describe('formatErrorResponse', () => {
  test('maps ZodError to VALIDATION_ERROR', () => {
    const zodError = new ZodError([
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'number',
        path: ['email'],
        message: 'Expected string',
      },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = formatErrorResponse(fakeRequest() as any, zodError);

    assert.strictEqual(envelope.error.code, 'VALIDATION_ERROR');
    assert.strictEqual(envelope.error.message, 'Request validation failed');
    assert.ok(Array.isArray(envelope.error.details), 'details should contain Zod issues');
    assert.strictEqual(envelope.requestId, 'req-123');
  });

  test('maps JobNotFoundError to NOT_FOUND', () => {
    const error = new JobNotFoundError('job-1');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = formatErrorResponse(fakeRequest() as any, error);

    assert.strictEqual(envelope.error.code, 'NOT_FOUND');
    assert.ok(envelope.error.message.includes('job-1'));
  });

  test('maps InvalidStateTransitionError to INVALID_STATE', () => {
    const error = new InvalidStateTransitionError('job-2', 'completed', 'run');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = formatErrorResponse(fakeRequest() as any, error);

    assert.strictEqual(envelope.error.code, 'INVALID_STATE');
  });

  test('maps DatabaseError to DATABASE_ERROR (no internal details leaked)', () => {
    const error = new DatabaseError('connection refused', new Error('pg: timeout'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = formatErrorResponse(fakeRequest() as any, error);

    assert.strictEqual(envelope.error.code, 'DATABASE_ERROR');
    assert.strictEqual(envelope.error.message, 'Database operation failed');
    assert.strictEqual(envelope.error.details, undefined, 'should NOT leak DB details');
  });

  test('maps AIProviderError with provider info', () => {
    const error = new AIProviderError('AI_PROVIDER_ERROR', 'OpenAI is down', 'openai', 500);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = formatErrorResponse(fakeRequest() as any, error);

    assert.strictEqual(envelope.error.code, 'AI_PROVIDER_ERROR');
    const details = envelope.error.details as Record<string, unknown>;
    assert.strictEqual(details.provider, 'openai');
  });

  test('maps MissingAIKeyError to AI_KEY_MISSING', () => {
    const error = new MissingAIKeyError('openrouter');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = formatErrorResponse(fakeRequest() as any, error);

    assert.strictEqual(envelope.error.code, 'AI_KEY_MISSING');
  });

  test('maps ModelNotAllowedError with model + allowlist in details', () => {
    const error = new ModelNotAllowedError('openai', 'gpt-5-turbo', ['gpt-5-mini', 'gpt-4o-mini']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = formatErrorResponse(fakeRequest() as any, error);

    assert.strictEqual(envelope.error.code, 'MODEL_NOT_ALLOWED');
    const details = envelope.error.details as Record<string, unknown>;
    assert.strictEqual(details.model, 'gpt-5-turbo');
    assert.deepStrictEqual(details.allowlist, ['gpt-5-mini', 'gpt-4o-mini']);
  });

  test('maps unknown errors to INTERNAL_ERROR (no stack leak)', () => {
    const error = new Error('something went very wrong internally');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = formatErrorResponse(fakeRequest() as any, error);

    assert.strictEqual(envelope.error.code, 'INTERNAL_ERROR');
    assert.strictEqual(envelope.error.message, 'Internal server error');
    assert.strictEqual(envelope.error.details, undefined, 'should NOT leak error details');
  });
});

// ─── ErrorEnvelope shape compliance ─────────────────────────────────────────

describe('ErrorEnvelope shape', () => {
  test('sendError output matches frontend parseErrorResponse expectations', () => {
    const reply = fakeReply();
    const request = fakeRequest('front-req-1');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendError(reply as any, request as any, 'UNAUTHORIZED', 'Session expired');

    const body = reply.body as Record<string, unknown>;

    // Frontend HttpClient.parseErrorResponse reads:
    //   errorData.error?.code
    //   errorData.error?.message
    //   errorData.error?.details
    assert.ok(typeof body.error === 'object' && body.error !== null, 'error must be an object');
    const errorObj = body.error as Record<string, unknown>;
    assert.strictEqual(typeof errorObj.code, 'string');
    assert.strictEqual(typeof errorObj.message, 'string');

    // requestId must be present at top level
    assert.strictEqual(body.requestId, 'front-req-1');
  });
});

// ─── AI error subclass tests ─────────────────────────────────────────────────

describe('AI error subclass mapping', () => {
  test('AIRateLimitedError maps with retryAfter in details', () => {
    const error = new AIRateLimitedError('openai', 30, 'Rate limit exceeded');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = formatErrorResponse(fakeRequest() as any, error);

    assert.strictEqual(envelope.error.code, 'AI_RATE_LIMITED');
    const details = envelope.error.details as Record<string, unknown>;
    assert.strictEqual(details.provider, 'openai');
    assert.strictEqual(details.retryAfter, 30);
  });

  test('AIRateLimitedError without raw message uses generic message', () => {
    const error = new AIRateLimitedError('openrouter');
    assert.ok(error.message.includes('temporarily rate limited'));
    assert.strictEqual(error.retryAfter, undefined);
  });

  test('MissingAIKeyError has default message when none provided', () => {
    const error = new MissingAIKeyError('openai');
    assert.ok(error.message.includes('not configured'));
    assert.ok(error.message.includes('openai'));
  });

  test('MissingAIKeyError uses custom message when provided', () => {
    const error = new MissingAIKeyError('openai', 'Please add OpenAI key');
    assert.strictEqual(error.message, 'Please add OpenAI key');
  });

  test('all AI error subclasses are instanceof AIProviderError and Error', () => {
    const errors = [
      new AIRateLimitedError('openai'),
      new MissingAIKeyError('openai'),
      new ModelNotAllowedError('openai', 'gpt-5', ['gpt-4o']),
    ];
    for (const e of errors) {
      assert.ok(e instanceof AIProviderError, `${e.name} should be instanceof AIProviderError`);
      assert.ok(e instanceof Error, `${e.name} should be instanceof Error`);
    }
  });
});

// ─── Security: no secret leakage ─────────────────────────────────────────────

describe('Error response security', () => {
  test('unknown errors never leak internal details', () => {
    const error = new Error('postgres://user:password@host/db connection failed');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = formatErrorResponse(fakeRequest() as any, error);
    assert.strictEqual(envelope.error.message, 'Internal server error');
    assert.ok(!envelope.error.message.includes('postgres'));
    assert.strictEqual(envelope.error.details, undefined);
  });

  test('DatabaseError never leaks connection details', () => {
    const error = new DatabaseError(
      'FATAL: password authentication failed',
      new Error('pg: timeout')
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envelope = formatErrorResponse(fakeRequest() as any, error);
    assert.strictEqual(envelope.error.message, 'Database operation failed');
    assert.ok(!envelope.error.message.includes('password'));
    assert.ok(!envelope.error.message.includes('FATAL'));
  });

  test('non-Error values (string, number, null) produce safe INTERNAL_ERROR', () => {
    for (const val of ['string error', 42, null, undefined, { random: 'obj' }]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const envelope = formatErrorResponse(fakeRequest() as any, val);
      assert.strictEqual(envelope.error.code, 'INTERNAL_ERROR');
      assert.strictEqual(envelope.error.message, 'Internal server error');
    }
  });
});
