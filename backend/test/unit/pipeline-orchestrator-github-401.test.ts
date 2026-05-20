/**
 * PR-V-github-401-graceful — orchestrator handles GITHUB_TOKEN_INVALID.
 *
 * Scenario from the real bug (pipeline 592d97d0-a264-4ef2-9907-6762be924f03):
 *   1. User OAuth'd GitHub at 07:10 — token stored in github_integrations.
 *   2. User revoked the token at github.com.
 *   3. New pipeline runs at 10:17. Proto succeeds (no GitHub touch in mock).
 *      Trace tries to list files → adapter returns GitHubTokenInvalidError.
 *   4. TraceAgent now surfaces GITHUB_TOKEN_INVALID (not the vague
 *      TRACE_CODE_READ_FAILED), and the orchestrator must:
 *        - Call the injected `invalidateUserGitHubToken` hook to drop the
 *          stale row from `github_integrations`.
 *        - Skip FixLoop (auth failures don't recover with code regeneration).
 *        - Land the pipeline at `completed_partial` with the user-actionable
 *          error code intact so the frontend banner renders the reconnect CTA.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.AUTO_PUSH_AFTER_PROTO = 'true';

import {
  PipelineOrchestrator,
  type PipelineStore,
  type PipelineStateUpdate,
} from '../../src/pipeline/core/orchestrator/PipelineOrchestrator.js';
import { __clearEnvCacheForTests } from '../../src/config/env.js';

__clearEnvCacheForTests();

import {
  createPipelineError,
  PipelineErrorCode,
} from '../../src/pipeline/core/contracts/PipelineErrors.js';
import type {
  PipelineState,
  PipelineStage,
  ScribeOutput,
  StructuredSpec,
  ProtoOutput,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';
import type { ScribeAgent, ScribeState } from '../../src/pipeline/agents/scribe/ScribeAgent.js';
import type { ProtoAgent, ProtoResult } from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type { TraceAgent, TraceResult } from '../../src/pipeline/agents/trace/TraceAgent.js';

// ─── Fixtures ─────────────────────────────────────

const validSpec: StructuredSpec = {
  title: 'QR Code Generator',
  problemStatement: 'Quick way to generate QR codes from URLs.',
  userStories: [
    { persona: 'Bakkal sahibi', action: 'QR kod oluşturma', benefit: 'Müşterilere paylaşma' },
  ],
  acceptanceCriteria: [
    { id: 'ac-1', given: 'Kullanıcı', when: 'URL girer', then: 'QR kod gösterilir' },
  ],
  technicalConstraints: { stack: 'React' },
  outOfScope: [],
};

const mockScribeOutput: ScribeOutput = {
  spec: validSpec,
  rawMarkdown: '# QR Code Generator\n...',
  confidence: 0.9,
  clarificationsAsked: 0,
};

const mockProtoOutput: ProtoOutput = {
  ok: true,
  branch: 'proto/scaffold-001',
  repo: 'testuser/qr-kod-uretici',
  repoUrl: 'https://github.com/testuser/qr-kod-uretici',
  files: [{ filePath: 'src/App.tsx', content: 'export default function App() {}', linesOfCode: 1 }],
  setupCommands: ['npm install'],
  metadata: { filesCreated: 1, totalLinesOfCode: 1, stackUsed: 'React', committed: true },
};

// ─── In-Memory Store ──────────────────────────────

class InMemoryStore implements PipelineStore {
  private pipelines = new Map<string, PipelineState>();

  async create(userId: string): Promise<PipelineState> {
    const id = crypto.randomUUID();
    const pipeline: PipelineState = {
      id,
      userId,
      stage: 'scribe_generating',
      scribeConversation: [],
      metrics: { startedAt: new Date(), clarificationRounds: 0, retryCount: 0 },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.pipelines.set(id, pipeline);
    return { ...pipeline };
  }

  async getById(id: string): Promise<PipelineState | null> {
    const p = this.pipelines.get(id);
    return p ? { ...p } : null;
  }

  async listByUser(userId: string): Promise<PipelineState[]> {
    return [...this.pipelines.values()].filter((p) => p.userId === userId).map((p) => ({ ...p }));
  }

  async update(id: string, data: Partial<PipelineStateUpdate>): Promise<PipelineState> {
    const existing = this.pipelines.get(id);
    if (!existing) throw new Error(`Pipeline not found: ${id}`);
    const updated: PipelineState = {
      ...existing,
      ...data,
      metrics: data.metrics ? { ...existing.metrics, ...data.metrics } : existing.metrics,
      updatedAt: new Date(),
    } as PipelineState;
    if (data.error === null) updated.error = undefined;
    this.pipelines.set(id, updated);
    return { ...updated };
  }
}

async function waitForStage(
  store: PipelineStore,
  id: string,
  targetStages: PipelineStage[],
  timeoutMs = 5000
): Promise<PipelineState> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = await store.getById(id);
    if (p && targetStages.includes(p.stage)) return p;
    await new Promise((r) => setTimeout(r, 10));
  }
  const p = await store.getById(id);
  throw new Error(`Timeout: expected ${targetStages.join('|')}, got ${p?.stage}`);
}

function createMockScribe(): ScribeAgent {
  return {
    createInitialState(input: { idea: string }): ScribeState {
      return {
        idea: input.idea,
        conversation: [],
        clarificationRound: 0,
        phase: 'clarifying' as const,
      };
    },
    analyzIdea: async () => ({ type: 'spec' as const, data: mockScribeOutput }),
    processUserAnswer() {},
    continueAfterAnswer: async () => ({ type: 'spec' as const, data: mockScribeOutput }),
    regenerateSpec: async () => ({ type: 'spec' as const, data: mockScribeOutput }),
    generateSpec: async () => ({ type: 'spec' as const, data: mockScribeOutput }),
  } as unknown as ScribeAgent;
}

function createMockProto(): ProtoAgent {
  return {
    execute: async (): Promise<ProtoResult> => ({ type: 'output' as const, data: mockProtoOutput }),
  } as unknown as ProtoAgent;
}

/**
 * TraceAgent stub that fails with GITHUB_TOKEN_INVALID — simulates the
 * adapter throwing GitHubTokenInvalidError on a 401 from GitHub's
 * /repos/{owner}/{repo}/git/trees endpoint during Trace.readCodebase.
 */
function createAuthFailingTrace(): TraceAgent {
  return {
    execute: async (): Promise<TraceResult> => ({
      type: 'error' as const,
      error: createPipelineError(
        PipelineErrorCode.GITHUB_TOKEN_INVALID,
        'GitHub API GET /repos/testuser/qr-kod-uretici/git/trees/main → 401: Bad credentials'
      ),
    }),
  } as unknown as TraceAgent;
}

interface BuildOrchestratorOpts {
  /** Inject the token-invalidation hook (omit to test the no-hook path). */
  invalidator?: (userId: string) => Promise<boolean>;
}

function createOrchestrator(opts: BuildOrchestratorOpts = {}) {
  const store = new InMemoryStore();
  const orchestrator = new PipelineOrchestrator(
    store,
    createMockScribe(),
    createMockProto(),
    createAuthFailingTrace(),
    async () => 'testuser',
    async () => 'ghp_mock_token_for_tests',
    () => ({
      createRepository: async (_o: string, name: string) => ({
        url: `https://github.com/test/${name}`,
      }),
      createBranch: async () => {},
      commitFile: async () => {},
      pushFiles: async () => {},
      createPR: async () => ({ url: '' }),
      listFiles: async () => [] as string[],
      getFileContent: async () => '',
    })
  );
  if (opts.invalidator) {
    orchestrator.setGitHubTokenInvalidator(opts.invalidator);
  }
  return { store, orchestrator };
}

// ─── Tests ────────────────────────────────────────

describe('PR-V-github-401-graceful — orchestrator handles GITHUB_TOKEN_INVALID', () => {
  it('calls the injected invalidator with the pipeline owner userId when Trace surfaces 401', async () => {
    let invalidatedFor: string | null = null;
    const { orchestrator, store } = createOrchestrator({
      invalidator: async (userId) => {
        invalidatedFor = userId;
        return true;
      },
    });

    const started = await orchestrator.startPipeline(
      'user-revoked-token',
      { idea: 'QR kod oluşturucu' },
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'qr-kod-uretici', 'private');

    // Pipeline lands at completed_partial (graceful degradation) with the
    // GITHUB_TOKEN_INVALID error preserved for the frontend banner.
    const final = await waitForStage(store, started.id, ['completed_partial']);

    assert.equal(
      invalidatedFor,
      'user-revoked-token',
      'invalidator must be called with the pipeline owner'
    );
    assert.equal(final.error?.code, 'GITHUB_TOKEN_INVALID');
    assert.equal(final.error?.recoveryAction, 'reconnect_github');
    assert.equal(final.error?.retryable, false);
  });

  it('does NOT trigger FixLoop on a GITHUB_TOKEN_INVALID error', async () => {
    // FixLoop's whole purpose is to regenerate code based on Trace feedback —
    // but auth failures aren't recoverable by code changes. Re-entering Proto
    // would just burn AI credits and fail Trace with the same 401 again.
    // Assert by counting how many times the trace agent gets called.
    let traceCalls = 0;
    const store = new InMemoryStore();
    const tracingTrace = {
      execute: async (): Promise<TraceResult> => {
        traceCalls++;
        return {
          type: 'error' as const,
          error: createPipelineError(PipelineErrorCode.GITHUB_TOKEN_INVALID, '401 Bad credentials'),
        };
      },
    } as unknown as TraceAgent;
    const orchestrator = new PipelineOrchestrator(
      store,
      createMockScribe(),
      createMockProto(),
      tracingTrace,
      async () => 'testuser',
      async () => 'ghp_mock',
      () => ({
        createRepository: async (_o: string, name: string) => ({ url: `https://x/${name}` }),
        createBranch: async () => {},
        commitFile: async () => {},
        pushFiles: async () => {},
        createPR: async () => ({ url: '' }),
        listFiles: async () => [] as string[],
        getFileContent: async () => '',
      })
    );
    orchestrator.setGitHubTokenInvalidator(async () => true);

    const started = await orchestrator.startPipeline(
      'user-revoked',
      { idea: 'QR kod' },
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'qr-kod', 'private');
    await waitForStage(store, started.id, ['completed_partial']);

    // Critical: Trace called exactly once (initial attempt only). If FixLoop
    // fired, we'd see >=2 invocations (initial + at least one FixLoop retry).
    assert.equal(traceCalls, 1, 'FixLoop must NOT re-run Trace on auth failure');
  });

  it('still lands the pipeline at completed_partial when no invalidator is wired (graceful no-op)', async () => {
    // The token-invalidation hook is optional (test seams may not provide
    // it). The user-facing error code/banner must still surface correctly;
    // only the DB cleanup is skipped.
    const { orchestrator, store } = createOrchestrator();

    const started = await orchestrator.startPipeline(
      'user-no-hook',
      { idea: 'QR kod' },
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'qr-kod', 'private');
    const final = await waitForStage(store, started.id, ['completed_partial']);

    assert.equal(final.error?.code, 'GITHUB_TOKEN_INVALID');
    assert.equal(final.error?.recoveryAction, 'reconnect_github');
  });

  it('continues to completed_partial even when the invalidator itself throws', async () => {
    // If the DB is down during cleanup, the user-facing error code must
    // still surface. Cleanup failure is logged but never propagated up.
    const { orchestrator, store } = createOrchestrator({
      invalidator: async () => {
        throw new Error('DB connection refused');
      },
    });

    const started = await orchestrator.startPipeline(
      'user-db-down',
      { idea: 'QR kod' },
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );
    await waitForStage(store, started.id, ['awaiting_approval']);
    await orchestrator.approveSpec(started.id, 'qr-kod', 'private');
    const final = await waitForStage(store, started.id, ['completed_partial']);

    assert.equal(final.error?.code, 'GITHUB_TOKEN_INVALID');
  });
});
