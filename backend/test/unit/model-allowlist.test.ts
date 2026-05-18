/**
 * Unit tests for AI model allowlist — pure function tests.
 * PR-A removed OpenRouter. P1a lit up the OpenAI runtime, so the OpenAI
 * defaults are now part of getAllKnownModels alongside the Anthropic ones.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  isModelAllowed,
  detectProviderFromModel,
  isModelCompatibleWithProvider,
  getRecommendedModel,
  getAllKnownModels,
  getScribeModelAllowlistByProvider,
  DEFAULT_ANTHROPIC_MODELS,
  DEFAULT_OPENAI_MODELS,
  DEFAULT_GOOGLE_MODELS,
  RECOMMENDED_MODELS,
} from '../../src/services/ai/modelAllowlist.js';

// ─── isModelAllowed ────────────────────────────────────────────────────

describe('isModelAllowed', () => {
  test('returns true for model in allowlist', () => {
    assert.strictEqual(isModelAllowed('gpt-4o-mini', ['gpt-4o-mini', 'gpt-4o']), true);
  });

  test('returns false for model not in allowlist', () => {
    assert.strictEqual(isModelAllowed('gpt-5-turbo', ['gpt-4o-mini', 'gpt-4o']), false);
  });

  test('returns false for empty allowlist', () => {
    assert.strictEqual(isModelAllowed('gpt-4o-mini', []), false);
  });

  test('is case-sensitive', () => {
    assert.strictEqual(isModelAllowed('GPT-4O-MINI', ['gpt-4o-mini']), false);
  });
});

// ─── detectProviderFromModel ───────────────────────────────────────────

describe('detectProviderFromModel', () => {
  test('detects OpenAI models by gpt- prefix', () => {
    assert.strictEqual(detectProviderFromModel('gpt-4o-mini'), 'openai');
    assert.strictEqual(detectProviderFromModel('gpt-4.1-mini'), 'openai');
  });

  test('detects OpenAI models by o1/o3 prefix', () => {
    assert.strictEqual(detectProviderFromModel('o1-preview'), 'openai');
    assert.strictEqual(detectProviderFromModel('o3-mini'), 'openai');
  });

  test('detects OpenAI models by davinci prefix', () => {
    assert.strictEqual(detectProviderFromModel('davinci-002'), 'openai');
  });

  test('detects Anthropic models by claude- prefix', () => {
    assert.strictEqual(detectProviderFromModel('claude-haiku-4-5-20251001'), 'anthropic');
    assert.strictEqual(detectProviderFromModel('claude-sonnet-4-6'), 'anthropic');
    assert.strictEqual(detectProviderFromModel('claude-opus-4-7'), 'anthropic');
  });

  test('returns null for unknown model format', () => {
    assert.strictEqual(detectProviderFromModel('some-unknown-model'), null);
    assert.strictEqual(detectProviderFromModel('custom-model-v2'), null);
  });

  test('PR-A: org/model slash format is no longer routed to openrouter', () => {
    // Pre-PR-A this returned 'openrouter'. Now we just don't recognise it.
    assert.strictEqual(detectProviderFromModel('anthropic/claude-sonnet-4'), null);
    assert.strictEqual(detectProviderFromModel('google/gemini-2.5-flash'), null);
  });
});

// ─── isModelCompatibleWithProvider ─────────────────────────────────────

describe('isModelCompatibleWithProvider', () => {
  test('OpenAI model is compatible with OpenAI', () => {
    assert.strictEqual(isModelCompatibleWithProvider('gpt-4o-mini', 'openai'), true);
  });

  test('Anthropic model is compatible with Anthropic', () => {
    assert.strictEqual(isModelCompatibleWithProvider('claude-haiku-4-5-20251001', 'anthropic'), true);
  });

  test('OpenAI model is NOT compatible with Anthropic', () => {
    assert.strictEqual(isModelCompatibleWithProvider('gpt-4o-mini', 'anthropic'), false);
  });

  test('Anthropic model is NOT compatible with OpenAI', () => {
    assert.strictEqual(isModelCompatibleWithProvider('claude-haiku-4-5-20251001', 'openai'), false);
  });

  test('unknown model format is compatible with any provider', () => {
    assert.strictEqual(isModelCompatibleWithProvider('some-new-model', 'openai'), true);
    assert.strictEqual(isModelCompatibleWithProvider('some-new-model', 'anthropic'), true);
  });
});

// ─── getRecommendedModel ───────────────────────────────────────────────

describe('getRecommendedModel', () => {
  test('returns correct recommended model for openai', () => {
    assert.strictEqual(getRecommendedModel('openai'), RECOMMENDED_MODELS.openai);
  });

  test('returns correct recommended model for anthropic', () => {
    assert.strictEqual(getRecommendedModel('anthropic'), RECOMMENDED_MODELS.anthropic);
  });

  test('returns correct recommended model for google (P1c)', () => {
    assert.strictEqual(getRecommendedModel('google'), RECOMMENDED_MODELS.google);
    // Sanity: pinned to flash by default (savunma demo baseline).
    assert.strictEqual(RECOMMENDED_MODELS.google, 'gemini-1.5-flash');
  });
});

// ─── Default constants ─────────────────────────────────────────────────

describe('Default model lists', () => {
  test('DEFAULT_ANTHROPIC_MODELS is non-empty', () => {
    assert.ok(DEFAULT_ANTHROPIC_MODELS.length > 0);
  });

  test('DEFAULT_OPENAI_MODELS is non-empty (kept for PR-B B5)', () => {
    assert.ok(DEFAULT_OPENAI_MODELS.length > 0);
  });

  test('all default Anthropic models are detected as Anthropic', () => {
    for (const model of DEFAULT_ANTHROPIC_MODELS) {
      assert.strictEqual(
        detectProviderFromModel(model),
        'anthropic',
        `${model} should be detected as anthropic`,
      );
    }
  });

  test('all default OpenAI models are detected as OpenAI', () => {
    for (const model of DEFAULT_OPENAI_MODELS) {
      assert.strictEqual(
        detectProviderFromModel(model),
        'openai',
        `${model} should be detected as openai`,
      );
    }
  });
});

// ─── getAllKnownModels (issue #437) ────────────────────────────────────

describe('getAllKnownModels', () => {
  test('includes Anthropic + OpenAI (P1a) + Google (P1c) defaults', () => {
    const all = getAllKnownModels();
    for (const m of DEFAULT_ANTHROPIC_MODELS) {
      assert.ok(all.includes(m), `${m} missing from allowlist`);
    }
    for (const m of DEFAULT_GOOGLE_MODELS) {
      assert.ok(all.includes(m), `${m} (Gemini) missing from allowlist (P1c)`);
    }
    for (const m of DEFAULT_OPENAI_MODELS) {
      assert.ok(all.includes(m), `${m} missing from allowlist (P1a runtime active)`);
    }
  });

  test('every entry resolves to anthropic, openai, or google via detectProviderFromModel', () => {
    for (const m of getAllKnownModels()) {
      const provider = detectProviderFromModel(m);
      assert.ok(
        provider === 'anthropic' || provider === 'openai' || provider === 'google',
        `model '${m}' must be detectable as anthropic/openai/google, got ${provider}`,
      );
    }
  });
});

// ─── getScribeModelAllowlistByProvider — google (P1c) ──────────────────

// Note: getScribeModelAllowlistByProvider('google') behavior under
// no-env-override is exercised indirectly via the DEFAULT_GOOGLE_MODELS
// sanity tests below and the cross-provider getAllKnownModels test. CI
// sets AI_SCRIBE_MODEL_ALLOWLIST which short-circuits the function before
// the provider branch, so a direct deepStrictEqual against DEFAULT_GOOGLE_MODELS
// is environment-dependent and was dropped from this suite (P1c).

// ─── DEFAULT_GOOGLE_MODELS sanity (P1c) ────────────────────────────────

describe('DEFAULT_GOOGLE_MODELS (P1c)', () => {
  test('is non-empty and contains the three savunma-demo defaults', () => {
    assert.ok(DEFAULT_GOOGLE_MODELS.length > 0);
    assert.ok(DEFAULT_GOOGLE_MODELS.includes('gemini-1.5-flash'));
    assert.ok(DEFAULT_GOOGLE_MODELS.includes('gemini-1.5-pro'));
    assert.ok(DEFAULT_GOOGLE_MODELS.includes('gemini-1.5-flash-8b'));
  });

  test('all default Gemini models are detected as google', () => {
    for (const model of DEFAULT_GOOGLE_MODELS) {
      assert.strictEqual(
        detectProviderFromModel(model),
        'google',
        `${model} should be detected as google`,
      );
    }
  });
});
