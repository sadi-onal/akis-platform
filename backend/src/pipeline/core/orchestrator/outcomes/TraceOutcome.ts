/**
 * TraceOutcome — discriminated union for `runTrace` return paths.
 *
 * Kademe 3 refactor — models every possible outcome of a Trace execution as
 * a tagged variant. The handler function (`handleTraceOutcome`) converts
 * each variant into the exact sequence of side-effects the orchestrator used
 * to perform inline. Exhaustiveness is enforced at compile time via `default:
 * never`.
 *
 * Why: runTrace had 5 return paths, each manually calling a different
 * combination of emit/activity/store side-effect functions. This module makes
 * side-effects declarative and testable in isolation.
 */
import type {
  PipelineError,
  PipelineMetrics,
  PipelineStage,
  PipelineState,
  ProtoOutput,
  ScribeOutput,
  SubStep,
  TraceOutput,
} from '../../contracts/PipelineTypes.js';
import type { PipelineStore } from '../PipelineOrchestrator.js';

// ── Discriminated union ──────────────────────────────────────────

/**
 * Trace dryRun failed but we hand off to push-gate anyway.
 * Store already updated in the determination phase — the handler only emits
 * SSE activities so the frontend picks up the transition.
 */
export interface OutcomeDryRunFailure {
  readonly type: 'dry_run_failure';
}

/** FixLoop succeeded — Trace errors were auto-fixed. */
export interface OutcomeFixLoopSuccess {
  readonly type: 'fix_loop_success';
  readonly protoOutput: ProtoOutput;
  readonly traceOutput: TraceOutput;
  readonly metrics: PipelineMetrics;
}

/** Trace error (no FixLoop or FixLoop failed) — graceful degradation. */
export interface OutcomeTraceError {
  readonly type: 'trace_error';
  readonly error: PipelineError;
  readonly metrics: PipelineMetrics;
}

/** Trace iterate-loop triggers a Proto re-run. */
export interface OutcomeIterateRetry {
  readonly type: 'iterate_retry';
  readonly traceOutput: TraceOutput;
  readonly iterateDecision: {
    readonly nextRetry: number;
    readonly maxRetries: number;
    readonly uncoveredCount: number;
    readonly totalCount: number;
    readonly feedback: string;
  };
  /** Pipeline state snapshot after trace for reading protoOutput/scribeOutput. */
  readonly pipelineAfterTrace: PipelineState;
}

/** Trace succeeded — terminal outcome. */
export interface OutcomeTraceSuccess {
  readonly type: 'success';
  readonly traceOutput: TraceOutput;
  readonly metrics: PipelineMetrics;
  readonly postSuccessStage: 'completed' | 'awaiting_push_confirm';
  readonly traceDryRun: boolean;
  /** Intermediate state additions for the dryRun flag path. */
  readonly intermediateForFlag?: Record<string, unknown>;
  /** Trace iteration number for chat event log. */
  readonly traceIteration: number;
}

export type TraceOutcome =
  | OutcomeDryRunFailure
  | OutcomeFixLoopSuccess
  | OutcomeTraceError
  | OutcomeIterateRetry
  | OutcomeTraceSuccess;

// ── Deps interface (DI pattern) ─────────────────────────────────

export interface HandleTraceOutcomeDeps {
  store: PipelineStore;

  emitEvent(
    pipelineId: string,
    type: 'stage_change' | 'scribe_message' | 'error' | 'completed',
    stage?: PipelineStage,
    data?: unknown
  ): void;

  emitStageCompleted(
    pipelineId: string,
    stage: 'scribe' | 'proto' | 'trace',
    summary?: string
  ): void;

  emitActivity(activity: {
    pipelineId: string;
    stage: 'scribe' | 'proto' | 'trace' | 'critic' | 'fix-loop';
    step: string;
    message: string;
    progress: number;
    timestamp: string;
    status?: 'completed';
  }): void;

  appendTraceCompleted(
    pipelineId: string,
    iteration: number,
    output: {
      testSummary: { totalTests: number; coveragePercentage: number };
      summary?: string;
    },
    subSteps?: SubStep[]
  ): Promise<void>;

  recordTraceReasoning(pipelineId: string, output: TraceOutput): void;

  persistAcCoverage(
    pipelineId: string,
    protoOutput: ProtoOutput,
    scribeOutput: ScribeOutput | undefined,
    traceOutput?: TraceOutput
  ): Promise<void>;

  dispatchTraceIterate(pipelineId: string, feedback: string): Promise<void>;

  runJiraTraceComment(
    userId: string,
    epicKey: string,
    result: { totalTests: number; coveragePercentage: number; passed: boolean }
  ): Promise<void>;

  learningService: {
    recordOutcome(pipelineId: string, stage: string, data: Record<string, unknown>): void;
  };

  buildSubStepsForStage(
    pipeline: PipelineState,
    stage: 'scribe' | 'proto' | 'trace'
  ): SubStep[];

  logActivity(
    pipelineId: string,
    agent: 'scribe' | 'proto' | 'trace',
    action: string,
    data: Record<string, unknown>
  ): void;

  ingestPipelineResults(pipeline: PipelineState, traceData: TraceOutput): void;

  getPipeline(id: string): Promise<PipelineState>;
}

// ── Helper ──────────────────────────────────────────────────────

function toEpoch(d: Date | number): number {
  return d instanceof Date ? d.getTime() : d;
}

// ── Handler function ────────────────────────────────────────────

/**
 * Execute all side-effects for a given `TraceOutcome`. The caller
 * (runTrace) constructs the outcome variant, then passes it here.
 *
 * Exhaustive `switch` with `default: never` — adding a new variant to the
 * union without handling it here is a compile-time error.
 */
export async function handleTraceOutcome(
  pipelineId: string,
  outcome: TraceOutcome,
  deps: HandleTraceOutcomeDeps
): Promise<void> {
  switch (outcome.type) {
    // ── 1. DryRun failure ──────────────────────────
    case 'dry_run_failure': {
      // Store already updated in determination phase.
      // Handler only emits SSE activities for the frontend.
      deps.emitEvent(pipelineId, 'stage_change', 'awaiting_push_confirm');
      deps.emitActivity({
        pipelineId,
        stage: 'trace',
        step: 'stage_completed',
        status: 'completed',
        message: 'Test üretilemedi (devam ediliyor)',
        progress: 100,
        timestamp: new Date().toISOString(),
      });
      deps.emitActivity({
        pipelineId,
        stage: 'trace',
        step: 'gate_open',
        message:
          'Gönderim onayı bekleniyor — Trace üretimi başarısız oldu, yine de göndermek için onay verin',
        progress: 100,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // ── 2. FixLoop success ─────────────────────────
    case 'fix_loop_success': {
      await deps.store.update(pipelineId, {
        stage: 'completed',
        protoOutput: outcome.protoOutput,
        traceOutput: outcome.traceOutput,
        metrics: {
          ...outcome.metrics,
          protoCompletedAt: outcome.metrics.protoCompletedAt ?? new Date(),
          traceCompletedAt: new Date(),
          totalDurationMs: Date.now() - toEpoch(outcome.metrics.startedAt),
        },
      });
      deps.emitEvent(pipelineId, 'completed', 'completed');
      deps.learningService.recordOutcome(pipelineId, 'fix_loop', {
        success: true,
        duration: Date.now() - toEpoch(outcome.metrics.startedAt),
        score: 0, // FixLoop doesn't carry iteration count in the outcome
      });
      return;
    }

    // ── 3. Trace error / FixLoop failure ───────────
    case 'trace_error': {
      await deps.store.update(pipelineId, {
        stage: 'completed_partial',
        error: outcome.error,
        metrics: {
          ...outcome.metrics,
          protoCompletedAt: outcome.metrics.protoCompletedAt ?? new Date(),
          totalDurationMs: Date.now() - toEpoch(outcome.metrics.startedAt),
        },
      });
      deps.emitEvent(pipelineId, 'completed', 'completed_partial');
      deps.learningService.recordOutcome(pipelineId, 'trace', {
        success: false,
        errorType: outcome.error.code,
        duration: Date.now() - toEpoch(outcome.metrics.startedAt),
      });
      return;
    }

    // ── 4. Iterate retry ───────────────────────────
    case 'iterate_retry': {
      deps.emitActivity({
        pipelineId,
        stage: 'trace',
        step: 'retry-trigger',
        message: `Test eksik kaldı (${outcome.iterateDecision.uncoveredCount}/${outcome.iterateDecision.totalCount} kabul kriteri) — Proto yeniden çalışıyor (${outcome.iterateDecision.nextRetry}/${outcome.iterateDecision.maxRetries})`,
        progress: 80,
        timestamp: new Date().toISOString(),
      });
      deps.recordTraceReasoning(pipelineId, outcome.traceOutput);
      if (outcome.pipelineAfterTrace.protoOutput) {
        await deps.persistAcCoverage(
          pipelineId,
          outcome.pipelineAfterTrace.protoOutput,
          outcome.pipelineAfterTrace.scribeOutput,
          outcome.traceOutput
        );
      }
      void deps.dispatchTraceIterate(pipelineId, outcome.iterateDecision.feedback).catch(() => {});
      return;
    }

    // ── 5. Success ─────────────────────────────────
    case 'success': {
      deps.emitStageCompleted(pipelineId, 'trace');
      await deps.store.update(pipelineId, {
        stage: outcome.postSuccessStage,
        traceOutput: outcome.traceOutput,
        metrics: {
          ...outcome.metrics,
          protoCompletedAt: outcome.metrics.protoCompletedAt ?? new Date(),
          traceCompletedAt: new Date(),
          totalDurationMs:
            outcome.postSuccessStage === 'completed'
              ? Date.now() - toEpoch(outcome.metrics.startedAt)
              : outcome.metrics.totalDurationMs,
        },
        ...(outcome.traceDryRun
          ? {
              intermediateState: {
                ...(outcome.intermediateForFlag ?? {}),
                traceDryRunStatus: 'success' as const,
                traceDryRunCompletedAt: new Date().toISOString(),
              },
            }
          : {}),
      });

      // Chat event-log: build trace sub-steps then append completed event
      const tracePipelineForSubSteps = await deps.getPipeline(pipelineId);
      const traceSubSteps = deps.buildSubStepsForStage(
        { ...tracePipelineForSubSteps, traceOutput: outcome.traceOutput } as PipelineState,
        'trace'
      );
      await deps.appendTraceCompleted(
        pipelineId,
        outcome.traceIteration,
        outcome.traceOutput,
        traceSubSteps.length > 0 ? traceSubSteps : undefined
      );

      if (outcome.postSuccessStage === 'awaiting_push_confirm') {
        deps.emitEvent(pipelineId, 'stage_change', 'awaiting_push_confirm');
        deps.emitActivity({
          pipelineId,
          stage: 'trace',
          step: 'gate_open',
          message: 'Gönderim onayı bekleniyor — inceleyin ve onaylayın',
          progress: 100,
          timestamp: new Date().toISOString(),
        });
      } else {
        deps.emitEvent(pipelineId, 'completed', 'completed');
      }

      // Log Trace activity for integrity metrics
      const ts = outcome.traceOutput.testSummary;
      deps.logActivity(pipelineId, 'trace', 'tests_generated', {
        testsPassed: ts?.totalTests ?? 0,
        specCompliance: ts?.coveragePercentage ? ts.coveragePercentage / 100 : 0,
        confidence: ts?.coveragePercentage ? ts.coveragePercentage / 100 : 0,
      });

      // Level 4: Explainability — record Trace reasoning
      deps.recordTraceReasoning(pipelineId, outcome.traceOutput);

      // Recompute AC coverage with test data
      {
        const pipelineAfterTrace = await deps.store.getById(pipelineId);
        if (pipelineAfterTrace?.protoOutput) {
          await deps.persistAcCoverage(
            pipelineId,
            pipelineAfterTrace.protoOutput,
            pipelineAfterTrace.scribeOutput,
            outcome.traceOutput
          );
        }
      }

      // Record learning
      deps.learningService.recordOutcome(pipelineId, 'trace', {
        success: true,
        duration: Date.now() - toEpoch(outcome.metrics.startedAt),
        score: ts?.coveragePercentage ?? 0,
      });

      // Jira hook: comment Trace result (non-blocking)
      const pipelineForJira = await deps.store.getById(pipelineId);
      if (pipelineForJira?.jiraConfig?.epicKey) {
        deps
          .runJiraTraceComment(pipelineForJira.userId, pipelineForJira.jiraConfig.epicKey, {
            totalTests: outcome.traceOutput.testSummary.totalTests,
            coveragePercentage: outcome.traceOutput.testSummary.coveragePercentage,
            passed: outcome.traceOutput.ok,
          })
          .catch(() => {});
      }

      // Pipeline completion signal + knowledge ingestion (only for terminal 'completed')
      if (outcome.postSuccessStage === 'completed') {
        deps.emitActivity({
          pipelineId,
          stage: 'trace',
          step: 'pipeline_complete',
          message: 'Akış başarıyla tamamlandı',
          progress: 100,
          timestamp: new Date().toISOString(),
        });

        const completedPipeline = await deps.store.getById(pipelineId);
        if (completedPipeline) {
          deps.ingestPipelineResults(completedPipeline, outcome.traceOutput);
        }
      }
      return;
    }

    default: {
      // Exhaustiveness guard — compile-time error if a variant is unhandled
      const _exhaustive: never = outcome;
      throw new Error(
        `Unhandled TraceOutcome type: ${(_exhaustive as { type: string }).type}`
      );
    }
  }
}
