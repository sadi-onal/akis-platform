/**
 * Unit tests for AI model allowlist — pure function tests
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  isModelAllowed,
  detectProviderFromModel,
  isModelCompatibleWithProvider,
  getRecommendedModel,
  getAllKnownModels,
  DEFAULT_ANTHROPIC_MODELS,
  DEFAULT_OPENAI_MODELS,
  DEFAULT_OPENROUTER_MODELS,
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

  test('detects OpenAI models by text- prefix', () => {
    assert.strictEqual(detectProviderFromModel('text-embedding-3-small'), 'openai');
  });

  test('detects OpenAI models by davinci prefix', () => {
    assert.strictEqual(detectProviderFromModel('davinci-002'), 'openai');
  });

  test('detects OpenRouter models by org/model format', () => {
    assert.strictEqual(detectProviderFromModel('anthropic/claude-sonnet-4'), 'openrouter');
    assert.strictEqual(detectProviderFromModel('google/gemini-2.5-flash'), 'openrouter');
  });

  test('detects OpenRouter models by :free suffix', () => {
    assert.strictEqual(detectProviderFromModel('meta-llama/llama-4:free'), 'openrouter');
  });

  test('detects OpenRouter models by :nitro suffix', () => {
    assert.strictEqual(detectProviderFromModel('anthropic/claude-3:nitro'), 'openrouter');
  });

  test('detects Anthropic models by claude- prefix', () => {
    assert.strictEqual(detectProviderFromModel('claude-haiku-4-5-20251001'), 'anthropic');
    assert.strictEqual(detectProviderFromModel('claude-sonnet-4-20250514'), 'anthropic');
    assert.strictEqual(detectProviderFromModel('claude-opus-4-20250514'), 'anthropic');
  });

  test('returns null for unknown model format', () => {
    assert.strictEqual(detectProviderFromModel('some-unknown-model'), null);
    assert.strictEqual(detectProviderFromModel('custom-model-v2'), null);
  });
});

// ─── isModelCompatibleWithProvider ─────────────────────────────────────

describe('isModelCompatibleWithProvider', () => {
  test('OpenAI model is compatible with OpenAI', () => {
    assert.strictEqual(isModelCompatibleWithProvider('gpt-4o-mini', 'openai'), true);
  });

  test('OpenAI model is compatible with OpenRouter (proxying)', () => {
    assert.strictEqual(isModelCompatibleWithProvider('gpt-4o-mini', 'openrouter'), true);
  });

  test('OpenRouter model is NOT compatible with OpenAI', () => {
    assert.strictEqual(isModelCompatibleWithProvider('anthropic/claude-sonnet-4', 'openai'), false);
  });

  test('OpenRouter model is compatible with OpenRouter', () => {
    assert.strictEqual(isModelCompatibleWithProvider('anthropic/claude-sonnet-4', 'openrouter'), true);
  });

  test('unknown model format is compatible with any provider', () => {
    assert.strictEqual(isModelCompatibleWithProvider('some-new-model', 'openai'), true);
    assert.strictEqual(isModelCompatibleWithProvider('some-new-model', 'openrouter'), true);
  });
});

// ─── getRecommendedModel ───────────────────────────────────────────────

describe('getRecommendedModel', () => {
  test('returns correct recommended model for openai', () => {
    assert.strictEqual(getRecommendedModel('openai'), RECOMMENDED_MODELS.openai);
  });

  test('returns correct recommended model for openrouter', () => {
    assert.strictEqual(getRecommendedModel('openrouter'), RECOMMENDED_MODELS.openrouter);
  });
});

// ─── Default constants ─────────────────────────────────────────────────

describe('Default model lists', () => {
  test('DEFAULT_ANTHROPIC_MODELS is non-empty', () => {
    assert.ok(DEFAULT_ANTHROPIC_MODELS.length > 0);
  });

  test('DEFAULT_OPENAI_MODELS is non-empty', () => {
    assert.ok(DEFAULT_OPENAI_MODELS.length > 0);
  });

  test('DEFAULT_OPENROUTER_MODELS is non-empty', () => {
    assert.ok(DEFAULT_OPENROUTER_MODELS.length > 0);
  });

  test('all default Anthropic models are detected as Anthropic', () => {
    for (const model of DEFAULT_ANTHROPIC_MODELS) {
      assert.strictEqual(
        detectProviderFromModel(model),
        'anthropic',
        `${model} should be detected as anthropic`
      );
    }
  });

  test('all default OpenAI models are detected as OpenAI', () => {
    for (const model of DEFAULT_OPENAI_MODELS) {
      assert.strictEqual(
        detectProviderFromModel(model),
        'openai',
        `${model} should be detected as openai`
      );
    }
  });

  test('all default OpenRouter models are detected as OpenRouter', () => {
    for (const model of DEFAULT_OPENROUTER_MODELS) {
      assert.strictEqual(
        detectProviderFromModel(model),
        'openrouter',
        `${model} should be detected as openrouter`
      );
    }
  });
});

// ─── getAllKnownModels (issue #437) ────────────────────────────────────

describe('getAllKnownModels', () => {
  test('returns union of all provider default lists', () => {
    const all = getAllKnownModels();
    for (const m of DEFAULT_ANTHROPIC_MODELS) assert.ok(all.includes(m), `${m} missing`);
    for (const m of DEFAULT_OPENAI_MODELS) assert.ok(all.includes(m), `${m} missing`);
    for (const m of DEFAULT_OPENROUTER_MODELS) assert.ok(all.includes(m), `${m} missing`);
  });

  test('all entries pass detectProviderFromModel', () => {
    for (const m of getAllKnownModels()) {
      const p = detectProviderFromModel(m);
      assert.ok(
        p === 'anthropic' || p === 'openai' || p === 'openrouter',
        `model '${m}' must be detectable`
      );
    }
  });
});
