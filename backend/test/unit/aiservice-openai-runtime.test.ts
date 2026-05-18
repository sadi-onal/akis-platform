import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * P1a: OpenAI runtime client is active.
 *
 * createAIService({ provider: 'openai', apiKey: '...' }) must return a
 * RealAIService (not throw, not fall through to mock) so the pipeline can
 * actually call the OpenAI Chat Completions endpoint.
 *
 * Behaviour locked in:
 * 1. With apiKey present → RealAIService, summary.provider === 'openai'.
 * 2. With apiKey missing → falls back to MockAIService (existing guard).
 * 3. NODE_ENV=test still short-circuits to mock; we override per-test.
 */

describe('createAIService — OpenAI runtime (P1a)', () => {
  it('returns a real OpenAI service when provider=openai and apiKey is set', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { createAIService } = await import('../../src/services/ai/AIService.js');
      const config = {
        provider: 'openai' as const,
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        modelDefault: 'gpt-4o-mini',
        modelPlanner: 'gpt-4o-mini',
        modelValidation: 'gpt-4o',
      };

      const service = createAIService(config);
      const summary = service.getConfigSummary();

      assert.strictEqual(
        summary.provider,
        'openai',
        'expected RealAIService for openai provider with apiKey',
      );
      assert.strictEqual(summary.models.default, 'gpt-4o-mini');
      assert.strictEqual(summary.models.planner, 'gpt-4o-mini');
      assert.strictEqual(summary.models.validation, 'gpt-4o');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('falls back to mock when openai provider has no apiKey', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { createAIService } = await import('../../src/services/ai/AIService.js');
      const config = {
        provider: 'openai' as const,
        baseUrl: 'https://api.openai.com/v1',
        modelDefault: 'gpt-4o-mini',
        modelPlanner: 'gpt-4o-mini',
        modelValidation: 'gpt-4o',
      };

      const service = createAIService(config);
      const summary = service.getConfigSummary();
      assert.strictEqual(summary.provider, 'mock', 'no apiKey should fall back to mock');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
