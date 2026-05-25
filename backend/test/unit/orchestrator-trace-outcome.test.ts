/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for TraceOutcome handler — Kademe 3 refactor.
 *
 * One test per outcome variant. Each test verifies:
 *   1. The correct store.update call (stage, error, intermediateState)
 *   2. The correct side-effect calls (emitEvent, emitStageCompleted, etc.)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  handleTraceOutcome,
  type TraceOutcome,
  type HandleTraceOutcomeDeps,
} from '../../src/pipeline/core/orchestrator/outcomes/TraceOutcome.js';
import type {
  PipelineState,
  PipelineStage,
  ProtoOutput,
  TraceOutput,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';

// ── Shared fixtures ─────────────────────────────────────────────

const PIPELINE_ID = 'pipe-trace-1';

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

function makeTraceOutput(overrides: Partial<TraceOutput> = {}): TraceOutput {
  return {
    ok: true,
    testFiles: [{ filePath: 'test/index.test.ts', content: 'test("it works")', testCount: 1 }],
    coverageMatrix: { 'AC-1': ['test/index.test.ts'] },
    testSummary: {
      totalTests: 3,
      coveragePercentage: 85,
      coveredCriteria: ['AC-1', 'AC-2'],
      uncoveredCriteria: ['AC-3'],
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

function makePipelineState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    id: PIPELINE_ID,
    userId: 'user-1',
    stage: 'trace_testing' as PipelineStage,
    scribeConversation: [],
    traceEnabled: true,
    metrics: makeMetrics(),
    attemptCount: 0,
    stageVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    protoOutput: makeProtoOutput(),
    ...overrides,
  };
}

/** Call tracker — records method name + args for assertion. */
interface Call {
  method: string;
  args: unknown[];
}

function makeDeps(pipelineState?: PipelineState | null): {
  deps: HandleTraceOutcomeDeps;
  calls: Call[];
  storeUpdates: Array<Record<string, unknown>>;
} {
  const calls: Call[] = [];
  const storeUpdates: Array<Record<string, unknown>> = [];
  const stored = pipelineState ?? makePipelineState();

  const deps: HandleTraceOutcomeDeps = {
    store: {
      getById: async (id: string) => {
        calls.push({ method: 'store.getById', args: [id] });
        return stored;
      },
      update: async (id: string, data: Partial<PipelineState>) => {
        calls.push({ method: 'store.update', args: [id, data] });
        storeUpdates.push(data as Record<string, unknown>);
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

    emitActivity(activity) {
      calls.push({ method: 'emitActivity', args: [activity] });
    },

    async appendTraceCompleted(pipelineId, iteration, output, subSteps?) {
      calls.push({
        method: 'appendTraceCompleted',
        args: [pipelineId, iteration, output, subSteps],
      });
    },

    recordTraceReasoning(pipelineId, output) {
      calls.push({ method: 'recordTraceReasoning', args: [pipelineId, output] });
    },

    async persistAcCoverage(pipelineId, protoOutput, scribeOutput, traceOutput?) {
      calls.push({
        method: 'persistAcCoverage',
        args: [pipelineId, protoOutput, scribeOutput, traceOutput],
      });
    },

    async dispatchTraceIterate(pipelineId, feedback) {
      calls.push({ method: 'dispatchTraceIterate', args: [pipelineId, feedback] });
    },

    async runJiraTraceComment(userId, epicKey, result) {
      calls.push({ method: 'runJiraTraceComment', args: [userId, epicKey, result] });
    },

    learningService: {
      recordOutcome(pipelineId, stage, data) {
        calls.push({ method: 'learningService.recordOutcome', args: [pipelineId, stage, data] });
      },
    },

    buildSubStepsForStage(pipeline, stage) {
      calls.push({ method: 'buildSubStepsForStage', args: [pipeline, stage] });
      return [];
    },

    logActivity(pipelineId, agent, action, data) {
      calls.push({ method: 'logActivity', args: [pipelineId, agent, action, data] });
    },

    ingestPipelineResults(pipeline, traceData) {
      calls.push({ method: 'ingestPipelineResults', args: [pipeline, traceData] });
    },

    async getPipeline(id) {
      calls.push({ method: 'getPipeline', args: [id] });
      return stored;
    },
  };

  return { deps, calls, storeUpdates };
}

// ── Tests ───────────────────────────────────────────────────────

describe('handleTraceOutcome', () => {
  // ── 1. dry_run_failure ────────────────────────────
  describe('dry_run_failure', () => {
    it('should emit stage_change, stage_completed activity, and gate_open activity — no store.update', async () => {
      const { deps, calls } = makeDeps();
      const outcome: TraceOutcome = { type: 'dry_run_failure' };

      await handleTraceOutcome(PIPELINE_ID, outcome, deps);

      // No store.update — determination phase already did it
      const updateCalls = calls.filter((c) => c.method === 'store.update');
      assert.equal(updateCalls.length, 0, 'Expected zero store.update calls');

      // emitEvent with stage_change, awaiting_push_confirm
      const emitCall = calls.find((c) => c.method === 'emitEvent');
      assert.ok(emitCall, 'Expected emitEvent to be called');
      assert.deepEqual(emitCall.args, [
        PIPELINE_ID,
        'stage_change',
        'awaiting_push_confirm',
        undefined,
      ]);

      // Two emitActivity calls: stage_completed + gate_open
      const activityCalls = calls.filter((c) => c.method === 'emitActivity');
      assert.equal(activityCalls.length, 2, 'Expected two emitActivity calls');

      const stageCompletedActivity = activityCalls[0].args[0] as Record<string, unknown>;
      assert.equal(stageCompletedActivity.step, 'stage_completed');
      assert.equal(stageCompletedActivity.status, 'completed');
      assert.equal(stageCompletedActivity.stage, 'trace');

      const gateOpenActivity = activityCalls[1].args[0] as Record<string, unknown>;
      assert.equal(gateOpenActivity.step, 'gate_open');
      assert.equal(gateOpenActivity.stage, 'trace');
      assert.equal(gateOpenActivity.progress, 100);
    });
  });

  // ── 2. fix_loop_success ───────────────────────────
  describe('fix_loop_success', () => {
    it('should update stage to completed, emit completed event, and record learning', async () => {
      const { deps, calls, storeUpdates } = makeDeps();
      const protoOutput = makeProtoOutput();
      const traceOutput = makeTraceOutput();
      const metrics = makeMetrics(new Date('2026-01-01T00:00:00Z'));
      const outcome: TraceOutcome = {
        type: 'fix_loop_success',
        protoOutput,
        traceOutput,
        metrics,
      };

      await handleTraceOutcome(PIPELINE_ID, outcome, deps);

      // store.update with stage: 'completed'
      assert.equal(storeUpdates.length, 1);
      const updateData = storeUpdates[0];
      assert.equal(updateData.stage, 'completed');
      assert.equal(updateData.protoOutput, protoOutput);
      assert.equal(updateData.traceOutput, traceOutput);
      const updatedMetrics = updateData.metrics as Record<string, unknown>;
      assert.ok(updatedMetrics.traceCompletedAt instanceof Date);
      assert.equal(typeof updatedMetrics.totalDurationMs, 'number');

      // emitEvent with completed
      const emitCall = calls.find((c) => c.method === 'emitEvent');
      assert.ok(emitCall);
      assert.deepEqual(emitCall.args, [PIPELINE_ID, 'completed', 'completed', undefined]);

      // learningService.recordOutcome with fix_loop
      const learnCall = calls.find((c) => c.method === 'learningService.recordOutcome');
      assert.ok(learnCall);
      assert.equal(learnCall.args[1], 'fix_loop');
      const learnData = learnCall.args[2] as Record<string, unknown>;
      assert.equal(learnData.success, true);
    });
  });

  // ── 3. trace_error ────────────────────────────────
  describe('trace_error', () => {
    it('should update stage to completed_partial, emit completed event, and record learning', async () => {
      const { deps, calls, storeUpdates } = makeDeps();
      const metrics = makeMetrics(new Date('2026-01-01T00:00:00Z'));
      const error = {
        code: 'TRACE_EXECUTION_FAILED',
        message: 'Trace failed',
        retryable: true,
      };
      const outcome: TraceOutcome = {
        type: 'trace_error',
        error,
        metrics,
      };

      await handleTraceOutcome(PIPELINE_ID, outcome, deps);

      // store.update with stage: 'completed_partial'
      assert.equal(storeUpdates.length, 1);
      const updateData = storeUpdates[0];
      assert.equal(updateData.stage, 'completed_partial');
      assert.deepEqual(updateData.error, error);

      // emitEvent with completed, completed_partial
      const emitCall = calls.find((c) => c.method === 'emitEvent');
      assert.ok(emitCall);
      assert.deepEqual(emitCall.args, [PIPELINE_ID, 'completed', 'completed_partial', undefined]);

      // learningService.recordOutcome with trace + success: false
      const learnCall = calls.find((c) => c.method === 'learningService.recordOutcome');
      assert.ok(learnCall);
      assert.equal(learnCall.args[1], 'trace');
      const learnData = learnCall.args[2] as Record<string, unknown>;
      assert.equal(learnData.success, false);
      assert.equal(learnData.errorType, 'TRACE_EXECUTION_FAILED');
    });
  });

  // ── 4. iterate_retry ──────────────────────────────
  describe('iterate_retry', () => {
    it('should emit retry-trigger activity, record reasoning, persist AC coverage, and dispatch iterate', async () => {
      const { deps, calls } = makeDeps();
      const traceOutput = makeTraceOutput();
      const pipelineAfterTrace = makePipelineState({
        protoOutput: makeProtoOutput(),
        scribeOutput: { rawMarkdown: 'spec', spec: {} } as any,
      });
      const outcome: TraceOutcome = {
        type: 'iterate_retry',
        traceOutput,
        iterateDecision: {
          nextRetry: 2,
          maxRetries: 3,
          uncoveredCount: 1,
          totalCount: 3,
          feedback: 'Cover AC-3',
        },
        pipelineAfterTrace,
      };

      await handleTraceOutcome(PIPELINE_ID, outcome, deps);

      // emitActivity with retry-trigger
      const activityCall = calls.find((c) => c.method === 'emitActivity');
      assert.ok(activityCall);
      const activity = activityCall.args[0] as Record<string, unknown>;
      assert.equal(activity.stage, 'trace');
      assert.equal(activity.step, 'retry-trigger');
      assert.ok((activity.message as string).includes('1/3'));
      assert.ok((activity.message as string).includes('2/3'));

      // recordTraceReasoning called
      const reasonCall = calls.find((c) => c.method === 'recordTraceReasoning');
      assert.ok(reasonCall);
      assert.deepEqual(reasonCall.args, [PIPELINE_ID, traceOutput]);

      // persistAcCoverage called with protoOutput from pipelineAfterTrace
      const acCall = calls.find((c) => c.method === 'persistAcCoverage');
      assert.ok(acCall);
      assert.equal(acCall.args[0], PIPELINE_ID);
      assert.equal(acCall.args[1], pipelineAfterTrace.protoOutput);
      assert.equal(acCall.args[3], traceOutput);

      // dispatchTraceIterate called with feedback
      // Fire-and-forget, wait a tick
      await new Promise((r) => setTimeout(r, 10));
      const dispatchCall = calls.find((c) => c.method === 'dispatchTraceIterate');
      assert.ok(dispatchCall);
      assert.deepEqual(dispatchCall.args, [PIPELINE_ID, 'Cover AC-3']);

      // No store.update — iterate_retry doesn't mutate the store
      const updateCalls = calls.filter((c) => c.method === 'store.update');
      assert.equal(updateCalls.length, 0, 'Expected zero store.update calls');
    });

    it('should skip persistAcCoverage when pipelineAfterTrace has no protoOutput', async () => {
      const { deps, calls } = makeDeps();
      const traceOutput = makeTraceOutput();
      const pipelineAfterTrace = makePipelineState({ protoOutput: undefined as any });
      const outcome: TraceOutcome = {
        type: 'iterate_retry',
        traceOutput,
        iterateDecision: {
          nextRetry: 1,
          maxRetries: 3,
          uncoveredCount: 2,
          totalCount: 5,
          feedback: 'Cover remaining',
        },
        pipelineAfterTrace,
      };

      await handleTraceOutcome(PIPELINE_ID, outcome, deps);

      const acCall = calls.find((c) => c.method === 'persistAcCoverage');
      assert.equal(acCall, undefined, 'Expected persistAcCoverage to NOT be called');
    });
  });

  // ── 5. success (completed) ────────────────────────
  describe('success — completed', () => {
    it('should emit stage completed, update to completed, append trace event, emit completed, log activity, record reasoning, persist AC, record learning, emit pipeline_complete, and ingest knowledge', async () => {
      const { deps, calls, storeUpdates } = makeDeps();
      const traceOutput = makeTraceOutput();
      const metrics = makeMetrics(new Date('2026-01-01T00:00:00Z'));
      const outcome: TraceOutcome = {
        type: 'success',
        traceOutput,
        metrics,
        postSuccessStage: 'completed',
        traceDryRun: false,
        traceIteration: 1,
      };

      await handleTraceOutcome(PIPELINE_ID, outcome, deps);

      const methodOrder = calls.map((c) => c.method);

      // emitStageCompleted first
      assert.ok(methodOrder.includes('emitStageCompleted'));
      const stageCompCall = calls.find((c) => c.method === 'emitStageCompleted');
      assert.ok(stageCompCall);
      assert.equal(stageCompCall.args[1], 'trace');

      // store.update with stage: 'completed'
      assert.ok(storeUpdates.length > 0);
      const updateData = storeUpdates[0];
      assert.equal(updateData.stage, 'completed');
      assert.equal(updateData.traceOutput, traceOutput);
      // No intermediateState for non-dryRun
      assert.equal(updateData.intermediateState, undefined);

      // appendTraceCompleted called
      assert.ok(methodOrder.includes('appendTraceCompleted'));

      // emitEvent with 'completed', 'completed' (NOT stage_change)
      const emitCall = calls.find((c) => c.method === 'emitEvent');
      assert.ok(emitCall);
      assert.deepEqual(emitCall.args, [PIPELINE_ID, 'completed', 'completed', undefined]);

      // logActivity with trace, tests_generated
      const logCall = calls.find((c) => c.method === 'logActivity');
      assert.ok(logCall);
      assert.equal(logCall.args[1], 'trace');
      assert.equal(logCall.args[2], 'tests_generated');

      // recordTraceReasoning called
      assert.ok(methodOrder.includes('recordTraceReasoning'));

      // persistAcCoverage called
      assert.ok(methodOrder.includes('persistAcCoverage'));

      // learningService.recordOutcome for trace, success: true
      const learnCall = calls.find((c) => c.method === 'learningService.recordOutcome');
      assert.ok(learnCall);
      assert.equal(learnCall.args[1], 'trace');
      const learnData = learnCall.args[2] as Record<string, unknown>;
      assert.equal(learnData.success, true);
      assert.equal(learnData.score, 85);

      // pipeline_complete activity emitted (completed stage only)
      const activityCalls = calls.filter((c) => c.method === 'emitActivity');
      const pipelineCompleteActivity = activityCalls.find(
        (c) => (c.args[0] as Record<string, unknown>).step === 'pipeline_complete'
      );
      assert.ok(pipelineCompleteActivity, 'Expected pipeline_complete activity');

      // ingestPipelineResults called
      assert.ok(methodOrder.includes('ingestPipelineResults'));
    });

    it('should include jiraTraceComment when pipeline has jiraConfig.epicKey', async () => {
      const pipelineWithJira = makePipelineState({
        jiraConfig: { projectKey: 'PROJ', enabled: true, epicKey: 'PROJ-42' },
      } as any);
      const { deps, calls } = makeDeps(pipelineWithJira);
      const traceOutput = makeTraceOutput();
      const metrics = makeMetrics(new Date('2026-01-01T00:00:00Z'));
      const outcome: TraceOutcome = {
        type: 'success',
        traceOutput,
        metrics,
        postSuccessStage: 'completed',
        traceDryRun: false,
        traceIteration: 1,
      };

      await handleTraceOutcome(PIPELINE_ID, outcome, deps);

      // runJiraTraceComment is fire-and-forget, wait a tick
      await new Promise((r) => setTimeout(r, 10));
      const jiraCall = calls.find((c) => c.method === 'runJiraTraceComment');
      assert.ok(jiraCall, 'Expected runJiraTraceComment to be called');
      assert.equal(jiraCall.args[0], 'user-1');
      assert.equal(jiraCall.args[1], 'PROJ-42');
      const jiraResult = jiraCall.args[2] as Record<string, unknown>;
      assert.equal(jiraResult.totalTests, 3);
      assert.equal(jiraResult.coveragePercentage, 85);
      assert.equal(jiraResult.passed, true);
    });
  });

  // ── 5b. success (awaiting_push_confirm) ───────────
  describe('success — awaiting_push_confirm', () => {
    it('should emit stage_change + gate_open activity instead of completed event, and NOT emit pipeline_complete or ingest', async () => {
      const { deps, calls, storeUpdates } = makeDeps();
      const traceOutput = makeTraceOutput();
      const metrics = makeMetrics(new Date('2026-01-01T00:00:00Z'));
      const outcome: TraceOutcome = {
        type: 'success',
        traceOutput,
        metrics,
        postSuccessStage: 'awaiting_push_confirm',
        traceDryRun: true,
        intermediateForFlag: { existingKey: 'value' },
        traceIteration: 1,
      };

      await handleTraceOutcome(PIPELINE_ID, outcome, deps);

      // store.update with stage: 'awaiting_push_confirm' and intermediateState
      assert.ok(storeUpdates.length > 0);
      const updateData = storeUpdates[0];
      assert.equal(updateData.stage, 'awaiting_push_confirm');
      const intermediate = updateData.intermediateState as Record<string, unknown>;
      assert.equal(intermediate.traceDryRunStatus, 'success');
      assert.ok(intermediate.traceDryRunCompletedAt);
      assert.equal(intermediate.existingKey, 'value');

      // emitEvent with stage_change, awaiting_push_confirm (NOT completed)
      const emitCall = calls.find((c) => c.method === 'emitEvent');
      assert.ok(emitCall);
      assert.deepEqual(emitCall.args, [
        PIPELINE_ID,
        'stage_change',
        'awaiting_push_confirm',
        undefined,
      ]);

      // gate_open activity emitted
      const activityCalls = calls.filter((c) => c.method === 'emitActivity');
      const gateOpenActivity = activityCalls.find(
        (c) => (c.args[0] as Record<string, unknown>).step === 'gate_open'
      );
      assert.ok(gateOpenActivity, 'Expected gate_open activity');

      // No pipeline_complete activity
      const pipelineCompleteActivity = activityCalls.find(
        (c) => (c.args[0] as Record<string, unknown>).step === 'pipeline_complete'
      );
      assert.equal(
        pipelineCompleteActivity,
        undefined,
        'Expected NO pipeline_complete activity for awaiting_push_confirm'
      );

      // No ingestPipelineResults
      const ingestCall = calls.find((c) => c.method === 'ingestPipelineResults');
      assert.equal(ingestCall, undefined, 'Expected NO ingestPipelineResults');
    });
  });

  // ── Side-effect ordering ──────────────────────────
  describe('side-effect ordering', () => {
    it('success: emitStageCompleted precedes store.update', async () => {
      const { deps, calls } = makeDeps();
      const outcome: TraceOutcome = {
        type: 'success',
        traceOutput: makeTraceOutput(),
        metrics: makeMetrics(),
        postSuccessStage: 'completed',
        traceDryRun: false,
        traceIteration: 1,
      };

      await handleTraceOutcome(PIPELINE_ID, outcome, deps);

      const methodOrder = calls.map((c) => c.method);
      const stageIdx = methodOrder.indexOf('emitStageCompleted');
      const updateIdx = methodOrder.indexOf('store.update');
      assert.ok(
        stageIdx < updateIdx,
        `emitStageCompleted (${stageIdx}) should precede store.update (${updateIdx})`
      );
    });

    it('success: appendTraceCompleted comes after store.update', async () => {
      const { deps, calls } = makeDeps();
      const outcome: TraceOutcome = {
        type: 'success',
        traceOutput: makeTraceOutput(),
        metrics: makeMetrics(),
        postSuccessStage: 'completed',
        traceDryRun: false,
        traceIteration: 1,
      };

      await handleTraceOutcome(PIPELINE_ID, outcome, deps);

      const methodOrder = calls.map((c) => c.method);
      const updateIdx = methodOrder.indexOf('store.update');
      const appendIdx = methodOrder.indexOf('appendTraceCompleted');
      assert.ok(
        updateIdx < appendIdx,
        `store.update (${updateIdx}) should precede appendTraceCompleted (${appendIdx})`
      );
    });
  });
});
