/**
 * ProtoTraceOutcome — discriminated union for `runProtoAndTrace` return paths.
 *
 * Kademe 3 refactor — models every possible outcome of a Proto execution as
 * a tagged variant. The handler function (`handleProtoTraceOutcome`) converts
 * each variant into the exact sequence of side-effects the orchestrator used
 * to perform inline. Exhaustiveness is enforced at compile time via `default:
 * never`.
 *
 * Why: runProtoAndTrace had 8 return paths, each manually calling a different
 * combination of emit/activity/reasoning side-effect functions. A missed emit
 * caused the cinema bug (PR #623). This module makes side-effects declarative.
 */
import type {
  PipelineError,
  PipelineMetrics,
  PipelineStage,
  ProtoOutput,
  ScribeOutput,
} from '../../contracts/PipelineTypes.js';
import type { AgentReasoning } from '../../explainability/ExplainabilityTypes.js';
import type { CriticReviewOutput } from '../../../agents/critic/CriticTypes.js';
import type { PipelineStore } from '../PipelineOrchestrator.js';

// ── Discriminated union ──────────────────────────────────────────

/** Pipeline was cancelled during Proto execution — no side-effects. */
export interface OutcomeCancelled {
  readonly type: 'cancelled';
}

/** Proto agent returned an error result. */
export interface OutcomeProtoError {
  readonly type: 'proto_error';
  readonly error: PipelineError;
  readonly errorCode: string;
}

/** Trace is disabled — pipeline jumps straight to `completed`. */
export interface OutcomeTraceDisabled {
  readonly type: 'trace_disabled';
  readonly protoOutput: ProtoOutput;
  readonly metrics: PipelineMetrics;
  readonly protoIteration: number;
}

/** Deterministic validator found errors — fail early. */
export interface OutcomeValidationFailed {
  readonly type: 'validation_failed';
  readonly protoOutput: ProtoOutput;
  readonly validationReasoning: AgentReasoning;
  readonly validationErrorMessage: string;
  readonly protoIteration: number;
}

/** Critic found critical findings and auto-iterate loop should retry. */
export interface OutcomeCriticIterate {
  readonly type: 'critic_iterate';
  readonly protoOutput: ProtoOutput;
  readonly scribeOutput: ScribeOutput | undefined;
  readonly metrics: PipelineMetrics;
  readonly protoIteration: number;
  readonly criticResult: CriticReviewOutput;
  readonly iterateDecision: {
    readonly nextRetry: number;
    readonly maxRetries: number;
    readonly feedback: string;
  };
}

/** Critic hard-block: max iterate retries exhausted, awaiting user. */
export interface OutcomeCriticHardBlock {
  readonly type: 'critic_hard_block';
  readonly protoOutput: ProtoOutput;
  readonly scribeOutput: ScribeOutput | undefined;
  readonly metrics: PipelineMetrics;
  readonly protoIteration: number;
  readonly criticResult: CriticReviewOutput;
}

/**
 * Proto succeeded + ready for Trace. Both the preview-gate path and the
 * legacy auto-push path share the same side-effects; they differ only in
 * what happens AFTER the handler (Trace dryRun vs normal), which the
 * orchestrator handles via the `previewGateEnabled` flag.
 */
export interface OutcomeReadyForTrace {
  readonly type: 'ready_for_trace';
  readonly protoOutput: ProtoOutput;
  readonly scribeOutput: ScribeOutput | undefined;
  readonly metrics: PipelineMetrics;
  readonly protoIteration: number;
  readonly previewGateEnabled: boolean;
  readonly jiraContext?: {
    readonly userId: string;
    readonly epicKey: string;
  };
}

export type ProtoTraceOutcome =
  | OutcomeCancelled
  | OutcomeProtoError
  | OutcomeTraceDisabled
  | OutcomeValidationFailed
  | OutcomeCriticIterate
  | OutcomeCriticHardBlock
  | OutcomeReadyForTrace;

// ── Deps interface (DI pattern) ─────────────────────────────────

export interface HandleProtoTraceOutcomeDeps {
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

  emitProtoCompletedForIteration(
    pipelineId: string,
    iteration: number,
    output: ProtoOutput
  ): Promise<void>;

  persistReasoning(pipelineId: string, reasoning: AgentReasoning): void;

  recordProtoReasoning(pipelineId: string, output: ProtoOutput, scribeOutput?: ScribeOutput): void;

  persistAcCoverage(
    pipelineId: string,
    protoOutput: ProtoOutput,
    scribeOutput: ScribeOutput | undefined
  ): Promise<void>;

  maybeInvalidateGitHubTokenOnAuthError(pipelineId: string, errorCode: string): Promise<void>;

  emitActivity(activity: {
    pipelineId: string;
    stage: 'scribe' | 'proto' | 'trace' | 'critic' | 'fix-loop';
    step: string;
    message: string;
    progress: number;
    timestamp: string;
  }): void;

  dispatchCriticIterate(pipelineId: string, feedback: string): Promise<void>;

  runJiraProtoComment(
    userId: string,
    epicKey: string,
    result: { branch: string; repo: string; prUrl?: string; filesCreated: number }
  ): Promise<void>;
}

// ── Handler function ────────────────────────────────────────────

/**
 * Execute all side-effects for a given `ProtoTraceOutcome`. The caller
 * (runProtoAndTrace) constructs the outcome variant, then passes it here.
 *
 * Exhaustive `switch` with `default: never` — adding a new variant to the
 * union without handling it here is a compile-time error.
 */
export async function handleProtoTraceOutcome(
  pipelineId: string,
  outcome: ProtoTraceOutcome,
  deps: HandleProtoTraceOutcomeDeps
): Promise<void> {
  switch (outcome.type) {
    // ── 1. Cancelled ─────────────────────────────
    case 'cancelled':
      return;

    // ── 2. Proto error ───────────────────────────
    case 'proto_error': {
      await deps.maybeInvalidateGitHubTokenOnAuthError(pipelineId, outcome.errorCode);
      await deps.store.update(pipelineId, {
        stage: 'failed',
        error: outcome.error,
      });
      deps.emitEvent(pipelineId, 'error', 'failed', outcome.error);
      return;
    }

    // ── 3. Trace disabled ────────────────────────
    case 'trace_disabled': {
      deps.emitStageCompleted(pipelineId, 'proto');
      await deps.store.update(pipelineId, {
        protoOutput: outcome.protoOutput,
        stage: 'completed',
        metrics: {
          ...outcome.metrics,
          traceCompletedAt: new Date(),
          totalDurationMs: Date.now() - outcome.metrics.startedAt.getTime(),
        },
      });
      await deps.emitProtoCompletedForIteration(
        pipelineId,
        outcome.protoIteration,
        outcome.protoOutput
      );
      deps.emitEvent(pipelineId, 'stage_change', 'completed');
      return;
    }

    // ── 4. Validation failed ─────────────────────
    case 'validation_failed': {
      // NOTE: persistReasoning for the validator is already called in the
      // determination phase (mid-flight operation for ALL paths). The handler
      // only needs to persist the store.update + emit the error event.
      await deps.store.update(pipelineId, {
        stage: 'failed',
        protoOutput: outcome.protoOutput,
        error: {
          code: 'VALIDATION_FAILED',
          message: `Deterministic validation failed: ${outcome.validationErrorMessage}`,
          retryable: true,
          recoveryAction: 'retry',
        },
      });
      await deps.emitProtoCompletedForIteration(
        pipelineId,
        outcome.protoIteration,
        outcome.protoOutput
      );
      deps.emitEvent(pipelineId, 'error', 'failed');
      return;
    }

    // ── 5. Critic iterate ────────────────────────
    case 'critic_iterate': {
      deps.recordProtoReasoning(pipelineId, outcome.protoOutput, outcome.scribeOutput);
      await deps.persistAcCoverage(pipelineId, outcome.protoOutput, outcome.scribeOutput);

      // Persist criticCodeOutput + Proto output for UI snapshot
      const stateBeforeIterate = await deps.store.getById(pipelineId);
      const intermediateBeforeIterate = (stateBeforeIterate?.intermediateState ?? {}) as Record<
        string,
        unknown
      >;
      await deps.store.update(pipelineId, {
        protoOutput: outcome.protoOutput,
        metrics: outcome.metrics,
        intermediateState: {
          ...intermediateBeforeIterate,
          criticCodeOutput: outcome.criticResult,
        },
      });

      await deps.emitProtoCompletedForIteration(
        pipelineId,
        outcome.protoIteration,
        outcome.protoOutput
      );

      deps.emitActivity({
        pipelineId,
        stage: 'critic',
        step: 'retry-trigger',
        message: `Değerlendirme kritik bulgu raporladı — Proto yeniden çalışıyor (${outcome.iterateDecision.nextRetry}/${outcome.iterateDecision.maxRetries})`,
        progress: 80,
        timestamp: new Date().toISOString(),
      });

      void deps.dispatchCriticIterate(pipelineId, outcome.iterateDecision.feedback).catch(() => {});
      return;
    }

    // ── 6. Critic hard-block ─────────────────────
    case 'critic_hard_block': {
      deps.recordProtoReasoning(pipelineId, outcome.protoOutput, outcome.scribeOutput);
      await deps.persistAcCoverage(pipelineId, outcome.protoOutput, outcome.scribeOutput);

      const stateBeforeBlock = await deps.store.getById(pipelineId);
      const intermediateBeforeBlock = (stateBeforeBlock?.intermediateState ?? {}) as Record<
        string,
        unknown
      >;
      await deps.store.update(pipelineId, {
        protoOutput: outcome.protoOutput,
        stage: 'awaiting_critic_resolution',
        metrics: outcome.metrics,
        intermediateState: {
          ...intermediateBeforeBlock,
          criticCodeOutput: outcome.criticResult,
          criticBlock: {
            blockedAt: new Date().toISOString(),
            overallScore: outcome.criticResult.overallScore,
            findingsCount: outcome.criticResult.findings?.length ?? 0,
            maxSeverity: outcome.criticResult.maxSeverity,
            manuallyOverridden: false,
          },
        },
      });

      await deps.emitProtoCompletedForIteration(
        pipelineId,
        outcome.protoIteration,
        outcome.protoOutput
      );

      deps.emitStageCompleted(pipelineId, 'proto');
      deps.emitEvent(pipelineId, 'stage_change', 'awaiting_critic_resolution');

      deps.emitActivity({
        pipelineId,
        stage: 'critic',
        step: 'gate_open',
        message: 'Değerlendirme kritik bulgu raporladı — kullanıcı kararı bekleniyor',
        progress: 100,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // ── 7+8. Ready for trace ─────────────────────
    case 'ready_for_trace': {
      await deps.emitProtoCompletedForIteration(
        pipelineId,
        outcome.protoIteration,
        outcome.protoOutput
      );

      deps.recordProtoReasoning(pipelineId, outcome.protoOutput, outcome.scribeOutput);
      await deps.persistAcCoverage(pipelineId, outcome.protoOutput, outcome.scribeOutput);

      deps.emitStageCompleted(pipelineId, 'proto');

      await deps.store.update(pipelineId, {
        protoOutput: outcome.protoOutput,
        stage: 'trace_testing',
        metrics: outcome.metrics,
      });
      deps.emitEvent(pipelineId, 'stage_change', 'trace_testing');

      if (outcome.jiraContext) {
        deps
          .runJiraProtoComment(outcome.jiraContext.userId, outcome.jiraContext.epicKey, {
            branch: outcome.protoOutput.branch,
            repo: outcome.protoOutput.repo,
            prUrl: outcome.protoOutput.prUrl,
            filesCreated: outcome.protoOutput.metadata.filesCreated,
          })
          .catch(() => {});
      }
      return;
    }

    default: {
      // Exhaustiveness guard — compile-time error if a variant is unhandled
      const _exhaustive: never = outcome;
      throw new Error(
        `Unhandled ProtoTraceOutcome type: ${(_exhaustive as { type: string }).type}`
      );
    }
  }
}
