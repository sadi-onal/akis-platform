/**
 * Unit tests for ProtoAgent iteration-mode multimodal dispatch — issue #427 BUG-19.
 *
 * Verifies the decision tree when the user attaches screenshots to a pipeline
 * iteration ("bunu düzelt" + image):
 *   no images                          → generateText
 *   images + no multimodal dep         → generateText
 *   images + multimodal dep            → generateTextWithImages
 *   images + multimodal throws         → fallback to generateText (graceful)
 *   empty imageBlocks                  → generateText (treated as no-images)
 *
 * Mirrors backend/test/unit/scribe-multimodal-dispatch.test.ts structure.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ProtoAgent,
  type ProtoAIDeps,
  type ProtoGitHubDeps,
} from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type { ProtoInput, StructuredSpec } from '../../src/pipeline/core/contracts/PipelineTypes.js';
import type { AnthropicImageBlock } from '../../src/services/ai/multimodalClient.js';

const IMG: AnthropicImageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
};

const minimalSpec: StructuredSpec = {
  title: 'Test App',
  problemStatement: 'x',
  userStories: [{ persona: 'user', action: 'do thing', benefit: 'value' }],
  acceptanceCriteria: [{ id: 'ac-1', given: 'a', when: 'b', then: 'c' }],
  technicalConstraints: { stack: 'test' },
  outOfScope: [],
};

const iterationResponse = JSON.stringify({
  files: [{ filePath: 'App.tsx', content: 'export const App = () => <div />', linesOfCode: 1 }],
  setupCommands: ['npm install'],
  metadata: { filesCreated: 1, totalLinesOfCode: 1, stackUsed: 'iteration' },
});

function iterationInput(overrides?: Partial<ProtoInput>): ProtoInput {
  return {
    spec: minimalSpec,
    repoName: 'test-repo',
    repoVisibility: 'private',
    owner: 'testuser',
    iterationRequest: 'ikinci input alanını da büyük yap',
    existingFiles: [{ path: 'App.tsx', content: 'export const App = () => <div />' }],
    ...overrides,
  };
}

function stubGithub(): ProtoGitHubDeps {
  return {
    createRepository: async () => ({ url: 'https://github.com/testuser/test-repo' }),
    createBranch: async () => { /* no-op */ },
    commitFile: async () => { /* no-op */ },
    pushFiles: async () => { /* no-op */ },
    createPR: async () => ({ url: 'https://github.com/testuser/test-repo/pull/1' }),
    listFiles: async () => [],
    getFileContent: async () => '',
  };
}

describe('ProtoAgent.dispatchIterationGenerate', () => {
  it('uses generateText when iteration has no images', async () => {
    const calls: string[] = [];
    const ai: ProtoAIDeps = {
      generateText: async () => {
        calls.push('text');
        return iterationResponse;
      },
      generateTextWithImages: async () => {
        calls.push('multimodal');
        return iterationResponse;
      },
    };
    const agent = new ProtoAgent(ai, stubGithub());
    const result = await agent.execute(iterationInput());
    assert.equal(result.type, 'output');
    assert.deepEqual(calls, ['text']);
  });

  it('uses generateText when images present but multimodal dep is absent', async () => {
    const calls: string[] = [];
    const ai: ProtoAIDeps = {
      generateText: async () => {
        calls.push('text');
        return iterationResponse;
      },
    };
    const agent = new ProtoAgent(ai, stubGithub());
    const result = await agent.execute(iterationInput({ imageBlocks: [IMG] }));
    assert.equal(result.type, 'output');
    assert.deepEqual(calls, ['text']);
  });

  it('uses generateTextWithImages when images are present and dep is supplied', async () => {
    const calls: Array<{ method: string; images?: number }> = [];
    const ai: ProtoAIDeps = {
      generateText: async () => {
        calls.push({ method: 'text' });
        return iterationResponse;
      },
      generateTextWithImages: async (_sys, _user, imgs) => {
        calls.push({ method: 'multimodal', images: imgs.length });
        return iterationResponse;
      },
    };
    const agent = new ProtoAgent(ai, stubGithub());
    const result = await agent.execute(iterationInput({ imageBlocks: [IMG, IMG] }));
    assert.equal(result.type, 'output');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'multimodal');
    assert.equal(calls[0].images, 2);
  });

  it('falls back to generateText when multimodal throws (model unsupported)', async () => {
    const calls: string[] = [];
    const ai: ProtoAIDeps = {
      generateText: async () => {
        calls.push('text');
        return iterationResponse;
      },
      generateTextWithImages: async () => {
        calls.push('multimodal');
        throw new Error('IMAGE_MODEL_UNSUPPORTED');
      },
    };
    const agent = new ProtoAgent(ai, stubGithub());
    const result = await agent.execute(iterationInput({ imageBlocks: [IMG] }));
    assert.equal(result.type, 'output');
    assert.deepEqual(calls, ['multimodal', 'text']);
  });

  it('treats empty imageBlocks array as no-images', async () => {
    const calls: string[] = [];
    const ai: ProtoAIDeps = {
      generateText: async () => {
        calls.push('text');
        return iterationResponse;
      },
      generateTextWithImages: async () => {
        calls.push('multimodal');
        return iterationResponse;
      },
    };
    const agent = new ProtoAgent(ai, stubGithub());
    await agent.execute(iterationInput({ imageBlocks: [] }));
    assert.deepEqual(calls, ['text']);
  });

  it('injects image-ack section into the iteration prompt when images are present', async () => {
    let capturedUserPrompt: string | undefined;
    const ai: ProtoAIDeps = {
      generateText: async (_sys, user) => {
        capturedUserPrompt = user;
        return iterationResponse;
      },
      generateTextWithImages: async (_sys, user) => {
        capturedUserPrompt = user;
        return iterationResponse;
      },
    };
    const agent = new ProtoAgent(ai, stubGithub());
    await agent.execute(iterationInput({ imageBlocks: [IMG] }));
    assert.ok(capturedUserPrompt, 'prompt should have been sent');
    assert.match(capturedUserPrompt!, /USER-UPLOADED SCREENSHOTS/);
    assert.match(capturedUserPrompt!, /1 screenshot\(s\)/);
  });

  it('does not mention screenshots in the prompt when no images are attached', async () => {
    let capturedUserPrompt: string | undefined;
    const ai: ProtoAIDeps = {
      generateText: async (_sys, user) => {
        capturedUserPrompt = user;
        return iterationResponse;
      },
    };
    const agent = new ProtoAgent(ai, stubGithub());
    await agent.execute(iterationInput());
    assert.ok(capturedUserPrompt);
    assert.doesNotMatch(capturedUserPrompt!, /USER-UPLOADED SCREENSHOTS/);
  });
});
