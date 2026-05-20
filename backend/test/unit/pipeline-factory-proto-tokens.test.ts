/**
 * PR-V-proto-diagnostics (2026-05-20) — pipeline-factory must wire Proto's AI
 * dep with `maxTokens: 64_000` so large scaffold responses don't truncate
 * mid-JSON. This was previously 16 384, which caused
 * PROTO_SCAFFOLD_GENERATION_FAILED on complex specs even though all 3 retries
 * succeeded talking to the model — the model was returning truncated JSON.
 *
 * The test exercises `createAgentsForModel` with a stub `AIServiceLike` that
 * records the `maxTokens` arg every call, then triggers Proto's `generateText`
 * dep and asserts it was 64 000.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAgentsForModel,
  type AIServiceLike,
  type GitHubServiceLike,
} from '../../src/pipeline/core/pipeline-factory.js';

function makeRecordingAIService(): AIServiceLike & { calls: Array<{ maxTokens?: number }> } {
  const calls: Array<{ maxTokens?: number }> = [];
  return {
    calls,
    async generateWorkArtifact(input) {
      calls.push({ maxTokens: input.maxTokens });
      return { content: '{}', metadata: {} };
    },
  };
}

function makeStubGitHubService(): GitHubServiceLike {
  // Cast through unknown because we never actually exercise GitHub here — Proto's
  // AI dep is what we're poking at via generateText.
  return {} as unknown as GitHubServiceLike;
}

describe('pipeline-factory — Proto max_tokens parity with Trace', () => {
  it('Proto generateText forwards maxTokens=64000 (parity with Trace)', async () => {
    const ai = makeRecordingAIService();
    const github = makeStubGitHubService();

    const agents = createAgentsForModel(ai, github);
    // Proxy at the dep level — call the dep directly, no need to drive the
    // whole agent through to assert what the factory wired.
    // We pull the deps off the agent via its public surface: ProtoAgent stores
    // `this.ai` privately, so instead we drive a fresh dep through the same
    // factory wiring by exercising one synthetic generateText call.
    //
    // The factory does not expose createProtoAIDeps directly. The cleanest
    // black-box path is to call agent.execute() with a dryRun input that
    // triggers exactly one generateText call (the scaffold path), then read
    // ai.calls.
    const result = await agents.proto.execute({
      spec: {
        title: 'X',
        problemStatement: 'p',
        userStories: [{ persona: 'u', action: 'a', benefit: 'b' }],
        acceptanceCriteria: [{ id: 'ac-1', given: 'g', when: 'w', then: 't' }],
        technicalConstraints: { stack: 'React + Vite' },
        outOfScope: [],
      },
      repoName: 'x',
      repoVisibility: 'private',
      owner: 'o',
      dryRun: true,
    });

    // We don't assert on result.type — the stub AI returns '{}' which fails
    // scaffold parsing; the assertion is on the maxTokens that flowed.
    void result;
    assert.ok(ai.calls.length > 0, 'AIService.generateWorkArtifact must be called');
    // Every call originating from Proto's generateText should carry 64000.
    for (const call of ai.calls) {
      assert.equal(
        call.maxTokens,
        64_000,
        `Proto generateText must request 64K tokens (got ${call.maxTokens})`
      );
    }
  });

  it('Proto multimodal generateTextWithImages forwards maxTokens=64000', async () => {
    const captured: Array<number | undefined> = [];
    const aiService: AIServiceLike = {
      async generateWorkArtifact(input) {
        captured.push(input.maxTokens);
        return { content: '{}', metadata: {} };
      },
      async generateMultimodalArtifact(input) {
        captured.push(input.maxTokens);
        return { content: '{}', metadata: {} };
      },
    };
    const github = makeStubGitHubService();

    const agents = createAgentsForModel(aiService, github);
    // Iteration path with imageBlocks → triggers generateTextWithImages.
    const res = await agents.proto.execute({
      spec: {
        title: 'X',
        problemStatement: 'p',
        userStories: [{ persona: 'u', action: 'a', benefit: 'b' }],
        acceptanceCriteria: [{ id: 'ac-1', given: 'g', when: 'w', then: 't' }],
        technicalConstraints: { stack: 'React + Vite' },
        outOfScope: [],
      },
      repoName: 'x',
      repoVisibility: 'private',
      owner: 'o',
      dryRun: true,
      iterationRequest: 'make it blue',
      existingFiles: [{ path: 'App.jsx', content: 'x' }],
      imageBlocks: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'b64' } },
      ],
    });
    void res;
    assert.ok(captured.length > 0, 'multimodal artifact path must be exercised');
    for (const m of captured) {
      assert.equal(m, 64_000, `multimodal call must request 64K tokens (got ${m})`);
    }
  });
});
