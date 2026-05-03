import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * PR-A defensive guard: createAIService MUST throw when called with
 * provider: 'openai' until PR-B B5 wires up the OpenAIClient. Two reasons
 * to lock this in with a test:
 *
 * 1. modelAllowlist + Settings tab also block OpenAI today, but a future
 *    refactor could re-add it without lighting up the runtime — this test
 *    fails loudly if that happens.
 * 2. The error message is the contract the rest of the system relies on
 *    (chat surface shows it verbatim), so changing the wording also fails
 *    the test.
 *
 * When PR-B B5 lands and OpenAI works, this test should be deleted.
 */

describe('createAIService — OpenAI defensive guard (PR-A)', () => {
  it('throws a clear PR-B B5 message when provider is openai', async () => {
    // Test runs with NODE_ENV=test, which short-circuits createAIService to
    // MockAIService. We need to flip that so the OpenAI branch is reachable.
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { createAIService } = await import('../../src/services/ai/AIService.js');
      const config = {
        provider: 'openai' as const,
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        modelDefault: 'gpt-4o',
        modelPlanner: 'gpt-4o',
        modelValidation: 'gpt-4o',
      };
      assert.throws(
        () => createAIService(config),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /OpenAI desteklenecek \(PR-B B5\)/);
          return true;
        },
      );
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
