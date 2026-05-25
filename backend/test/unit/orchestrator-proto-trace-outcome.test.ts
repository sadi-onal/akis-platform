/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for ProtoTraceOutcome handler — Kademe 3 refactor.
 *
 * One test per outcome variant. Each test verifies:
 *   1. The correct store.update call (stage, error, intermediateState)
 *   2. The correct side-effect calls (emitEvent, emitStageCompleted, etc.)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  handleProtoTraceOutcome,
  type ProtoTraceOutcome,
  type HandleProtoTraceOutcomeDeps,
} from '../../src/pipeline/core/orchestrator/outcomes/ProtoTraceOutcome.js';
import type {
  PipelineState,
  PipelineStage,
  ProtoOutput,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';
import type { CriticReviewOutput } from '../../src/pipeline/agents/critic/CriticTypes.js';
import type { AgentReasoning } from '../../src/pipeline/core/explainability/ExplainabilityTypes.js';

// ── Shared fixtures ─────────────────────────────────────────────

const PIPELINE_ID = 'pipe-test-1';

function makeProtoOutput(overrides: Partial<ProtoOutput> = {}): ProtoOutput {
  return {
    ok: true,
    branch: 'feat/test-branch',
    repo: 'owner/test-repo',
    repoUrl: 'https://github.com/owner/test-repo',
    files: [{ filePath: 'src/index.ts', content: 'console.log("hi")', linesOfCode: 1 }],
    setupCommands: [],
    summary: 'Test scaffold',
    metadata: {
      filesCreated: 1,
      totalLinesOfCode: 1,
      stackUsed: 'typescript',
      committed: false,
    },
    ...overrides,
  };
}

function makeMetrics(startedAt?: Date) {
  return {
    startedAt: startedAt ?? new Date('2026-01-01T00:00:00Z'),
    clarificationRounds: 0,
    retryCount: 0,
    protoCompletedAt: new Date(),
  };
}

function makeCriticResult(overrides: Partial<CriticReviewOutput> = {}): CriticReviewOutput {
  return {
    approved: false,
    overallScore: 40,
    findings: [
      {
        severity: 'critical',
        category: 'completeness',
        description: 'Missing error handling',
        suggestion: 'Add try-catch blocks',
      } as any,
    ],
    summary: 'Critical issues found',
    reviewType: 'code_review',
    iteration: 1,
    hasCriticalFinding: true,
    maxSeverity: 'critical',
    ...overrides,
  };
}

function makePipelineState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    id: PIPELINE_ID,
    userId: 'user-1',
    stage: 'proto_building' as PipelineStage,
    scribeConversation: [],
    traceEnabled: true,
    metrics: makeMetrics(),
    attemptCount: 0,
    stageVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Call tracker — records method name + args for assertion. */
interface Call {
  method: string;
  args: unknown[];
}

function makeDeps(pipelineState?: PipelineState | null): {
  deps: HandleProtoTraceOutcomeDeps;
  calls: Call[];
} {
  const calls: Call[] = [];
  const stored = pipelineState ?? makePipelineState();

  const deps: HandleProtoTraceOutcomeDeps = {
    store: {
      getById: async (id: string) => {
        calls.push({ method: 'store.getById', args: [id] });
        return stored;
      },
      update: async (id: string, data: Partial<PipelineState>) => {
        calls.push({ method: 'store.update', args: [id, data] });
        return { ...stored, ...data } as PipelineState;
      },
      create: async () => stored,
      listByUser: async () => [stored],
    },

    emitEvent(pipelineId, type, stage?, data?) {
      calls.push({ method: 'emitEvent', args: [pipelineId, type, stage, data] });
    },

    emitStageCompleted(pipelineId, stage, summary?) {
      calls.push({ method: 'emitStageCompleted', args: [pipelineId, stage, summary] });
    },

    async emitProtoCompletedForIteration(pipelineId, iteration, output) {
      calls.push({
        method: 'emitProtoCompletedForIteration',
        args: [pipelineId, iteration, output],
      });
    },

    persistReasoning(pipelineId, reasoning) {
      calls.push({ method: 'persistReasoning', args: [pipelineId, reasoning] });
    },

    recordProtoReasoning(pipelineId, output, scribeOutput?) {
      calls.push({ method: 'recordProtoReasoning', args: [pipelineId, output, scribeOutput] });
    },

    async persistAcCoverage(pipelineId, protoOutput, scribeOutput) {
      calls.push({ method: 'persistAcCoverage', args: [pipelineId, protoOutput, scribeOutput] });
    },

    async maybeInvalidateGitHubTokenOnAuthError(pipelineId, errorCode) {
      calls.push({
        method: 'maybeInvalidateGitHubTokenOnAuthError',
        args: [pipelineId, errorCode],
      });
    },

    emitActivity(activity) {
      calls.push({ method: 'emitActivity', args: [activity] });
    },

    async dispatchCriticIterate(pipelineId, feedback) {
      calls.push({ method: 'dispatchCriticIterate', args: [pipelineId, feedback] });
    },

    async runJiraProtoComment(userId, epicKey, result) {
      calls.push({ method: 'runJiraProtoComment', args: [userId, epicKey, result] });
    },
  };

  return { deps, calls };
}

// ── Tests ───────────────────────────────────────────────────────

describe('handleProtoTraceOutcome', () => {
  // ── 1. cancelled ─────────────────────────────────
  describe('cancelled', () => {
    it('should return immediately with no side-effects', async () => {
      const { deps, calls } = makeDeps();
      const outcome: ProtoTraceOutcome = { type: 'cancelled' };

      await handleProtoTraceOutcome(PIPELINE_ID, outcome, deps);

      assert.equal(calls.length, 0, 'Expected zero side-effect calls');
    });
  });

  // ── 2. proto_error ───────────────────────────────
  describe('proto_error', () => {
    it('should invalidate GitHub token, update stage to failed, and emit error event', async () => {
      const { deps, calls } = makeDeps();
      const outcome: ProtoTraceOutcome = {
        type: 'proto_error',
        error: {
          code: 'GITHUB_TOKEN_INVALID',
          message: 'Token expired',
          retryable: false,
        },
        errorCode: 'GITHUB_TOKEN_INVALID',
      };

      await handleProtoTraceOutcome(PIPELINE_ID, outcome, deps);

      // 1. maybeInvalidateGitHubTokenOnAuthError called first
      const invalidateCall = calls.find(
        (c) => c.method === 'maybeInvalidateGitHubTokenOnAuthError'
      );
      assert.ok(invalidateCall, 'Expected maybeInvalidateGitHubTokenOnAuthError to be called');
      assert.deepEqual(invalidateCall.args, [PIPELINE_ID, 'GITHUB_TOKEN_INVALID']);

      // 2. store.update with stage: 'failed' + error
      const updateCall = calls.find((c) => c.method === 'store.update');
      assert.ok(updateCall, 'Expected store.update to be called');
      const updateData = updateCall.args[1] as Record<string, unknown>;
      assert.equal(updateData.stage, 'failed');
      assert.deepEqual(updateData.error, outcome.error);

      // 3. emitEvent with error type
      const emitCall = calls.find((c) => c.method === 'emitEvent');
      assert.ok(emitCall, 'Expected emitEvent to be called');
      assert.deepEqual(emitCall.args, [PIPELINE_ID, 'error', 'failed', outcome.error]);
    });
  });

  // ── 3. trace_disabled ────────────────────────────
  describe('trace_disabled', () => {
    it('should emit stage completed, update to completed, emit proto iteration, and emit stage_change', async () => {
      const { deps, calls } = makeDeps();
      const protoOutput = makeProtoOutput();
      const metrics = makeMetrics(new Date('2026-01-01T00:00:00Z'));
      const outcome: ProtoTraceOutcome = {
        type: 'trace_disabled',
        protoOutput,
        metrics,
        protoIteration: 1,
      };

      await handleProtoTraceOutcome(PIPELINE_ID, outcome, deps);

      const methodOrder = calls.map((c) => c.method);

      // emitStageCompleted first
      assert.ok(
        methodOrder.indexOf('emitStageCompleted') < methodOrder.indexOf('store.update'),
        'emitStageCompleted should precede store.update'
      );

      // store.update with stage: 'completed' and metrics with traceCompletedAt + totalDurationMs
      const updateCall = calls.find((c) => c.method === 'store.update');
      assert.ok(updateCall);
      const updateData = updateCall.args[1] as Record<string, unknown>;
      assert.equal(updateData.stage, 'completed');
      assert.equal(updateData.protoOutput, protoOutput);
      const updatedMetrics = updateData.metrics as Record<string, unknown>;
      assert.ok(updatedMetrics.traceCompletedAt instanceof Date);
      assert.equal(typeof updatedMetrics.totalDurationMs, 'number');

      // emitProtoCompletedForIteration called
      const iterCall = calls.find((c) => c.method === 'emitProtoCompletedForIteration');
      assert.ok(iterCall);
      assert.deepEqual(iterCall.args, [PIPELINE_ID, 1, protoOutput]);

      // emitEvent with stage_change, completed
      const emitCall = calls.find((c) => c.method === 'emitEvent');
      assert.ok(emitCall);
      assert.deepEqual(emitCall.args, [PIPELINE_ID, 'stage_change', 'completed', undefined]);
    });
  });

  // ── 4. validation_failed ─────────────────────────
  describe('validation_failed', () => {
    it('should update to failed with VALIDATION_FAILED error, emit iteration and error event (reasoning persisted by determination phase)', async () => {
      const { deps, calls } = makeDeps();
      const protoOutput = makeProtoOutput();
      const validationReasoning: AgentReasoning = {
        agentName: 'validator',
        timestamp: new Date(),
        decision: 'Kod doğrulama başarısız',
        reasoning: ['Skor: 30/100'],
        assumptions: ['Deterministic kontroller yeterli'],
        confidence: { score: 30, factors: ['syntax-check'] },
      };
      const outcome: ProtoTraceOutcome = {
        type: 'validation_failed',
        protoOutput,
        validationReasoning,
        validationErrorMessage: '5 error(s) found (score: 30/100)',
        protoIteration: 1,
      };

      await handleProtoTraceOutcome(PIPELINE_ID, outcome, deps);

      // persistReasoning is NOT called by the handler — the determination
      // phase in runProtoAndTrace already persists validator reasoning for
      // ALL paths (mid-flight operation). Handler only does store.update + emit.
      const reasonCall = calls.find((c) => c.method === 'persistReasoning');
      assert.equal(reasonCall, undefined, 'persistReasoning should not be called by handler');

      // store.update with stage: 'failed', VALIDATION_FAILED error
      const updateCall = calls.find((c) => c.method === 'store.update');
      assert.ok(updateCall);
      const updateData = updateCall.args[1] as Record<string, unknown>;
      assert.equal(updateData.stage, 'failed');
      const error = updateData.error as Record<string, unknown>;
      assert.equal(error.code, 'VALIDATION_FAILED');
      assert.equal(error.retryable, true);
      assert.equal(error.recoveryAction, 'retry');
      assert.ok((error.message as string).includes('5 error(s) found'));

      // emitProtoCompletedForIteration called
      assert.ok(calls.find((c) => c.method === 'emitProtoCompletedForIteration'));

      // emitEvent with error + failed (no data)
      const emitCall = calls.find((c) => c.method === 'emitEvent');
      assert.ok(emitCall);
      assert.deepEqual(emitCall.args, [PIPELINE_ID, 'error', 'failed', undefined]);
    });
  });

  // ── 5. critic_iterate ────────────────────────────
  describe('critic_iterate', () => {
    it('should record reasoning, persist AC coverage, update intermediate state, emit iteration, emit activity, and dispatch iterate', async () => {
      const { deps, calls } = makeDeps();
      const protoOutput = makeProtoOutput();
      const metrics = makeMetrics();
      const criticResult = makeCriticResult();
      const outcome: ProtoTraceOutcome = {
        type: 'critic_iterate',
        protoOutput,
        scribeOutput: undefined,
        metrics,
        protoIteration: 1,
        criticResult,
        iterateDecision: {
          nextRetry: 1,
          maxRetries: 3,
          feedback: 'Fix the critical issues',
        },
      };

      await handleProtoTraceOutcome(PIPELINE_ID, outcome, deps);

      // recordProtoReasoning called
      assert.ok(calls.find((c) => c.method === 'recordProtoReasoning'));

      // persistAcCoverage called
      assert.ok(calls.find((c) => c.method === 'persistAcCoverage'));

      // store.getById called (to read intermediateState)
      assert.ok(calls.find((c) => c.method === 'store.getById'));

      // store.update with protoOutput, metrics, and criticCodeOutput in intermediate
      const updateCalls = calls.filter((c) => c.method === 'store.update');
      assert.ok(updateCalls.length > 0);
      const mainUpdate = updateCalls[updateCalls.length - 1];
      const updateData = mainUpdate.args[1] as Record<string, unknown>;
      assert.equal(updateData.protoOutput, protoOutput);
      assert.equal(updateData.metrics, metrics);
      const intermediate = updateData.intermediateState as Record<string, unknown>;
      assert.equal(intermediate.criticCodeOutput, criticResult);

      // emitProtoCompletedForIteration called
      assert.ok(calls.find((c) => c.method === 'emitProtoCompletedForIteration'));

      // emitActivity with retry-trigger step
      const activityCall = calls.find((c) => c.method === 'emitActivity');
      assert.ok(activityCall);
      const activity = activityCall.args[0] as Record<string, unknown>;
      assert.equal(activity.stage, 'critic');
      assert.equal(activity.step, 'retry-trigger');
      assert.ok((activity.message as string).includes('1/3'));

      // dispatchCriticIterate called
      const dispatchCall = calls.find((c) => c.method === 'dispatchCriticIterate');
      assert.ok(dispatchCall);
      assert.deepEqual(dispatchCall.args, [PIPELINE_ID, 'Fix the critical issues']);
    });
  });

  // ── 6. critic_hard_block ─────────────────────────
  describe('critic_hard_block', () => {
    it('should record reasoning, persist AC coverage, update to awaiting_critic_resolution, emit proto completed, stage completed, stage_change, and gate_open activity', async () => {
      const { deps, calls } = makeDeps();
      const protoOutput = makeProtoOutput();
      const metrics = makeMetrics();
      const criticResult = makeCriticResult({ overallScore: 30 });
      const outcome: ProtoTraceOutcome = {
        type: 'critic_hard_block',
        protoOutput,
        scribeOutput: undefined,
        metrics,
        protoIteration: 1,
        criticResult,
      };

      await handleProtoTraceOutcome(PIPELINE_ID, outcome, deps);

      // recordProtoReasoning called
      assert.ok(calls.find((c) => c.method === 'recordProtoReasoning'));

      // persistAcCoverage called
      assert.ok(calls.find((c) => c.method === 'persistAcCoverage'));

      // store.update with stage: 'awaiting_critic_resolution', criticBlock
      const updateCalls = calls.filter((c) => c.method === 'store.update');
      const mainUpdate = updateCalls[updateCalls.length - 1];
      const updateData = mainUpdate.args[1] as Record<string, unknown>;
      assert.equal(updateData.stage, 'awaiting_critic_resolution');
      const intermediate = updateData.intermediateState as Record<string, unknown>;
      assert.equal(intermediate.criticCodeOutput, criticResult);
      const block = intermediate.criticBlock as Record<string, unknown>;
      assert.equal(block.overallScore, 30);
      assert.equal(block.manuallyOverridden, false);

      // emitProtoCompletedForIteration called
      assert.ok(calls.find((c) => c.method === 'emitProtoCompletedForIteration'));

      // emitStageCompleted('proto') called
      const stageCompletedCall = calls.find((c) => c.method === 'emitStageCompleted');
      assert.ok(stageCompletedCall);
      assert.equal(stageCompletedCall.args[1], 'proto');

      // emitEvent with stage_change + awaiting_critic_resolution
      const emitCall = calls.find((c) => c.method === 'emitEvent');
      assert.ok(emitCall);
      assert.deepEqual(emitCall.args, [
        PIPELINE_ID,
        'stage_change',
        'awaiting_critic_resolution',
        undefined,
      ]);

      // emitActivity with gate_open step
      const activityCall = calls.find((c) => c.method === 'emitActivity');
      assert.ok(activityCall);
      const activity = activityCall.args[0] as Record<string, unknown>;
      assert.equal(activity.stage, 'critic');
      assert.equal(activity.step, 'gate_open');
      assert.equal(activity.progress, 100);
    });
  });

  // ── 7+8. ready_for_trace ─────────────────────────
  describe('ready_for_trace', () => {
    it('should emit proto iteration, record reasoning, persist AC, emit stage completed, update to trace_testing, and emit stage_change', async () => {
      const { deps, calls } = makeDeps();
      const protoOutput = makeProtoOutput();
      const metrics = makeMetrics();
      const outcome: ProtoTraceOutcome = {
        type: 'ready_for_trace',
        protoOutput,
        scribeOutput: undefined,
        metrics,
        protoIteration: 2,
        previewGateEnabled: true,
      };

      await handleProtoTraceOutcome(PIPELINE_ID, outcome, deps);

      const methodOrder = calls.map((c) => c.method);

      // emitProtoCompletedForIteration is called
      assert.ok(methodOrder.includes('emitProtoCompletedForIteration'));

      // recordProtoReasoning called
      assert.ok(methodOrder.includes('recordProtoReasoning'));

      // persistAcCoverage called
      assert.ok(methodOrder.includes('persistAcCoverage'));

      // emitStageCompleted('proto') called
      const stageCompletedCall = calls.find((c) => c.method === 'emitStageCompleted');
      assert.ok(stageCompletedCall);
      assert.equal(stageCompletedCall.args[1], 'proto');

      // store.update with stage: 'trace_testing'
      const updateCalls = calls.filter((c) => c.method === 'store.update');
      const mainUpdate = updateCalls[updateCalls.length - 1];
      const updateData = mainUpdate.args[1] as Record<string, unknown>;
      assert.equal(updateData.stage, 'trace_testing');
      assert.equal(updateData.protoOutput, protoOutput);

      // emitEvent with stage_change + trace_testing
      const emitCall = calls.find((c) => c.method === 'emitEvent');
      assert.ok(emitCall);
      assert.deepEqual(emitCall.args, [PIPELINE_ID, 'stage_change', 'trace_testing', undefined]);

      // No runJiraProtoComment (jiraContext not provided)
      assert.ok(!calls.find((c) => c.method === 'runJiraProtoComment'));
    });

    it('should call runJiraProtoComment when jiraContext is provided', async () => {
      const { deps, calls } = makeDeps();
      const protoOutput = makeProtoOutput();
      const metrics = makeMetrics();
      const outcome: ProtoTraceOutcome = {
        type: 'ready_for_trace',
        protoOutput,
        scribeOutput: undefined,
        metrics,
        protoIteration: 1,
        previewGateEnabled: false,
        jiraContext: {
          userId: 'user-1',
          epicKey: 'PROJ-42',
        },
      };

      await handleProtoTraceOutcome(PIPELINE_ID, outcome, deps);

      // runJiraProtoComment called with correct args
      // It's fire-and-forget, so we need to wait a tick for the microtask
      await new Promise((r) => setTimeout(r, 10));
      const jiraCall = calls.find((c) => c.method === 'runJiraProtoComment');
      assert.ok(jiraCall, 'Expected runJiraProtoComment to be called');
      assert.equal(jiraCall.args[0], 'user-1');
      assert.equal(jiraCall.args[1], 'PROJ-42');
      const jiraResult = jiraCall.args[2] as Record<string, unknown>;
      assert.equal(jiraResult.branch, 'feat/test-branch');
      assert.equal(jiraResult.repo, 'owner/test-repo');
      assert.equal(jiraResult.filesCreated, 1);
    });
  });

  // ── Side-effect ordering ─────────────────────────
  describe('side-effect ordering', () => {
    it('ready_for_trace: emitProtoCompletedForIteration precedes emitStageCompleted', async () => {
      const { deps, calls } = makeDeps();
      const outcome: ProtoTraceOutcome = {
        type: 'ready_for_trace',
        protoOutput: makeProtoOutput(),
        scribeOutput: undefined,
        metrics: makeMetrics(),
        protoIteration: 1,
        previewGateEnabled: true,
      };

      await handleProtoTraceOutcome(PIPELINE_ID, outcome, deps);

      const methodOrder = calls.map((c) => c.method);
      const iterIdx = methodOrder.indexOf('emitProtoCompletedForIteration');
      const stageIdx = methodOrder.indexOf('emitStageCompleted');
      assert.ok(
        iterIdx < stageIdx,
        `emitProtoCompletedForIteration (${iterIdx}) should precede emitStageCompleted (${stageIdx})`
      );
    });

    it('critic_hard_block: emitProtoCompletedForIteration precedes emitStageCompleted', async () => {
      const { deps, calls } = makeDeps();
      const outcome: ProtoTraceOutcome = {
        type: 'critic_hard_block',
        protoOutput: makeProtoOutput(),
        scribeOutput: undefined,
        metrics: makeMetrics(),
        protoIteration: 1,
        criticResult: makeCriticResult(),
      };

      await handleProtoTraceOutcome(PIPELINE_ID, outcome, deps);

      const methodOrder = calls.map((c) => c.method);
      const iterIdx = methodOrder.indexOf('emitProtoCompletedForIteration');
      const stageIdx = methodOrder.indexOf('emitStageCompleted');
      assert.ok(
        iterIdx < stageIdx,
        `emitProtoCompletedForIteration (${iterIdx}) should precede emitStageCompleted (${stageIdx})`
      );
    });
  });
});
