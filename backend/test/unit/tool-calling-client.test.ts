process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';
process.env.AUTH_JWT_SECRET ??= 'test-jwt-secret-at-least-32-chars-long-for-zod';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createToolCallingClient } from '../../src/services/ai/AIService.js';
import { AIProviderError } from '../../src/lib/errors.js';
import type { AIConfig } from '../../src/config/env.js';

const config: AIConfig = {
  provider: 'anthropic',
  apiKey: 'sk-ant-test',
  baseUrl: 'https://api.anthropic.test',
  modelDefault: 'claude-haiku-4-5',
  modelPlanner: 'claude-haiku-4-5',
  modelValidation: 'claude-haiku-4-5',
};

const message = [{ role: 'user' as const, content: 'hello' }];
const tools = [{ name: 'noop', description: 'No-op tool', inputSchema: { properties: {} } }];
const originalFetch = globalThis.fetch;

describe('createToolCallingClient', () => {
  beforeEach(() => {
    process.env.AI_TOOL_CALL_TIMEOUT_MS = '5';
    process.env.AI_TOOL_CALL_RETRY_DELAY_MS = '1';
    process.env.AI_TOOL_CALL_MAX_RETRIES = '1';
  });

  afterEach(() => {
    delete process.env.AI_TOOL_CALL_TIMEOUT_MS;
    delete process.env.AI_TOOL_CALL_RETRY_DELAY_MS;
    delete process.env.AI_TOOL_CALL_MAX_RETRIES;
    globalThis.fetch = originalFetch;
  });

  it('aborts hung provider requests and reports a network error', async () => {
    let attempts = 0;
    const fetchMock: typeof fetch = (_url, init) => {
      attempts++;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    };
    globalThis.fetch = fetchMock;

    const client = createToolCallingClient(config);

    await assert.rejects(
      () => client(message, tools),
      (error: unknown) => {
        assert.ok(error instanceof AIProviderError);
        assert.equal(error.code, 'AI_NETWORK_ERROR');
        assert.match(error.message, /timed out after 5ms/);
        return true;
      }
    );
    assert.equal(attempts, 2);
  });

  it('retries transient network errors and returns the successful response', async () => {
    let attempts = 0;
    const fetchMock: typeof fetch = async () => {
      attempts++;
      if (attempts === 1) throw new TypeError('socket hang up');
      return new Response(
        JSON.stringify({
          id: 'msg-1',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };
    globalThis.fetch = fetchMock;

    const client = createToolCallingClient(config);
    const response = await client(message, tools);

    assert.equal(attempts, 2);
    assert.equal(response.id, 'msg-1');
    assert.equal(response.content[0]?.type, 'text');
  });
});
