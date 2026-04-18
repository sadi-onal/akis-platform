/**
 * Unit tests for ScribeAgent.dispatchGenerate — issue #402 step 2.
 *
 * Verifies the decision tree:
 *   no images                          → generateText
 *   images + no multimodal dep         → generateText
 *   images + multimodal dep            → generateTextWithImages
 *   images + multimodal throws         → fallback to generateText (graceful)
 *
 * Scribe's state machine + prompt pipeline are out of scope; we only drive
 * the private dispatch helper by poking analyzIdea with controlled deps and
 * asserting which mock fires.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ScribeAgent, type ScribeAIDeps, type ScribeState } from '../../src/pipeline/agents/scribe/ScribeAgent.js';
import type { AnthropicImageBlock } from '../../src/services/ai/multimodalClient.js';

const IMG: AnthropicImageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
};

/**
 * Expose the private `dispatchGenerate` via a subclass so we can unit-test it
 * without spinning up the full clarification/spec pipeline (which has many
 * other deps this test doesn't care about).
 */
class TestableScribeAgent extends ScribeAgent {
  public run(state: ScribeState, systemPrompt: string, userPrompt: string): Promise<string> {
    // `dispatchGenerate` is a private method on the base; the bracket-access cast
    // keeps tsc happy without loosening visibility on the production class.
    return (this as unknown as {
      dispatchGenerate: (s: ScribeState, sys: string, usr: string) => Promise<string>;
    }).dispatchGenerate(state, systemPrompt, userPrompt);
  }
}

function buildState(overrides: Partial<ScribeState> = {}): ScribeState {
  return {
    idea: 'bir todo app yap',
    conversation: [],
    clarificationRound: 0,
    phase: 'clarifying',
    pendingQuestionIds: [],
    answeredQuestionIds: [],
    ...overrides,
  };
}

describe('ScribeAgent.dispatchGenerate', () => {
  it('uses generateText when state has no images', async () => {
    const calls: string[] = [];
    const deps: ScribeAIDeps = {
      generateText: async () => {
        calls.push('text');
        return 'text-reply';
      },
      generateTextWithImages: async () => {
        calls.push('multimodal');
        return 'mm-reply';
      },
    };
    const agent = new TestableScribeAgent(deps);
    const res = await agent.run(buildState(), 'sys', 'user');
    assert.equal(res, 'text-reply');
    assert.deepEqual(calls, ['text']);
  });

  it('uses generateText when images present but multimodal dep is absent', async () => {
    const calls: string[] = [];
    const deps: ScribeAIDeps = {
      generateText: async () => {
        calls.push('text');
        return 'fallback';
      },
    };
    const agent = new TestableScribeAgent(deps);
    const res = await agent.run(buildState({ imageBlocks: [IMG] }), 's', 'u');
    assert.equal(res, 'fallback');
    assert.deepEqual(calls, ['text']);
  });

  it('uses generateTextWithImages when images are present and dep is supplied', async () => {
    const calls: Array<{ method: string; images?: number }> = [];
    const deps: ScribeAIDeps = {
      generateText: async () => {
        calls.push({ method: 'text' });
        return 'text-reply';
      },
      generateTextWithImages: async (_sys, _user, imgs) => {
        calls.push({ method: 'multimodal', images: imgs.length });
        return 'multimodal-reply';
      },
    };
    const agent = new TestableScribeAgent(deps);
    const res = await agent.run(buildState({ imageBlocks: [IMG, IMG] }), 's', 'u');
    assert.equal(res, 'multimodal-reply');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'multimodal');
    assert.equal(calls[0].images, 2);
  });

  it('falls back to generateText when multimodal throws (e.g. model unsupported)', async () => {
    const calls: string[] = [];
    const deps: ScribeAIDeps = {
      generateText: async () => {
        calls.push('text');
        return 'fallback-reply';
      },
      generateTextWithImages: async () => {
        calls.push('multimodal');
        throw new Error('IMAGE_MODEL_UNSUPPORTED');
      },
    };
    const agent = new TestableScribeAgent(deps);
    const res = await agent.run(buildState({ imageBlocks: [IMG] }), 's', 'u');
    assert.equal(res, 'fallback-reply');
    assert.deepEqual(calls, ['multimodal', 'text']);
  });

  it('treats empty imageBlocks array as no-images', async () => {
    const calls: string[] = [];
    const deps: ScribeAIDeps = {
      generateText: async () => {
        calls.push('text');
        return 'r';
      },
      generateTextWithImages: async () => {
        calls.push('multimodal');
        return 'mm';
      },
    };
    const agent = new TestableScribeAgent(deps);
    await agent.run(buildState({ imageBlocks: [] }), 's', 'u');
    assert.deepEqual(calls, ['text']);
  });
});
