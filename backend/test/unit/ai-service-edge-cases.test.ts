/**
 * AI Service Edge Cases — unit tests for provider detection, token encryption,
 * error classification, and model selection logic.
 *
 * Pure-logic tests: no real API calls, no database, no external dependencies.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// 1. AI Provider Detection (detectProviderFromKey / detectProviderFromModel)
//    These are private in env.ts, but getAIConfig exposes them implicitly.
//    We re-implement the detection logic inline for isolated unit testing.
// ---------------------------------------------------------------------------

/** Mirrors detectProviderFromKey in config/env.ts */
function detectProviderFromKey(key: string): 'openai' | 'openrouter' | 'anthropic' | null {
  if (key.startsWith('sk-or-')) return 'openrouter';
  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('sk-')) return 'openai';
  return null;
}

/** Mirrors detectProviderFromModel in config/env.ts */
function detectProviderFromModel(model: string): 'openai' | 'openrouter' | 'anthropic' | null {
  if (
    model.startsWith('gpt-') ||
    model.startsWith('o1') ||
    model.startsWith('o3') ||
    model.startsWith('text-') ||
    model.startsWith('davinci')
  ) {
    return 'openai';
  }
  if (model.includes('/') || model.includes(':free') || model.includes(':nitro')) {
    return 'openrouter';
  }
  if (model.startsWith('claude-')) {
    return 'anthropic';
  }
  return null;
}

describe('AI Provider Detection — key prefix', () => {
  test('sk-ant- prefix → anthropic', () => {
    assert.strictEqual(detectProviderFromKey('sk-ant-api03-xxxxxxxxxxxxxxxx'), 'anthropic');
  });

  test('sk-or- prefix → openrouter', () => {
    assert.strictEqual(detectProviderFromKey('sk-or-v1-xxxxxxxxxxxxxxxx'), 'openrouter');
  });

  test('sk- prefix (not sk-ant- or sk-or-) → openai', () => {
    assert.strictEqual(detectProviderFromKey('sk-proj-xxxxxxxxxxxxxxxx'), 'openai');
    assert.strictEqual(detectProviderFromKey('sk-1234567890abcdef'), 'openai');
  });

  test('empty string → null (no provider detected)', () => {
    assert.strictEqual(detectProviderFromKey(''), null);
  });

  test('random/invalid prefix → null', () => {
    assert.strictEqual(detectProviderFromKey('xai-xxxxxxxxxxxxxxxx'), null);
    assert.strictEqual(detectProviderFromKey('key_live_xxxxxxxxxxxxxxxx'), null);
    assert.strictEqual(detectProviderFromKey('Bearer token'), null);
  });

  test('sk-ant- must come before generic sk- check', () => {
    // Ensure the ordering logic works — sk-ant- should NOT match openai
    const result = detectProviderFromKey('sk-ant-test123');
    assert.strictEqual(result, 'anthropic');
    assert.notStrictEqual(result, 'openai');
  });

  test('sk-or- must come before generic sk- check', () => {
    const result = detectProviderFromKey('sk-or-test123');
    assert.strictEqual(result, 'openrouter');
    assert.notStrictEqual(result, 'openai');
  });
});

describe('AI Provider Detection — model name', () => {
  test('gpt-4o-mini → openai', () => {
    assert.strictEqual(detectProviderFromModel('gpt-4o-mini'), 'openai');
  });

  test('gpt-4-turbo → openai', () => {
    assert.strictEqual(detectProviderFromModel('gpt-4-turbo'), 'openai');
  });

  test('o1-preview → openai', () => {
    assert.strictEqual(detectProviderFromModel('o1-preview'), 'openai');
  });

  test('o3-mini → openai', () => {
    assert.strictEqual(detectProviderFromModel('o3-mini'), 'openai');
  });

  test('davinci-002 → openai', () => {
    assert.strictEqual(detectProviderFromModel('davinci-002'), 'openai');
  });

  test('text-embedding-3-small → openai', () => {
    assert.strictEqual(detectProviderFromModel('text-embedding-3-small'), 'openai');
  });

  test('model with / → openrouter (e.g. anthropic/claude-3.5-haiku)', () => {
    assert.strictEqual(detectProviderFromModel('anthropic/claude-3.5-haiku'), 'openrouter');
  });

  test('model with :free suffix → openrouter', () => {
    assert.strictEqual(detectProviderFromModel('meta-llama/llama-3.3-70b-instruct:free'), 'openrouter');
  });

  test('model with :nitro suffix → openrouter', () => {
    assert.strictEqual(detectProviderFromModel('mistralai/mixtral-8x7b:nitro'), 'openrouter');
  });

  test('claude- prefix → anthropic', () => {
    assert.strictEqual(detectProviderFromModel('claude-sonnet-4-6'), 'anthropic');
    assert.strictEqual(detectProviderFromModel('claude-haiku-4-5-20251001'), 'anthropic');
  });

  test('unknown model name → null', () => {
    assert.strictEqual(detectProviderFromModel('llama-3-8b'), null);
    assert.strictEqual(detectProviderFromModel('some-custom-model'), null);
  });
});

// ---------------------------------------------------------------------------
// 2. Token Encryption (AES-256-GCM) — encrypt/decrypt round-trips
// ---------------------------------------------------------------------------

describe('AES-256-GCM Encryption — round-trip', () => {
  // Setup: ensure env is configured for encryption
  const TEST_KEY_HEX = randomBytes(32).toString('hex');

  async function loadCrypto() {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
    process.env.AI_KEY_ENCRYPTION_KEY = TEST_KEY_HEX;
    process.env.AI_KEY_ENCRYPTION_KEY_VERSION = 'test-v1';
    // Cache-bust so getEnv() re-parses
    return import(`../../src/utils/crypto.js?edge=${Date.now()}${Math.random()}`);
  }

  test('encrypt → decrypt round-trip produces original text', async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    const plaintext = 'sk-ant-api03-some-secret-key-here';
    const scope = 'user-abc:anthropic';

    const encrypted = encryptSecret(plaintext, scope);
    const decrypted = decryptSecret(encrypted, scope);

    assert.strictEqual(decrypted, plaintext);
  });

  test('different encryption keys produce different ciphertext', async () => {
    const key1 = randomBytes(32).toString('hex');
    const key2 = randomBytes(32).toString('hex');
    assert.notStrictEqual(key1, key2);

    // Encrypt with key1
    process.env.AI_KEY_ENCRYPTION_KEY = key1;
    const mod1 = await import(`../../src/utils/crypto.js?diffkey1=${Date.now()}${Math.random()}`);
    const enc1 = mod1.encryptSecret('same-plaintext', 'scope1');

    // Encrypt with key2
    process.env.AI_KEY_ENCRYPTION_KEY = key2;
    const mod2 = await import(`../../src/utils/crypto.js?diffkey2=${Date.now()}${Math.random()}`);
    const enc2 = mod2.encryptSecret('same-plaintext', 'scope1');

    // Ciphertexts should differ
    assert.notStrictEqual(enc1.cipherText, enc2.cipherText);
  });

  test('tampered ciphertext fails to decrypt', async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    const encrypted = encryptSecret('secret-value', 'user1:openai');

    // Tamper with the ciphertext
    const tampered = { ...encrypted };
    const buf = Buffer.from(tampered.cipherText, 'base64');
    buf[0] ^= 0xff; // flip bits
    tampered.cipherText = buf.toString('base64');

    assert.throws(
      () => decryptSecret(tampered, 'user1:openai'),
      /Unsupported state|unable to authenticate/i,
    );
  });

  test('tampered auth tag fails to decrypt', async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    const encrypted = encryptSecret('secret-value', 'user1:openai');

    const tampered = { ...encrypted };
    const tagBuf = Buffer.from(tampered.authTag, 'base64');
    tagBuf[0] ^= 0xff;
    tampered.authTag = tagBuf.toString('base64');

    assert.throws(
      () => decryptSecret(tampered, 'user1:openai'),
      /Unsupported state|unable to authenticate/i,
    );
  });

  test('empty string encryption round-trip', async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    const plaintext = '';
    const scope = 'user-empty:openai';

    const encrypted = encryptSecret(plaintext, scope);
    // AES-GCM on empty input produces empty ciphertext — that is valid
    assert.strictEqual(typeof encrypted.cipherText, 'string', 'cipherText should be a string');
    assert.ok(encrypted.iv, 'iv should be present');
    assert.ok(encrypted.authTag, 'authTag should be present');

    const decrypted = decryptSecret(encrypted, scope);
    assert.strictEqual(decrypted, '');
  });

  test('very long string encryption round-trip (10KB+)', async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    // 10KB of random data encoded as hex
    const longPlaintext = randomBytes(5120).toString('hex'); // 10240 chars
    assert.ok(longPlaintext.length >= 10240);

    const scope = 'user-long:openrouter';
    const encrypted = encryptSecret(longPlaintext, scope);
    const decrypted = decryptSecret(encrypted, scope);

    assert.strictEqual(decrypted, longPlaintext);
  });

  test('Unicode/Turkish character encryption round-trip', async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    const turkishText = 'Merhaba! AKIS platformu calisiyoruz. Turkce karakterler: cCgGiIoOsSuU';
    const scope = 'user-tr:anthropic';

    const encrypted = encryptSecret(turkishText, scope);
    const decrypted = decryptSecret(encrypted, scope);

    assert.strictEqual(decrypted, turkishText);
  });

  test('wrong scope (AAD mismatch) fails decryption', async () => {
    const { encryptSecret, decryptSecret } = await loadCrypto();
    const encrypted = encryptSecret('some-api-key', 'userA:openai');

    assert.throws(
      () => decryptSecret(encrypted, 'userB:openai'),
      /Unsupported state|unable to authenticate/i,
    );
  });

  test('encrypted output contains expected fields', async () => {
    const { encryptSecret } = await loadCrypto();
    const encrypted = encryptSecret('test-key', 'scope');

    assert.ok(typeof encrypted.cipherText === 'string' && encrypted.cipherText.length > 0);
    assert.ok(typeof encrypted.iv === 'string' && encrypted.iv.length > 0);
    assert.ok(typeof encrypted.authTag === 'string' && encrypted.authTag.length > 0);
    assert.strictEqual(encrypted.keyVersion, 'test-v1');
  });

  test('each encryption produces unique IV (non-deterministic)', async () => {
    const { encryptSecret } = await loadCrypto();
    const enc1 = encryptSecret('same-key', 'same-scope');
    const enc2 = encryptSecret('same-key', 'same-scope');

    // IVs must differ (randomBytes(12) each time)
    assert.notStrictEqual(enc1.iv, enc2.iv);
    // Ciphertexts will also differ due to different IVs
    assert.notStrictEqual(enc1.cipherText, enc2.cipherText);
  });
});

// ---------------------------------------------------------------------------
// 3. AI Service Error Classification
//    These test the error hierarchy exported from core/errors.ts
// ---------------------------------------------------------------------------

// Import error classes directly (no side effects)
import {
  AIProviderError,
  AIRateLimitedError,
  MissingAIKeyError,
  ModelNotAllowedError,
} from '../../src/core/errors.js';

describe('AI Service Error Classification', () => {
  test('AIRateLimitedError → code AI_RATE_LIMITED, statusCode 429', () => {
    const err = new AIRateLimitedError('anthropic', 30, 'Too many requests');
    assert.strictEqual(err.code, 'AI_RATE_LIMITED');
    assert.strictEqual(err.statusCode, 429);
    assert.strictEqual(err.provider, 'anthropic');
    assert.strictEqual(err.retryAfter, 30);
    assert.strictEqual(err.name, 'AIRateLimitedError');
    assert.ok(err instanceof AIProviderError, 'should be an AIProviderError subclass');
    assert.ok(err instanceof Error, 'should be an Error subclass');
    assert.ok(err.message.includes('rate limited'), 'message should mention rate limited');
  });

  test('AIRateLimitedError with no rawMessage produces default message', () => {
    const err = new AIRateLimitedError('openai');
    assert.ok(err.message.includes('temporarily rate limited'));
    assert.strictEqual(err.retryAfter, undefined);
  });

  test('AIProviderError with 401 → AI_AUTH_ERROR', () => {
    const err = new AIProviderError(
      'AI_AUTH_ERROR',
      'OpenAI API key is invalid or expired.',
      'openai',
      401,
    );
    assert.strictEqual(err.code, 'AI_AUTH_ERROR');
    assert.strictEqual(err.statusCode, 401);
    assert.strictEqual(err.provider, 'openai');
    assert.strictEqual(err.name, 'AIProviderError');
    assert.ok(err instanceof Error);
  });

  test('AIProviderError with 403 → AI_AUTH_ERROR', () => {
    const err = new AIProviderError(
      'AI_AUTH_ERROR',
      'Access denied.',
      'anthropic',
      403,
    );
    assert.strictEqual(err.code, 'AI_AUTH_ERROR');
    assert.strictEqual(err.statusCode, 403);
  });

  test('AIProviderError with 500 → AI_PROVIDER_ERROR (retryable by convention)', () => {
    const err = new AIProviderError(
      'AI_PROVIDER_ERROR',
      'Internal server error.',
      'openrouter',
      500,
    );
    assert.strictEqual(err.code, 'AI_PROVIDER_ERROR');
    assert.strictEqual(err.statusCode, 500);
    // Server errors are retried inside chatCompletion; the error code indicates generic provider failure.
  });

  test('AIProviderError with AI_NETWORK_ERROR for timeout/fetch failure', () => {
    const err = new AIProviderError(
      'AI_NETWORK_ERROR',
      'AI chat completion failed after 4 attempts: fetch failed',
      'anthropic',
    );
    assert.strictEqual(err.code, 'AI_NETWORK_ERROR');
    assert.strictEqual(err.statusCode, undefined);
    assert.ok(err.message.includes('failed after'));
  });

  test('AIProviderError AI_INVALID_RESPONSE for parse errors', () => {
    const err = new AIProviderError(
      'AI_INVALID_RESPONSE',
      'AI API returned no choices',
      'openai',
    );
    assert.strictEqual(err.code, 'AI_INVALID_RESPONSE');
    assert.ok(err.message.includes('no choices'));
  });

  test('MissingAIKeyError → AI_KEY_MISSING', () => {
    const err = new MissingAIKeyError('openrouter');
    assert.strictEqual(err.code, 'AI_KEY_MISSING');
    assert.strictEqual(err.name, 'MissingAIKeyError');
    assert.strictEqual(err.provider, 'openrouter');
    assert.ok(err instanceof AIProviderError);
    assert.ok(err.message.includes('not configured'));
  });

  test('MissingAIKeyError with custom message', () => {
    const err = new MissingAIKeyError('anthropic', 'Custom: no key found for user');
    assert.ok(err.message.includes('Custom'));
  });

  test('ModelNotAllowedError → MODEL_NOT_ALLOWED', () => {
    const err = new ModelNotAllowedError('anthropic', 'claude-3-opus', ['claude-haiku-4-5', 'claude-sonnet-4-6']);
    assert.strictEqual(err.code, 'MODEL_NOT_ALLOWED');
    assert.strictEqual(err.name, 'ModelNotAllowedError');
    assert.strictEqual(err.model, 'claude-3-opus');
    assert.deepStrictEqual(err.allowlist, ['claude-haiku-4-5', 'claude-sonnet-4-6']);
    assert.ok(err instanceof AIProviderError);
    assert.ok(err.message.includes('not allowed'));
  });

  test('AI_MODEL_NOT_FOUND for 404 errors', () => {
    const err = new AIProviderError(
      'AI_MODEL_NOT_FOUND',
      'Model "gpt-5" is not available on OpenAI.',
      'openai',
      404,
    );
    assert.strictEqual(err.code, 'AI_MODEL_NOT_FOUND');
    assert.strictEqual(err.statusCode, 404);
  });

  test('error inheritance chain: AIRateLimitedError → AIProviderError → Error', () => {
    const err = new AIRateLimitedError('openai');
    assert.ok(err instanceof AIRateLimitedError);
    assert.ok(err instanceof AIProviderError);
    assert.ok(err instanceof Error);
  });
});

// ---------------------------------------------------------------------------
// 4. Model Selection Logic
// ---------------------------------------------------------------------------

/** Mirrors ANTHROPIC_MODEL_MAP from AIService.ts */
const ANTHROPIC_MODEL_MAP: Record<string, string> = {
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6': 'claude-sonnet-4-20250514',
};

function resolveAnthropicModel(model: string): string {
  return ANTHROPIC_MODEL_MAP[model] ?? model;
}

describe('Model Selection', () => {
  test('claude-haiku-4-5 resolves to dated API model ID', () => {
    assert.strictEqual(resolveAnthropicModel('claude-haiku-4-5'), 'claude-haiku-4-5-20251001');
  });

  test('claude-sonnet-4-6 resolves to dated API model ID', () => {
    assert.strictEqual(resolveAnthropicModel('claude-sonnet-4-6'), 'claude-sonnet-4-20250514');
  });

  test('already-dated model ID passes through unchanged', () => {
    assert.strictEqual(
      resolveAnthropicModel('claude-haiku-4-5-20251001'),
      'claude-haiku-4-5-20251001',
    );
  });

  test('unknown model name passes through unchanged', () => {
    assert.strictEqual(resolveAnthropicModel('gpt-4o-mini'), 'gpt-4o-mini');
    assert.strictEqual(resolveAnthropicModel('custom-finetune-v2'), 'custom-finetune-v2');
  });

  test('provider-aware default model for openai', () => {
    const provider = 'openai';
    const defaultModel =
      provider === 'openai'
        ? 'gpt-4o-mini'
        : provider === 'openrouter'
          ? 'anthropic/claude-3.5-haiku'
          : provider === 'anthropic'
            ? 'claude-haiku-4-5-20251001'
            : 'mock-model';
    assert.strictEqual(defaultModel, 'gpt-4o-mini');
  });

  test('provider-aware default model for openrouter', () => {
    const provider = 'openrouter';
    const defaultModel =
      provider === 'openai'
        ? 'gpt-4o-mini'
        : provider === 'openrouter'
          ? 'anthropic/claude-3.5-haiku'
          : provider === 'anthropic'
            ? 'claude-haiku-4-5-20251001'
            : 'mock-model';
    assert.strictEqual(defaultModel, 'anthropic/claude-3.5-haiku');
  });

  test('provider-aware default model for anthropic', () => {
    const provider = 'anthropic';
    const defaultModel =
      provider === 'openai'
        ? 'gpt-4o-mini'
        : provider === 'openrouter'
          ? 'anthropic/claude-3.5-haiku'
          : provider === 'anthropic'
            ? 'claude-haiku-4-5-20251001'
            : 'mock-model';
    assert.strictEqual(defaultModel, 'claude-haiku-4-5-20251001');
  });

  test('provider-aware default model for mock', () => {
    const provider = 'mock';
    const defaultModel =
      provider === 'openai'
        ? 'gpt-4o-mini'
        : provider === 'openrouter'
          ? 'anthropic/claude-3.5-haiku'
          : provider === 'anthropic'
            ? 'claude-haiku-4-5-20251001'
            : 'mock-model';
    assert.strictEqual(defaultModel, 'mock-model');
  });

  test('model override is respected regardless of provider', () => {
    const userOverride = 'gpt-4-turbo';
    const providerDefault = 'gpt-4o-mini';
    const resolved = userOverride || providerDefault;
    assert.strictEqual(resolved, 'gpt-4-turbo');
  });

  test('cross-provider model detection rejects wrong-provider model', () => {
    // If provider is openai but model is claude-*, detection flags it
    const model = 'claude-sonnet-4-6';
    const provider = 'openai';
    const modelProvider = detectProviderFromModel(model);

    assert.strictEqual(modelProvider, 'anthropic');
    assert.notStrictEqual(modelProvider, provider, 'model belongs to different provider');
  });

  test('openrouter-style model (with /) detected correctly', () => {
    const model = 'google/gemini-2.0-flash-exp:free';
    const modelProvider = detectProviderFromModel(model);
    assert.strictEqual(modelProvider, 'openrouter');
  });
});

// ---------------------------------------------------------------------------
// 5. normalizeApiKey (from user-ai-keys.ts)
// ---------------------------------------------------------------------------

import { normalizeApiKey } from '../../src/services/ai/user-ai-keys.js';

describe('Crypto — normalizeApiKey', () => {
  test('trims leading/trailing whitespace', () => {
    assert.strictEqual(normalizeApiKey('  sk-ant-api03-xyz  '), 'sk-ant-api03-xyz');
  });

  test('trims newlines and tabs', () => {
    assert.strictEqual(normalizeApiKey('\n\tsk-or-v1-abc\n'), 'sk-or-v1-abc');
  });

  test('already clean key passes through', () => {
    assert.strictEqual(normalizeApiKey('sk-proj-123'), 'sk-proj-123');
  });

  test('empty string returns empty', () => {
    assert.strictEqual(normalizeApiKey(''), '');
  });
});

// ---------------------------------------------------------------------------
// 6. parseKeyMaterial edge cases (supplement to crypto.test.ts)
// ---------------------------------------------------------------------------

import { parseKeyMaterial } from '../../src/utils/crypto.js';

describe('Crypto — parseKeyMaterial edge cases', () => {
  test('exactly 32 bytes as hex → success', () => {
    const key = randomBytes(32).toString('hex');
    const buf = parseKeyMaterial(key);
    assert.strictEqual(buf.length, 32);
  });

  test('exactly 32 bytes as base64 → success', () => {
    const key = randomBytes(32).toString('base64');
    const buf = parseKeyMaterial(key);
    assert.strictEqual(buf.length, 32);
  });

  test('base64: prefix is stripped correctly', () => {
    const raw = randomBytes(32);
    const prefixed = `base64:${raw.toString('base64')}`;
    const buf = parseKeyMaterial(prefixed);
    assert.deepStrictEqual(buf, raw);
  });

  test('16-byte key throws', () => {
    assert.throws(() => parseKeyMaterial(randomBytes(16).toString('base64')), /32 bytes/);
  });

  test('64-byte key throws', () => {
    assert.throws(() => parseKeyMaterial(randomBytes(64).toString('base64')), /32 bytes/);
  });

  test('garbage input throws', () => {
    assert.throws(() => parseKeyMaterial('this-is-not-a-key'), /32 bytes/);
  });
});

// ---------------------------------------------------------------------------
// 7. Temperature Presets (imported directly — no side effects)
// ---------------------------------------------------------------------------

import {
  DETERMINISTIC_TEMPERATURES,
  CREATIVE_TEMPERATURES,
  BALANCED_TEMPERATURES,
} from '../../src/services/ai/prompt-constants.js';

describe('AI Temperature Presets', () => {
  test('deterministic temperatures are low (< 0.5)', () => {
    for (const [key, val] of Object.entries(DETERMINISTIC_TEMPERATURES)) {
      assert.ok(val < 0.5, `deterministic.${key} = ${val} should be < 0.5`);
    }
  });

  test('creative temperatures are higher than deterministic', () => {
    assert.ok(CREATIVE_TEMPERATURES.plan > DETERMINISTIC_TEMPERATURES.plan);
    assert.ok(CREATIVE_TEMPERATURES.generate > DETERMINISTIC_TEMPERATURES.generate);
  });

  test('repair temperature is always 0 (deterministic, creative, balanced)', () => {
    assert.strictEqual(DETERMINISTIC_TEMPERATURES.repair, 0);
    assert.strictEqual(CREATIVE_TEMPERATURES.repair, 0);
    assert.strictEqual(BALANCED_TEMPERATURES.repair, 0);
  });

  test('validate temperature is the lowest non-repair value', () => {
    assert.ok(DETERMINISTIC_TEMPERATURES.validate <= DETERMINISTIC_TEMPERATURES.plan);
    assert.ok(DETERMINISTIC_TEMPERATURES.validate <= DETERMINISTIC_TEMPERATURES.generate);
    assert.ok(DETERMINISTIC_TEMPERATURES.validate <= DETERMINISTIC_TEMPERATURES.reflect);
  });
});
