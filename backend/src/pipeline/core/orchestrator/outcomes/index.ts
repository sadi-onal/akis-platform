/**
 * Outcome modules — declarative side-effect handlers for orchestrator return paths.
 *
 * Kademe 3 refactor.
 */
export {
  type ProtoTraceOutcome,
  type OutcomeCancelled,
  type OutcomeProtoError,
  type OutcomeTraceDisabled,
  type OutcomeValidationFailed,
  type OutcomeCriticIterate,
  type OutcomeCriticHardBlock,
  type OutcomeReadyForTrace,
  type HandleProtoTraceOutcomeDeps,
  handleProtoTraceOutcome,
} from './ProtoTraceOutcome.js';

export {
  type TraceOutcome,
  type OutcomeDryRunFailure,
  type OutcomeFixLoopSuccess,
  type OutcomeTraceError,
  type OutcomeIterateRetry,
  type OutcomeTraceSuccess,
  type HandleTraceOutcomeDeps,
  handleTraceOutcome,
} from './TraceOutcome.js';
