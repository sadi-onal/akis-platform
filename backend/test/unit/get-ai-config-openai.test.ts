/**
 * P1a: getAIConfig OpenAI defaults.
 *
 * When `provider === 'openai'`, AIConfig must come back with:
 *  - baseUrl = https://api.openai.com/v1 (unless overridden by env)
 *  - modelDefault/modelPlanner/modelValidation = non-empty (gpt-4o-mini fallback)
 *
 * We call getAIConfig with a constructed Env shape instead of going through
 * envSchema.parse, because the schema would also require AUTH_JWT_SECRET and a
 * lot of unrelated entries. getAIConfig only reads the AI_* / OPENAI_* fields.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getAIConfig, type Env } from '../../src/config/env.js';

function baseEnv(overrides: Partial<Env>): Env {
  // Cast: we only populate the AI-related fields used by getAIConfig. The
  // function never touches the other fields, so undefined is fine.
  return {
    AI_PROVIDER: 'openai',
    ...overrides,
  } as unknown as Env;
}

describe('getAIConfig — OpenAI defaults (P1a)', () => {
  test('defaults baseUrl to https://api.openai.com/v1 when no env override', () => {
    const config = getAIConfig(baseEnv({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' } as Partial<Env>));
    assert.equal(config.provider, 'openai');
    assert.equal(config.baseUrl, 'https://api.openai.com/v1');
  });

  test('returns non-empty model defaults for all three slots', () => {
    const config = getAIConfig(baseEnv({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' } as Partial<Env>));
    assert.ok(config.modelDefault && config.modelDefault.length > 0);
    assert.ok(config.modelPlanner && config.modelPlanner.length > 0);
    assert.ok(config.modelValidation && config.modelValidation.length > 0);
    // The fallback should be the documented gpt-4o-mini default.
    assert.equal(config.modelDefault, 'gpt-4o-mini');
  });

  test('AI_MODEL_DEFAULT env override wins over the gpt-4o-mini fallback', () => {
    const config = getAIConfig(
      baseEnv({
        AI_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-test',
        AI_MODEL_DEFAULT: 'gpt-4o',
      } as Partial<Env>),
    );
    assert.equal(config.modelDefault, 'gpt-4o');
  });

  test('apiKey picked up from OPENAI_API_KEY when AI_API_KEY missing', () => {
    const config = getAIConfig(
      baseEnv({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-openai-xyz' } as Partial<Env>),
    );
    assert.equal(config.apiKey, 'sk-openai-xyz');
  });
});
