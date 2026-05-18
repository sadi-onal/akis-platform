/**
 * P1a: End-to-end smoke test for the OpenAI runtime path through
 * RealAIService.
 *
 * Verifies:
 * 1. AIService POSTs to `${baseUrl}/chat/completions`.
 * 2. Authorization header carries the configured API key as a Bearer token.
 * 3. The request body is OpenAI-shaped (model + messages + temperature +
 *    max_tokens) — not Anthropic-shaped.
 * 4. parseOpenAIResponse pulls `choices[0].message.content` into the worker
 *    result content.
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

let originalFetch: typeof globalThis.fetch;
let originalNodeEnv: string | undefined;

describe('OpenAI runtime — request/response wire shape (P1a)', () => {
  let fetchMock: ReturnType<typeof mock.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    fetchMock = mock.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Mock OpenAI response.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('POSTs to /chat/completions with OpenAI-shaped body and Bearer auth', async () => {
    const { createAIService } = await import('../../src/services/ai/AIService.js');
    const service = createAIService({
      provider: 'openai',
      apiKey: 'sk-test-xyz',
      baseUrl: 'https://api.openai.com/v1',
      modelDefault: 'gpt-4o-mini',
      modelPlanner: 'gpt-4o-mini',
      modelValidation: 'gpt-4o',
    });

    const result = await service.generateWorkArtifact({
      task: 'Write a haiku about TypeScript',
      context: { tone: 'formal' },
    });

    // 1. Endpoint
    assert.equal(fetchMock.mock.calls.length, 1, 'expected exactly one fetch call');
    const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');

    // 2. Method + auth header
    assert.equal(init.method, 'POST');
    const headers = init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer sk-test-xyz');
    assert.equal(headers['Content-Type'], 'application/json');

    // 3. OpenAI request shape (NOT Anthropic — no `system` field, has `messages`)
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    assert.equal(body.model, 'gpt-4o-mini');
    assert.ok(Array.isArray(body.messages), 'body.messages must be an array');
    assert.equal(typeof body.temperature, 'number');
    assert.equal(typeof body.max_tokens, 'number');
    assert.ok(!('system' in body), 'OpenAI body must not have Anthropic-style `system` field');

    // 4. Response parsed into WorkerResult.content
    assert.equal(result.content, 'Mock OpenAI response.');
  });
});
