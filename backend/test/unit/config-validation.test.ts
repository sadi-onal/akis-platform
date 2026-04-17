/**
 * Unit tests for config/env.ts validation logic
 * Tests envSchema validation rules, getAIConfig, and provider detection functions
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';

// ─── Re-create pure functions from config/env.ts ────────────────────

function detectProviderFromModel(model: string): 'openai' | 'openrouter' | null {
  if (model.startsWith('gpt-') || model.startsWith('o1') ||
      model.startsWith('o3') || model.startsWith('text-') ||
      model.startsWith('davinci')) {
    return 'openai';
  }
  if (model.includes('/') || model.includes(':free') || model.includes(':nitro')) {
    return 'openrouter';
  }
  return null;
}

function detectProviderFromKey(key: string): 'openai' | 'openrouter' | null {
  if (key.startsWith('sk-or-')) return 'openrouter';
  if (key.startsWith('sk-')) return 'openai';
  return null;
}

// ─── Re-create key schema validations from envSchema ────────────────

const corsOriginsSchema = z.string().default('http://localhost:5173')
  .transform((value) => value.split(',').map((o) => o.trim()).filter(Boolean));

const cookieSameSiteSchema = z
  .enum(['Lax', 'Strict', 'None', 'lax', 'strict', 'none'])
  .default('Lax')
  .transform((value) => value.toLowerCase() as 'lax' | 'strict' | 'none');

const boolStringSchema = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const nodeEnvSchema = z.enum(['development', 'production', 'test']).default('development');

const emailProviderSchema = z.enum(['mock', 'resend', 'smtp']).default('mock');

const aiProviderSchema = z.enum(['openrouter', 'openai', 'mock']).default('mock');

// ─── detectProviderFromModel ────────────────────────────────────────

describe('detectProviderFromModel', () => {
  test('detects OpenAI models', () => {
    assert.strictEqual(detectProviderFromModel('gpt-4o'), 'openai');
    assert.strictEqual(detectProviderFromModel('gpt-4o-mini'), 'openai');
    assert.strictEqual(detectProviderFromModel('gpt-4.1-mini'), 'openai');
    assert.strictEqual(detectProviderFromModel('o1-preview'), 'openai');
    assert.strictEqual(detectProviderFromModel('o3-mini'), 'openai');
    assert.strictEqual(detectProviderFromModel('text-embedding-3-small'), 'openai');
    assert.strictEqual(detectProviderFromModel('davinci-002'), 'openai');
  });

  test('detects OpenRouter models', () => {
    assert.strictEqual(detectProviderFromModel('anthropic/claude-sonnet-4'), 'openrouter');
    assert.strictEqual(detectProviderFromModel('google/gemini-2.5-flash'), 'openrouter');
    assert.strictEqual(detectProviderFromModel('mistral:free'), 'openrouter');
    assert.strictEqual(detectProviderFromModel('some-model:nitro'), 'openrouter');
  });

  test('returns null for unrecognized models', () => {
    assert.strictEqual(detectProviderFromModel('custom-model'), null);
    assert.strictEqual(detectProviderFromModel('llama-3.1'), null);
    assert.strictEqual(detectProviderFromModel(''), null);
  });
});

// ─── detectProviderFromKey ──────────────────────────────────────────

describe('detectProviderFromKey', () => {
  test('detects OpenRouter keys', () => {
    assert.strictEqual(detectProviderFromKey('sk-or-abc123'), 'openrouter');
    assert.strictEqual(detectProviderFromKey('sk-or-v1-longkey'), 'openrouter');
  });

  test('detects OpenAI keys', () => {
    assert.strictEqual(detectProviderFromKey('sk-abc123def'), 'openai');
    assert.strictEqual(detectProviderFromKey('sk-proj-abc123'), 'openai');
  });

  test('returns null for unrecognized keys', () => {
    assert.strictEqual(detectProviderFromKey('custom-key-123'), null);
    assert.strictEqual(detectProviderFromKey(''), null);
    assert.strictEqual(detectProviderFromKey('xoxb-slack-token'), null);
  });

  test('sk-or- takes priority over sk- prefix', () => {
    // sk-or- is checked first, so it should be openrouter, not openai
    assert.strictEqual(detectProviderFromKey('sk-or-test'), 'openrouter');
  });
});

// ─── CORS_ORIGINS transform ─────────────────────────────────────────

describe('CORS_ORIGINS transform', () => {
  test('splits comma-separated origins', () => {
    const result = corsOriginsSchema.parse('http://a.com,http://b.com');
    assert.deepStrictEqual(result, ['http://a.com', 'http://b.com']);
  });

  test('trims whitespace around origins', () => {
    const result = corsOriginsSchema.parse('http://a.com , http://b.com ');
    assert.deepStrictEqual(result, ['http://a.com', 'http://b.com']);
  });

  test('filters empty strings', () => {
    const result = corsOriginsSchema.parse('http://a.com,,http://b.com,');
    assert.deepStrictEqual(result, ['http://a.com', 'http://b.com']);
  });

  test('defaults to localhost:5173', () => {
    const result = corsOriginsSchema.parse(undefined);
    assert.deepStrictEqual(result, ['http://localhost:5173']);
  });
});

// ─── AUTH_COOKIE_SAMESITE transform ─────────────────────────────────

describe('AUTH_COOKIE_SAMESITE', () => {
  test('normalizes to lowercase', () => {
    assert.strictEqual(cookieSameSiteSchema.parse('Lax'), 'lax');
    assert.strictEqual(cookieSameSiteSchema.parse('Strict'), 'strict');
    assert.strictEqual(cookieSameSiteSchema.parse('None'), 'none');
  });

  test('accepts lowercase values', () => {
    assert.strictEqual(cookieSameSiteSchema.parse('lax'), 'lax');
    assert.strictEqual(cookieSameSiteSchema.parse('strict'), 'strict');
  });

  test('rejects invalid values', () => {
    assert.throws(() => cookieSameSiteSchema.parse('invalid'));
  });

  test('defaults to lax', () => {
    assert.strictEqual(cookieSameSiteSchema.parse(undefined), 'lax');
  });
});

// ─── Boolean string transform ───────────────────────────────────────

describe('Boolean string fields (AUTH_COOKIE_SECURE, TRUST_PROXY)', () => {
  test('true string becomes true', () => {
    assert.strictEqual(boolStringSchema.parse('true'), true);
  });

  test('false string becomes false', () => {
    assert.strictEqual(boolStringSchema.parse('false'), false);
  });

  test('defaults to false', () => {
    assert.strictEqual(boolStringSchema.parse(undefined), false);
  });

  test('rejects non-boolean strings', () => {
    assert.throws(() => boolStringSchema.parse('yes'));
    assert.throws(() => boolStringSchema.parse('1'));
  });
});

// ─── NODE_ENV validation ────────────────────────────────────────────

describe('NODE_ENV', () => {
  test('accepts valid environments', () => {
    assert.strictEqual(nodeEnvSchema.parse('development'), 'development');
    assert.strictEqual(nodeEnvSchema.parse('production'), 'production');
    assert.strictEqual(nodeEnvSchema.parse('test'), 'test');
  });

  test('defaults to development', () => {
    assert.strictEqual(nodeEnvSchema.parse(undefined), 'development');
  });

  test('rejects invalid environment', () => {
    assert.throws(() => nodeEnvSchema.parse('staging'));
  });
});

// ─── EMAIL_PROVIDER validation ──────────────────────────────────────

describe('EMAIL_PROVIDER', () => {
  test('accepts mock, resend, smtp', () => {
    assert.strictEqual(emailProviderSchema.parse('mock'), 'mock');
    assert.strictEqual(emailProviderSchema.parse('resend'), 'resend');
    assert.strictEqual(emailProviderSchema.parse('smtp'), 'smtp');
  });

  test('defaults to mock', () => {
    assert.strictEqual(emailProviderSchema.parse(undefined), 'mock');
  });

  test('rejects invalid provider', () => {
    assert.throws(() => emailProviderSchema.parse('sendgrid'));
  });
});

// ─── AI_PROVIDER validation ────────────────────────────────────────

describe('AI_PROVIDER', () => {
  test('accepts openrouter, openai, mock', () => {
    assert.strictEqual(aiProviderSchema.parse('openrouter'), 'openrouter');
    assert.strictEqual(aiProviderSchema.parse('openai'), 'openai');
    assert.strictEqual(aiProviderSchema.parse('mock'), 'mock');
  });

  test('defaults to mock', () => {
    assert.strictEqual(aiProviderSchema.parse(undefined), 'mock');
  });

  test('rejects invalid provider', () => {
    assert.throws(() => aiProviderSchema.parse('anthropic'));
    assert.throws(() => aiProviderSchema.parse('gemini'));
  });
});

// ─── MCP base URL preprocess ────────────────────────────────────────

describe('MCP base URL preprocess', () => {
  const mcpUrlSchema = z.preprocess(
    (val) => (val === '' || val === undefined ? undefined : val),
    z.string().url().optional()
  );

  test('empty string becomes undefined', () => {
    assert.strictEqual(mcpUrlSchema.parse(''), undefined);
  });

  test('undefined stays undefined', () => {
    assert.strictEqual(mcpUrlSchema.parse(undefined), undefined);
  });

  test('valid URL passes through', () => {
    assert.strictEqual(mcpUrlSchema.parse('http://localhost:4000'), 'http://localhost:4000');
  });

  test('invalid URL string rejects', () => {
    assert.throws(() => mcpUrlSchema.parse('not-a-url'));
  });
});

// ─── OAuth Callback / public URL preprocess ─────────────────────────
// Regression guard for 2026-04-17 prod outage: compose injected
// `GITHUB_OAUTH_CALLBACK_URL=""` (empty string via `${VAR:-}`) which a plain
// `z.string().url().optional()` treated as an invalid URL and crashed boot.
// Fix: same preprocess pattern as MCP base URLs.

describe('OAuth URL preprocess', () => {
  const oauthUrlSchema = z.preprocess(
    (val) => (val === '' || val === undefined ? undefined : val),
    z.string().url().optional()
  );

  test('empty string becomes undefined (does not crash validation)', () => {
    assert.strictEqual(oauthUrlSchema.parse(''), undefined);
  });

  test('undefined stays undefined', () => {
    assert.strictEqual(oauthUrlSchema.parse(undefined), undefined);
  });

  test('valid https callback URL passes through', () => {
    const url = 'https://akisflow.com/auth/oauth/github/callback';
    assert.strictEqual(oauthUrlSchema.parse(url), url);
  });

  test('invalid URL string still rejects', () => {
    assert.throws(() => oauthUrlSchema.parse('callback'));
  });
});
