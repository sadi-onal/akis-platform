/**
 * Unit tests for the multimodal Anthropic helper (issue #402 step 1).
 *
 * These don't hit the network — all tests inject a fake fetch via the
 * `fetchFn` dep so the request body and error-code paths can be exercised
 * deterministically. Full live verification happens end-to-end once the
 * helper is wired into ScribeAIDeps (step 2).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAnthropicMultimodalBody,
  callAnthropicMultimodal,
  AnthropicMultimodalError,
} from '../../src/services/ai/multimodalClient.js';
import type { AnthropicImageBlock } from "../../src/services/ai/multimodalClient.js";

const SAMPLE_IMAGE: AnthropicImageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
};

function fakeFetch(response: {
  status: number;
  body: unknown;
  captureOn?: { url?: string; body?: unknown; headers?: Record<string, string> };
}): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (response.captureOn) {
      response.captureOn.url = String(url);
      try {
        response.captureOn.body = JSON.parse(init?.body as string);
      } catch {
        response.captureOn.body = init?.body;
      }
      response.captureOn.headers = init?.headers as Record<string, string>;
    }
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
      text: async () =>
        typeof response.body === 'string' ? response.body : JSON.stringify(response.body),
    } as Response;
  }) as unknown as typeof fetch;
}

describe('buildAnthropicMultimodalBody', () => {
  it('places images before text in the user content array', () => {
    const body = buildAnthropicMultimodalBody({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are Scribe.',
      userText: 'Fikrim: todo app',
      images: [SAMPLE_IMAGE],
    });

    const messages = (body.messages as Array<{ role: string; content: unknown[] }>);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    const content = messages[0].content as Array<{ type: string; text?: string }>;
    assert.equal(content.length, 2);
    assert.equal(content[0].type, 'image');
    assert.equal(content[1].type, 'text');
    assert.equal(content[1].text, 'Fikrim: todo app');
  });

  it('emits system field separately from messages (Anthropic contract)', () => {
    const body = buildAnthropicMultimodalBody({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'SYS',
      userText: 'hi',
      images: [],
    });
    assert.equal(body.system, 'SYS');
    assert.ok(!String(body.system).includes('hi'));
  });

  it('defaults max_tokens to 4096 and omits temperature when not given', () => {
    const body = buildAnthropicMultimodalBody({
      model: 'claude-sonnet-4-6',
      systemPrompt: 's',
      userText: 'u',
      images: [],
    });
    assert.equal(body.max_tokens, 4096);
    assert.ok(!('temperature' in body));
  });

  it('passes through explicit max_tokens and temperature', () => {
    const body = buildAnthropicMultimodalBody({
      model: 'm',
      systemPrompt: 's',
      userText: 'u',
      images: [],
      maxTokens: 8192,
      temperature: 0,
    });
    assert.equal(body.max_tokens, 8192);
    assert.equal(body.temperature, 0);
  });

  it('preserves image order for multi-image requests', () => {
    const imgA: AnthropicImageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } };
    const imgB: AnthropicImageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB' } };
    const body = buildAnthropicMultimodalBody({
      model: 'm',
      systemPrompt: 's',
      userText: 'u',
      images: [imgA, imgB],
    });
    const content = (body.messages as Array<{ content: Array<{ type: string; source?: { media_type: string } }> }>)[0].content;
    assert.equal(content[0].source?.media_type, 'image/png');
    assert.equal(content[1].source?.media_type, 'image/jpeg');
    assert.equal(content[2].type, 'text');
  });
});

describe('callAnthropicMultimodal', () => {
  it('returns joined text content and usage on 200', async () => {
    const capture: { url?: string; body?: unknown; headers?: Record<string, string> } = {};
    const res = await callAnthropicMultimodal({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-6',
      systemPrompt: 'system',
      userText: 'Bu resmi yorumla',
      images: [SAMPLE_IMAGE],
      fetchFn: fakeFetch({
        status: 200,
        body: {
          content: [
            { type: 'text', text: 'Gördüğüm renkler: teal + beyaz.' },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 120, output_tokens: 30 },
        },
        captureOn: capture,
      }),
    });

    assert.equal(res.content, 'Gördüğüm renkler: teal + beyaz.');
    assert.equal(res.stopReason, 'end_turn');
    assert.equal(res.usage?.inputTokens, 120);
    assert.equal(res.usage?.outputTokens, 30);

    // Spot-check request shape
    assert.equal(capture.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(capture.headers?.['x-api-key'], 'sk-ant-test');
    assert.equal(capture.headers?.['anthropic-version'], '2023-06-01');
  });

  it('joins multiple text blocks with newlines', async () => {
    const res = await callAnthropicMultimodal({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userText: 'u',
      images: [SAMPLE_IMAGE],
      fetchFn: fakeFetch({
        status: 200,
        body: { content: [
          { type: 'text', text: 'line-1' },
          { type: 'text', text: 'line-2' },
        ] },
      }),
    });
    assert.equal(res.content, 'line-1\nline-2');
  });

  it('throws IMAGE_MODEL_UNSUPPORTED on 400 with "image" in error body', async () => {
    await assert.rejects(
      callAnthropicMultimodal({
        apiKey: 'k',
        model: 'outdated-model',
        systemPrompt: 's',
        userText: 'u',
        images: [SAMPLE_IMAGE],
        fetchFn: fakeFetch({
          status: 400,
          body: { error: { type: 'invalid_request_error', message: 'This model does not support image input' } },
        }),
      }),
      (err: unknown) => {
        assert.ok(err instanceof AnthropicMultimodalError);
        assert.equal((err as AnthropicMultimodalError).code, 'IMAGE_MODEL_UNSUPPORTED');
        return true;
      },
    );
  });

  it('throws IMAGE_API_ERROR on 5xx', async () => {
    await assert.rejects(
      callAnthropicMultimodal({
        apiKey: 'k',
        model: 'm',
        systemPrompt: 's',
        userText: 'u',
        images: [],
        fetchFn: fakeFetch({ status: 503, body: 'service unavailable' }),
      }),
      (err: unknown) => {
        assert.ok(err instanceof AnthropicMultimodalError);
        assert.equal((err as AnthropicMultimodalError).code, 'IMAGE_API_ERROR');
        assert.equal((err as AnthropicMultimodalError).status, 503);
        return true;
      },
    );
  });

  it('throws IMAGE_BAD_RESPONSE when 200 response has no text blocks', async () => {
    await assert.rejects(
      callAnthropicMultimodal({
        apiKey: 'k',
        model: 'm',
        systemPrompt: 's',
        userText: 'u',
        images: [],
        fetchFn: fakeFetch({
          status: 200,
          body: { content: [{ type: 'tool_use', id: 'x' }] },
        }),
      }),
      (err: unknown) => {
        assert.ok(err instanceof AnthropicMultimodalError);
        assert.equal((err as AnthropicMultimodalError).code, 'IMAGE_BAD_RESPONSE');
        return true;
      },
    );
  });

  it('uses custom baseUrl when supplied (proxy, self-hosted)', async () => {
    const capture: { url?: string } = {};
    await callAnthropicMultimodal({
      apiKey: 'k',
      model: 'm',
      systemPrompt: 's',
      userText: 'u',
      images: [],
      baseUrl: 'https://proxy.example/anthropic',
      fetchFn: fakeFetch({
        status: 200,
        body: { content: [{ type: 'text', text: 'ok' }] },
        captureOn: capture,
      }),
    });
    assert.equal(capture.url, 'https://proxy.example/anthropic/v1/messages');
  });
});
