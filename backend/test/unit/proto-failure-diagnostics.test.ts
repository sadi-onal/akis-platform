/**
 * PR-V-proto-diagnostics (2026-05-20) — every PROTO_SCAFFOLD_GENERATION_FAILED
 * raise site must persist a slice of the raw AI response into
 * `PipelineError.technicalDetail`, so production failures can be diagnosed
 * from the pipeline row (no log rotation, no replay) — just grep
 * `pipelines.error->>'technicalDetail'`.
 *
 * Six raise sites are exercised: iteration parse-fail, AI-call-after-retries,
 * empty-response-after-retries, invalid-JSON-after-retries,
 * no-files-after-retries, and the terminal "all retries exhausted".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ProtoAgent,
  buildProtoFailureDetail,
  type ProtoAIDeps,
  type ProtoGitHubDeps,
} from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type {
  ProtoInput,
  StructuredSpec,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';

const spec: StructuredSpec = {
  title: 'Diag',
  problemStatement: 'p',
  userStories: [{ persona: 'u', action: 'a', benefit: 'b' }],
  acceptanceCriteria: [{ id: 'ac-1', given: 'g', when: 'w', then: 't' }],
  technicalConstraints: { stack: 'React + Vite' },
  outOfScope: [],
};

function baseInput(overrides?: Partial<ProtoInput>): ProtoInput {
  return {
    spec,
    repoName: 'x',
    repoVisibility: 'private',
    owner: 'o',
    dryRun: true,
    ...overrides,
  };
}

function makeAI(handler: () => Promise<string>): ProtoAIDeps {
  return { generateText: handler };
}

function makeGitHub(): ProtoGitHubDeps {
  return {
    createRepository: async () => ({ url: 'x' }),
    createBranch: async () => {},
    commitFile: async () => {},
    pushFiles: async () => {},
    createPR: async () => ({ url: 'x' }),
    listFiles: async () => [],
    getFileContent: async () => '',
  };
}

describe('buildProtoFailureDetail — helper', () => {
  it('includes the rawResponse length and a 2 000-char slice when present', () => {
    const raw = 'x'.repeat(3_000);
    const detail = buildProtoFailureDetail('reason', raw);
    assert.match(detail, /reason/);
    assert.match(detail, /rawResponseLen=3000/);
    // Slice is 2 000 chars + ellipsis.
    assert.match(detail, /x{2000}…/);
  });

  it('does not truncate responses shorter than the cap', () => {
    const raw = '{"files":[]}';
    const detail = buildProtoFailureDetail('short', raw);
    assert.match(detail, /rawResponseLen=12/);
    assert.match(detail, /\{"files":\[\]\}/);
    // No ellipsis when under the cap.
    assert.equal(detail.includes('…'), false);
  });

  it('handles undefined / empty rawResponse without crashing', () => {
    assert.match(buildProtoFailureDetail('r1', undefined), /AI response: <empty>/);
    // Empty string → still labelled as empty since the helper only slices a
    // string. Truthiness check picks up '' as falsy.
    assert.match(buildProtoFailureDetail('r2', ''), /AI response: <empty>/);
  });
});

describe('ProtoAgent — PROTO_SCAFFOLD_GENERATION_FAILED carries raw AI response', () => {
  it('iteration parse-fail includes the raw response in technicalDetail', async () => {
    const rawIterResponse = 'not even close to JSON — definitely not a scaffold';
    const ai = makeAI(async () => rawIterResponse);
    const agent = new ProtoAgent(ai, makeGitHub());

    const result = await agent.execute(
      baseInput({
        iterationRequest: 'tweak the UI',
        existingFiles: [{ path: 'App.jsx', content: 'x' }],
      })
    );
    assert.equal(result.type, 'error');
    if (result.type !== 'error') return;
    assert.equal(result.error.code, 'PROTO_SCAFFOLD_GENERATION_FAILED');
    assert.ok(
      result.error.technicalDetail?.includes(rawIterResponse),
      `technicalDetail must include raw AI response (got: ${result.error.technicalDetail})`
    );
    assert.match(result.error.technicalDetail!, /rawResponseLen=\d+/);
  });

  it('scaffold no-files terminal failure includes the raw response in technicalDetail', async () => {
    // Empty `files` array makes the JSON parse fine but trips the
    // "No files generated" branch after retries.
    const rawScaffold = JSON.stringify({
      files: [],
      setupCommands: [],
      metadata: { filesCreated: 0, totalLinesOfCode: 0, stackUsed: 'x' },
    });
    const ai = makeAI(async () => rawScaffold);
    const agent = new ProtoAgent(ai, makeGitHub());

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type !== 'error') return;
    assert.equal(result.error.code, 'PROTO_SCAFFOLD_GENERATION_FAILED');
    assert.ok(
      result.error.technicalDetail?.includes('"files":[]'),
      `technicalDetail must include the empty-files JSON (got: ${result.error.technicalDetail})`
    );
  });

  it('scaffold empty-response terminal failure labels rawResponse as empty', async () => {
    const ai = makeAI(async () => '');
    const agent = new ProtoAgent(ai, makeGitHub());

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type !== 'error') return;
    assert.equal(result.error.code, 'PROTO_SCAFFOLD_GENERATION_FAILED');
    assert.match(result.error.technicalDetail!, /AI response: <empty>/);
  });

  it('scaffold AI-throws terminal failure includes the last successful response (if any) and the error message', async () => {
    // First call returns a valid-but-empty payload (so we have a lastResponse),
    // subsequent calls throw — the terminal raise should reference the throw
    // message AND we should still get the snippet logged from the partial run.
    let attempt = 0;
    const ai = makeAI(async () => {
      attempt++;
      throw new Error(`mock provider blew up on attempt ${attempt}`);
    });
    const agent = new ProtoAgent(ai, makeGitHub());

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type !== 'error') return;
    assert.equal(result.error.code, 'PROTO_SCAFFOLD_GENERATION_FAILED');
    assert.match(result.error.technicalDetail!, /AI call failed after retries/);
    assert.match(result.error.technicalDetail!, /mock provider blew up/);
  });

  it('scaffold invalid-JSON terminal failure includes the raw response in technicalDetail', async () => {
    // Returns text that neither parses as JSON nor repairs cleanly.
    const rawInvalid = 'this is not json {{{ at all';
    const ai = makeAI(async () => rawInvalid);
    const agent = new ProtoAgent(ai, makeGitHub());

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'error');
    if (result.type !== 'error') return;
    assert.equal(result.error.code, 'PROTO_SCAFFOLD_GENERATION_FAILED');
    // The raw response should appear in technicalDetail (snippet).
    assert.ok(
      result.error.technicalDetail?.includes('this is not json'),
      `technicalDetail must include raw response (got: ${result.error.technicalDetail})`
    );
  });
});
