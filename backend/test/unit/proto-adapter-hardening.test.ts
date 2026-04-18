/**
 * ProtoAgent — adapter hardening tests (issue #470 BUG-E re-open).
 *
 * Verifies that silent adapter failures (createRepository or pushFiles
 * appearing to succeed but the repo being empty / non-existent) are
 * detected and the pipeline ends with PROTO_PUSH_FAILED, not ok:true.
 *
 * The specific prod scenario that escaped PR #471:
 *   - createRepository POST succeeds → GitHub auto_init creates README.md
 *   - push_files step fails silently (or produces a non-"Error:" prefixed message)
 *   - verifyRepoPushed calls listFiles → sees ["README.md"] → count > 0 → false OK
 *   - Pipeline reports ok:true, repo appears empty when Trace reads it
 *
 * Fixes verified here:
 *   1. AgenticLoop stores "Error: <msg>" (prefixed) in toolCalls.result on failure
 *   2. verifyRepoPushed checks pushed file paths, not just count > 0
 *   3. push_files handler error in agentic path detected and fails pipeline
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ProtoAgent,
  type ProtoAIDeps,
  type ProtoGitHubDeps,
} from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type { ProtoInput, StructuredSpec } from '../../src/pipeline/core/contracts/PipelineTypes.js';
import type { AgenticLoopDeps } from '../../src/pipeline/core/AgenticLoop.js';
import type { AnthropicResponse } from '../../src/services/ai/tool-schemas.js';

// ─── Fixtures ─────────────────────────────────────

const validSpec: StructuredSpec = {
  title: 'Stopwatch',
  problemStatement: 'A simple stopwatch app.',
  userStories: [
    { persona: 'User', action: 'Start/stop timer', benefit: 'Measure time' },
  ],
  acceptanceCriteria: [
    { id: 'ac-1', given: 'App loaded', when: 'User clicks Start', then: 'Timer starts counting' },
  ],
  technicalConstraints: { stack: 'HTML + CSS + JS', integrations: [], nonFunctional: [] },
  outOfScope: [],
};

function baseInput(overrides?: Partial<ProtoInput>): ProtoInput {
  return {
    spec: validSpec,
    repoName: 'vanilla-stopwatch-test',
    repoVisibility: 'public',
    owner: 'OmerYasirOnal',
    ...overrides,
  };
}

function createMockAI(): ProtoAIDeps {
  return { async generateText() { return '{"files":[],"setupCommands":[],"metadata":{}}'; } };
}

/** Factory that builds an AgenticLoopDeps simulating push_files throwing. */
function createAgenticDepsWithPushFailure(pushError: Error): AgenticLoopDeps {
  let iteration = 0;

  return {
    async callWithTools(_messages, _tools, _opts): Promise<AnthropicResponse> {
      iteration++;

      if (iteration === 1) {
        return {
          id: 'msg-1',
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_create',
              name: 'create_repository',
              input: { owner: 'OmerYasirOnal', name: 'vanilla-stopwatch-test', isPrivate: false },
            },
          ],
        };
      }

      if (iteration === 2) {
        return {
          id: 'msg-2',
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_push',
              name: 'push_files',
              input: {
                owner: 'OmerYasirOnal',
                repo: 'vanilla-stopwatch-test',
                branch: 'main',
                files: [
                  { path: 'index.html', content: '<!DOCTYPE html>' },
                  { path: 'README.md', content: '# Stopwatch' },
                  { path: '.gitignore', content: 'node_modules' },
                ],
                message: 'feat: initial scaffold',
              },
            },
          ],
        };
      }

      // Iteration 3: push_files returned is_error:true, Claude generates summary anyway
      return {
        id: 'msg-3',
        stop_reason: 'end_turn',
        content: [
          { type: 'text', text: '{"ok":true,"filesCreated":3}' },
        ],
      };
    },
  };

  void pushError; // suppress unused warning — handlers throw below
}

// ─── Tests ────────────────────────────────────────

describe('ProtoAgent — Adapter Hardening (issue #470 BUG-E re-open)', () => {
  /**
   * SCENARIO A: push_files adapter throws during agentic loop.
   * AgenticLoop stores "Error: <msg>" (prefixed) in toolCalls.result.
   * ProtoAgent.executeWithTools should detect this and return PROTO_PUSH_FAILED.
   */
  it('SCENARIO A: push_files throws in agentic loop → PROTO_PUSH_FAILED (not ok:true)', async () => {
    const pushError = new Error('GitHub API PATCH /repos/OmerYasirOnal/vanilla-stopwatch-test/git/refs/heads/main → 422: Reference already exists');

    // GitHub adapter: createRepository succeeds, pushFiles throws
    const github: ProtoGitHubDeps = {
      async createRepository() { return { url: 'https://github.com/OmerYasirOnal/vanilla-stopwatch-test' }; },
      async createBranch() {},
      async commitFile() {},
      async createPR() { return { url: 'https://github.com/OmerYasirOnal/vanilla-stopwatch-test/pull/1' }; },
      async pushFiles() { throw pushError; },
      // listFiles returns only the auto_init README — this was the false-positive in PR #471
      async listFiles() { return ['README.md']; },
    };

    const agenticDeps = createAgenticDepsWithPushFailure(pushError);
    const agent = new ProtoAgent(createMockAI(), github, agenticDeps);

    const result = await agent.execute(baseInput());

    assert.equal(result.type, 'error', 'Pipeline should fail when push_files throws');
    if (result.type !== 'error') return;
    assert.equal(
      result.error.code,
      'PROTO_PUSH_FAILED',
      `Expected PROTO_PUSH_FAILED, got ${result.error.code}`,
    );
  });

  /**
   * SCENARIO B: push_files succeeds on the adapter but the repo only has
   * the auto_init README.md (none of the scaffold files pushed).
   * verifyRepoPushed must detect this via path cross-check.
   */
  it('SCENARIO B: listFiles returns only auto_init README — verifyRepoPushed detects false-positive', async () => {
    let pushFilesCalled = false;

    const github: ProtoGitHubDeps = {
      async createRepository() { return { url: 'https://github.com/OmerYasirOnal/vanilla-stopwatch-test' }; },
      async createBranch() {},
      async commitFile() {},
      async createPR() { return { url: 'https://github.com/OmerYasirOnal/vanilla-stopwatch-test/pull/1' }; },
      async pushFiles() {
        // Silently returns without error but files never actually landed
        pushFilesCalled = true;
      },
      // Only auto_init file present — none of the scaffold paths
      async listFiles() { return ['README.md']; },
    };

    // Build agenticDeps that calls push_files successfully (no throw)
    let iteration = 0;
    const agenticDeps: AgenticLoopDeps = {
      async callWithTools(_messages, _tools, _opts): Promise<AnthropicResponse> {
        iteration++;
        if (iteration === 1) {
          return {
            id: 'msg-1', stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'toolu_create', name: 'create_repository', input: { owner: 'OmerYasirOnal', name: 'vanilla-stopwatch-test', isPrivate: false } }],
          };
        }
        if (iteration === 2) {
          return {
            id: 'msg-2', stop_reason: 'tool_use',
            content: [{
              type: 'tool_use', id: 'toolu_push', name: 'push_files',
              input: {
                owner: 'OmerYasirOnal', repo: 'vanilla-stopwatch-test', branch: 'main',
                files: [
                  { path: 'index.html', content: '<!DOCTYPE html>' },
                  { path: '.gitignore', content: 'node_modules' },
                ],
                message: 'feat: scaffold',
              },
            }],
          };
        }
        return {
          id: 'msg-3', stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"ok":true,"filesCreated":2}' }],
        };
      },
    };

    const agent = new ProtoAgent(createMockAI(), github, agenticDeps);
    const result = await agent.execute(baseInput());

    assert.ok(pushFilesCalled, 'push_files handler should have been invoked');
    assert.equal(result.type, 'error', 'Pipeline should fail when pushed paths not found in repo');
    if (result.type !== 'error') return;
    assert.equal(
      result.error.code,
      'PROTO_PUSH_FAILED',
      `Expected PROTO_PUSH_FAILED, got ${result.error.code}`,
    );
    // technicalDetail carries the specific diagnostic; message is the generic Turkish string
    const detail = result.error.technicalDetail ?? '';
    assert.ok(
      detail.toLowerCase().includes('none of the') ||
        detail.toLowerCase().includes('scaffold files'),
      `technicalDetail should mention scaffold files not found; got: "${detail}"`,
    );
  });

  /**
   * SCENARIO C: happy path — push_files succeeds and scaffold files appear in listFiles.
   * verifyRepoPushed should pass and pipeline should return ok:true.
   */
  it('SCENARIO C: push_files succeeds and scaffold files present in listFiles → ok:true', async () => {
    const github: ProtoGitHubDeps = {
      async createRepository() { return { url: 'https://github.com/OmerYasirOnal/vanilla-stopwatch-test' }; },
      async createBranch() {},
      async commitFile() {},
      async createPR() { return { url: 'https://github.com/OmerYasirOnal/vanilla-stopwatch-test/pull/1' }; },
      async pushFiles() { /* success */ },
      // Returns the scaffold files that were pushed
      async listFiles() { return ['index.html', 'README.md', '.gitignore']; },
    };

    let iteration = 0;
    const agenticDeps: AgenticLoopDeps = {
      async callWithTools(_messages, _tools, _opts): Promise<AnthropicResponse> {
        iteration++;
        if (iteration === 1) {
          return {
            id: 'msg-1', stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'toolu_create', name: 'create_repository', input: { owner: 'OmerYasirOnal', name: 'vanilla-stopwatch-test', isPrivate: false } }],
          };
        }
        if (iteration === 2) {
          return {
            id: 'msg-2', stop_reason: 'tool_use',
            content: [{
              type: 'tool_use', id: 'toolu_push', name: 'push_files',
              input: {
                owner: 'OmerYasirOnal', repo: 'vanilla-stopwatch-test', branch: 'main',
                files: [
                  { path: 'index.html', content: '<!DOCTYPE html>' },
                  { path: 'README.md', content: '# Stopwatch' },
                  { path: '.gitignore', content: 'node_modules' },
                ],
                message: 'feat: scaffold',
              },
            }],
          };
        }
        return {
          id: 'msg-3', stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"ok":true,"filesCreated":3}' }],
        };
      },
    };

    const agent = new ProtoAgent(createMockAI(), github, agenticDeps);
    const result = await agent.execute(baseInput());

    assert.equal(result.type, 'output', 'Pipeline should succeed when scaffold files are confirmed');
    if (result.type !== 'output') return;
    assert.equal(result.data.ok, true);
    assert.ok(result.data.metadata.committed, 'committed should be true');
  });

  /**
   * SCENARIO D: verifyRepoPushed fallback — adapter has no listFiles.
   * Should silently pass (legacy adapters in tests).
   */
  it('SCENARIO D: listFiles not available on adapter → verification skipped, pipeline succeeds', async () => {
    const github: ProtoGitHubDeps = {
      async createRepository() { return { url: 'https://github.com/OmerYasirOnal/vanilla-stopwatch-test' }; },
      async createBranch() {},
      async commitFile() {},
      async createPR() { return { url: 'https://github.com/OmerYasirOnal/vanilla-stopwatch-test/pull/1' }; },
      async pushFiles() { /* success */ },
      // No listFiles — legacy adapter
    };

    let iteration = 0;
    const agenticDeps: AgenticLoopDeps = {
      async callWithTools(_messages, _tools, _opts): Promise<AnthropicResponse> {
        iteration++;
        if (iteration === 1) {
          return {
            id: 'msg-1', stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'toolu_create', name: 'create_repository', input: { owner: 'OmerYasirOnal', name: 'vanilla-stopwatch-test', isPrivate: false } }],
          };
        }
        if (iteration === 2) {
          return {
            id: 'msg-2', stop_reason: 'tool_use',
            content: [{
              type: 'tool_use', id: 'toolu_push', name: 'push_files',
              input: {
                owner: 'OmerYasirOnal', repo: 'vanilla-stopwatch-test', branch: 'main',
                files: [{ path: 'index.html', content: '<!DOCTYPE html>' }],
                message: 'feat: scaffold',
              },
            }],
          };
        }
        return {
          id: 'msg-3', stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"ok":true,"filesCreated":1}' }],
        };
      },
    };

    const agent = new ProtoAgent(createMockAI(), github, agenticDeps);
    const result = await agent.execute(baseInput());

    assert.equal(result.type, 'output', 'Should succeed when listFiles not available (legacy adapter)');
  });

  /**
   * SCENARIO E: push_files never called by agentic loop → PROTO_PUSH_FAILED.
   * Guards against model hallucinating success without calling the tool.
   */
  it('SCENARIO E: push_files never called by loop → PROTO_PUSH_FAILED', async () => {
    const github: ProtoGitHubDeps = {
      async createRepository() { return { url: 'https://github.com/OmerYasirOnal/vanilla-stopwatch-test' }; },
      async createBranch() {},
      async commitFile() {},
      async createPR() { return { url: 'https://github.com/OmerYasirOnal/vanilla-stopwatch-test/pull/1' }; },
      async pushFiles() { /* would succeed, but never called */ },
      async listFiles() { return []; },
    };

    // Loop calls create_repository, then immediately returns end_turn without push_files
    let iteration = 0;
    const agenticDeps: AgenticLoopDeps = {
      async callWithTools(_messages, _tools, _opts): Promise<AnthropicResponse> {
        iteration++;
        if (iteration === 1) {
          return {
            id: 'msg-1', stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'toolu_create', name: 'create_repository', input: { owner: 'OmerYasirOnal', name: 'vanilla-stopwatch-test', isPrivate: false } }],
          };
        }
        // Skips push_files — returns end_turn directly
        return {
          id: 'msg-2', stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Scaffold created successfully.' }],
        };
      },
    };

    const agent = new ProtoAgent(createMockAI(), github, agenticDeps);
    const result = await agent.execute(baseInput());

    assert.equal(result.type, 'error', 'Pipeline should fail when push_files was never called');
    if (result.type !== 'error') return;
    assert.equal(result.error.code, 'PROTO_PUSH_FAILED');
  });
});
