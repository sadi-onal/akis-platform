/**
 * Unit tests for TraceAgent multimodal dispatch — issue #464 BUG-C.
 *
 * Verifies the decision tree when user-uploaded screenshots reach Trace:
 *   no images                          → generateText
 *   images + no multimodal dep         → generateText (graceful fallback)
 *   images + multimodal dep            → generateTextWithImages
 *   images + multimodal throws         → fallback to generateText (graceful)
 *   empty imageBlocks                  → generateText (treated as no-images)
 *   multi-image preservation           → all images forwarded, not just first
 *
 * Mirrors backend/test/unit/proto-multimodal-iteration.test.ts structure
 * so Scribe/Proto/Trace share one readable multimodal-dispatch contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TraceAgent,
  type TraceAIDeps,
  type TraceGitHubDeps,
} from '../../src/pipeline/agents/trace/TraceAgent.js';
import type { TraceInput, StructuredSpec } from '../../src/pipeline/core/contracts/PipelineTypes.js';
import type { AnthropicImageBlock } from '../../src/services/ai/multimodalClient.js';

const IMG: AnthropicImageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
};

const IMG2: AnthropicImageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' },
};

const IMG3: AnthropicImageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/webp', data: 'CCCC' },
};

const spec: StructuredSpec = {
  title: 'Todo',
  problemStatement: 'Track tasks',
  userStories: [{ persona: 'user', action: 'add task', benefit: 'track' }],
  acceptanceCriteria: [{ id: 'ac-1', given: 'open', when: 'click add', then: 'new task' }],
  technicalConstraints: { stack: 'React + Vite' },
  outOfScope: [],
};

const testResponse = JSON.stringify({
  testFiles: [
    {
      filePath: 'tests/e2e/todo.spec.ts',
      content:
        'import { test, expect } from "@playwright/test";\n\ntest("opens homepage", async ({ page }) => {\n  await page.goto("/");\n  await expect(page).toHaveTitle(/Todo/);\n});',
      testCount: 1,
    },
  ],
  coverageMatrix: { 'ac-1': ['tests/e2e/todo.spec.ts'] },
  testSummary: {
    totalTests: 1,
    coveragePercentage: 100,
    coveredCriteria: ['ac-1'],
    uncoveredCriteria: [],
  },
});

function stubGithub(): TraceGitHubDeps {
  return {
    listFiles: async () => ['src/App.tsx'],
    getFileContent: async () => 'export default () => <div>hi</div>;',
    commitFile: async () => {
      /* no-op */
    },
    pushFiles: async () => {
      /* no-op */
    },
    createBranch: async () => {
      /* no-op */
    },
    createPR: async () => ({ url: 'https://github.com/x/y/pull/1' }),
  };
}

function baseInput(overrides?: Partial<TraceInput>): TraceInput {
  return {
    repoOwner: 'u',
    repo: 'r',
    branch: 'main',
    spec,
    // dryRun keeps the push step out of the test so we can focus on dispatch
    dryRun: true,
    ...overrides,
  };
}

describe('TraceAgent.dispatchGenerate (legacy path)', () => {
  it('uses generateText when no imageBlocks are attached', async () => {
    const calls: string[] = [];
    const ai: TraceAIDeps = {
      generateText: async () => {
        calls.push('text');
        return testResponse;
      },
      generateTextWithImages: async () => {
        calls.push('multimodal');
        return testResponse;
      },
    };
    const agent = new TraceAgent(ai, stubGithub());
    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    assert.deepEqual(calls, ['text']);
  });

  it('uses generateText when images present but multimodal dep is absent', async () => {
    const calls: string[] = [];
    const ai: TraceAIDeps = {
      generateText: async () => {
        calls.push('text');
        return testResponse;
      },
    };
    const agent = new TraceAgent(ai, stubGithub());
    const result = await agent.execute(baseInput({ imageBlocks: [IMG] }));
    assert.equal(result.type, 'output');
    assert.deepEqual(calls, ['text']);
  });

  it('uses generateTextWithImages when images and multimodal dep are both present', async () => {
    const calls: Array<{ method: string; images?: number }> = [];
    const ai: TraceAIDeps = {
      generateText: async () => {
        calls.push({ method: 'text' });
        return testResponse;
      },
      generateTextWithImages: async (_sys, _user, imgs) => {
        calls.push({ method: 'multimodal', images: imgs.length });
        return testResponse;
      },
    };
    const agent = new TraceAgent(ai, stubGithub());
    const result = await agent.execute(baseInput({ imageBlocks: [IMG, IMG2] }));
    assert.equal(result.type, 'output');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'multimodal');
    assert.equal(calls[0].images, 2);
  });

  it('forwards all images (multi-image preservation) — 3 images reach the multimodal dep', async () => {
    let captured: readonly AnthropicImageBlock[] | undefined;
    const ai: TraceAIDeps = {
      generateText: async () => testResponse,
      generateTextWithImages: async (_sys, _user, imgs) => {
        captured = imgs;
        return testResponse;
      },
    };
    const agent = new TraceAgent(ai, stubGithub());
    const result = await agent.execute(baseInput({ imageBlocks: [IMG, IMG2, IMG3] }));
    assert.equal(result.type, 'output');
    assert.ok(captured, 'images should reach the multimodal dep');
    assert.equal(captured!.length, 3);
    assert.equal(captured![0].source.data, 'AAAA');
    assert.equal(captured![1].source.data, 'BBBB');
    assert.equal(captured![2].source.data, 'CCCC');
  });

  it('falls back to generateText when multimodal throws (model unsupported)', async () => {
    const calls: string[] = [];
    const ai: TraceAIDeps = {
      generateText: async () => {
        calls.push('text');
        return testResponse;
      },
      generateTextWithImages: async () => {
        calls.push('multimodal');
        throw new Error('IMAGE_MODEL_UNSUPPORTED');
      },
    };
    const agent = new TraceAgent(ai, stubGithub());
    const result = await agent.execute(baseInput({ imageBlocks: [IMG] }));
    assert.equal(result.type, 'output');
    assert.deepEqual(calls, ['multimodal', 'text']);
  });

  it('treats empty imageBlocks array as no-images', async () => {
    const calls: string[] = [];
    const ai: TraceAIDeps = {
      generateText: async () => {
        calls.push('text');
        return testResponse;
      },
      generateTextWithImages: async () => {
        calls.push('multimodal');
        return testResponse;
      },
    };
    const agent = new TraceAgent(ai, stubGithub());
    await agent.execute(baseInput({ imageBlocks: [] }));
    assert.deepEqual(calls, ['text']);
  });

  it('injects screenshot-ack section into the user prompt when images are present', async () => {
    let capturedUserPrompt: string | undefined;
    const ai: TraceAIDeps = {
      generateText: async (_sys, user) => {
        capturedUserPrompt = user;
        return testResponse;
      },
      generateTextWithImages: async (_sys, user) => {
        capturedUserPrompt = user;
        return testResponse;
      },
    };
    const agent = new TraceAgent(ai, stubGithub());
    await agent.execute(baseInput({ imageBlocks: [IMG] }));
    assert.ok(capturedUserPrompt, 'prompt should have been sent');
    assert.match(capturedUserPrompt!, /User-Uploaded Screenshots/);
    assert.match(capturedUserPrompt!, /1 screenshot\(s\)/);
  });

  it('does not mention screenshots in the prompt when none are attached', async () => {
    let capturedUserPrompt: string | undefined;
    const ai: TraceAIDeps = {
      generateText: async (_sys, user) => {
        capturedUserPrompt = user;
        return testResponse;
      },
    };
    const agent = new TraceAgent(ai, stubGithub());
    await agent.execute(baseInput());
    assert.ok(capturedUserPrompt);
    assert.doesNotMatch(capturedUserPrompt!, /User-Uploaded Screenshots/);
  });
});
