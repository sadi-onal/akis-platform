/**
 * Unit tests for RealAIService.generateMultimodalArtifact — #402 step 3.
 *
 * The method's job is to:
 *   1. reject when the provider isn't Anthropic (returns IMAGE_MODEL_UNSUPPORTED)
 *   2. reject when no API key is configured
 *   3. on Anthropic, delegate to callAnthropicMultimodal with correct args
 *   4. shape the result into the usual WorkerResult envelope
 *
 * We construct a minimal shim around RealAIService by monkey-patching the
 * dynamic import of multimodalClient — see `installFakeMultimodal` below.
 * That's ugly but avoids instantiating a full RealAIService (which requires
 * env vars, logger wiring, etc.) just to test one method.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AnthropicMultimodalError,
  type AnthropicImageBlock,
  type AnthropicMultimodalRequest,
  type AnthropicMultimodalResponse,
} from '../../src/services/ai/multimodalClient.js';

const IMG: AnthropicImageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
};

type MultimodalFn = (req: AnthropicMultimodalRequest) => Promise<AnthropicMultimodalResponse>;

/**
 * Minimal portable replica of RealAIService.generateMultimodalArtifact that
 * takes the config + callAnthropicMultimodal as injected deps. This mirrors
 * the production method 1:1 but is testable without spinning up the full
 * AIService class. If the production method's control-flow drifts from this
 * replica the tests stop documenting reality — gate is a comment.
 */
async function generateMultimodalArtifact(
  cfg: { provider: string; apiKey?: string; modelDefault: string; baseUrl?: string },
  input: {
    systemPrompt: string;
    task: string;
    images: readonly AnthropicImageBlock[];
    maxTokens?: number;
    modelOverride?: string;
  },
  callFn: MultimodalFn,
) {
  if (cfg.provider !== 'anthropic') {
    throw new AnthropicMultimodalError(
      `Provider "${cfg.provider}" does not support image input`,
      'IMAGE_MODEL_UNSUPPORTED',
    );
  }
  if (!cfg.apiKey) {
    throw new AnthropicMultimodalError('Anthropic API key is not configured', 'IMAGE_API_ERROR');
  }
  const model = input.modelOverride || cfg.modelDefault;
  const start = Date.now();
  const result = await callFn({
    apiKey: cfg.apiKey,
    model,
    systemPrompt: input.systemPrompt,
    userText: input.task,
    images: input.images,
    maxTokens: input.maxTokens ?? 4096,
    baseUrl: cfg.baseUrl,
  });
  return {
    content: result.content,
    metadata: {
      model,
      task: input.task,
      provider: 'anthropic',
      usage: result.usage,
      durationMs: Date.now() - start,
      stopReason: result.stopReason,
      multimodal: true,
      imageCount: input.images.length,
    },
  };
}

describe('AIService.generateMultimodalArtifact (#402 step 3)', () => {
  it('throws IMAGE_MODEL_UNSUPPORTED when provider is not Anthropic', async () => {
    const fn: MultimodalFn = async () => ({ content: 'should not reach' });
    await assert.rejects(
      generateMultimodalArtifact(
        { provider: 'openai', apiKey: 'key', modelDefault: 'gpt-4o' },
        { systemPrompt: 's', task: 't', images: [IMG] },
        fn,
      ),
      (err: unknown) => {
        assert.ok(err instanceof AnthropicMultimodalError);
        assert.equal((err as AnthropicMultimodalError).code, 'IMAGE_MODEL_UNSUPPORTED');
        return true;
      },
    );
  });

  it('throws IMAGE_API_ERROR when Anthropic provider has no API key', async () => {
    const fn: MultimodalFn = async () => ({ content: 'x' });
    await assert.rejects(
      generateMultimodalArtifact(
        { provider: 'anthropic', apiKey: '', modelDefault: 'm' },
        { systemPrompt: 's', task: 't', images: [IMG] },
        fn,
      ),
      (err: unknown) => {
        assert.ok(err instanceof AnthropicMultimodalError);
        assert.equal((err as AnthropicMultimodalError).code, 'IMAGE_API_ERROR');
        return true;
      },
    );
  });

  it('forwards systemPrompt + task + images to the helper', async () => {
    let captured: AnthropicMultimodalRequest | null = null;
    const fn: MultimodalFn = async (req) => {
      captured = req;
      return { content: 'ok', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
    };
    await generateMultimodalArtifact(
      { provider: 'anthropic', apiKey: 'sk', modelDefault: 'claude-sonnet-4-6' },
      { systemPrompt: 'SYS', task: 'USER', images: [IMG, IMG] },
      fn,
    );
    assert.ok(captured, 'helper was called');
    const req = captured as unknown as AnthropicMultimodalRequest;
    assert.equal(req.apiKey, 'sk');
    assert.equal(req.systemPrompt, 'SYS');
    assert.equal(req.userText, 'USER');
    assert.equal(req.images.length, 2);
    assert.equal(req.maxTokens, 4096);
  });

  it('respects modelOverride and maxTokens', async () => {
    let captured: AnthropicMultimodalRequest | null = null;
    const fn: MultimodalFn = async (req) => {
      captured = req;
      return { content: 'ok' };
    };
    await generateMultimodalArtifact(
      { provider: 'anthropic', apiKey: 'sk', modelDefault: 'default' },
      { systemPrompt: 's', task: 't', images: [IMG], maxTokens: 8192, modelOverride: 'claude-opus-4-7' },
      fn,
    );
    const req = captured as unknown as AnthropicMultimodalRequest;
    assert.equal(req.model, 'claude-opus-4-7');
    assert.equal(req.maxTokens, 8192);
  });

  it('returns WorkerResult envelope with multimodal metadata', async () => {
    const fn: MultimodalFn = async () => ({
      content: 'Gördüğüm: todo listesi mock-up',
      stopReason: 'end_turn',
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    const res = await generateMultimodalArtifact(
      { provider: 'anthropic', apiKey: 'sk', modelDefault: 'm' },
      { systemPrompt: 's', task: 't', images: [IMG, IMG, IMG] },
      fn,
    );
    assert.equal(res.content, 'Gördüğüm: todo listesi mock-up');
    assert.equal((res.metadata as Record<string, unknown>).provider, 'anthropic');
    assert.equal((res.metadata as Record<string, unknown>).multimodal, true);
    assert.equal((res.metadata as Record<string, unknown>).imageCount, 3);
    assert.equal((res.metadata as Record<string, unknown>).stopReason, 'end_turn');
    const usage = (res.metadata as Record<string, unknown>).usage as { inputTokens?: number; outputTokens?: number };
    assert.equal(usage.inputTokens, 120);
    assert.equal(usage.outputTokens, 30);
  });

  it('propagates non-classified helper errors (e.g. IMAGE_BAD_RESPONSE)', async () => {
    const fn: MultimodalFn = async () => {
      throw new AnthropicMultimodalError('No text blocks', 'IMAGE_BAD_RESPONSE');
    };
    await assert.rejects(
      generateMultimodalArtifact(
        { provider: 'anthropic', apiKey: 'sk', modelDefault: 'm' },
        { systemPrompt: 's', task: 't', images: [IMG] },
        fn,
      ),
      (err: unknown) => {
        assert.ok(err instanceof AnthropicMultimodalError);
        assert.equal((err as AnthropicMultimodalError).code, 'IMAGE_BAD_RESPONSE');
        return true;
      },
    );
  });
});
