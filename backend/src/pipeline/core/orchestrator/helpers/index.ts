/**
 * Re-exports from all orchestrator helper modules.
 *
 * Kademe 1 refactor — extracted ~50 helper methods into 6 modules.
 */
export {
  isTerminalStage,
  deriveRepoName,
  assertStage,
  reconstructScribeState,
  getPipeline,
  isCancelled,
  validateGitHubAccess,
} from './stateHelpers.js';

export {
  createTokenCallback,
  flushTokenUsage,
  getLiveTokenUsage,
  markStageStarted,
  getStageDurationMs,
  clearStageStarts,
} from './metricsHelpers.js';
export type { TokenAccumulator } from './metricsHelpers.js';

export {
  countPriorEvents,
  buildSubStepsForStage,
  buildScribeCompletedEvent,
  emitStageCompleted,
  appendProtoStarted,
  appendProtoCompleted,
  emitProtoCompletedForIteration,
  appendTraceStarted,
  appendTraceCompleted,
  appendTraceFailed,
} from './activityHelpers.js';

export {
  persistReasoning,
  recordScribeReasoning,
  recordProtoReasoning,
  recordTraceReasoning,
  persistAcCoverage,
  applyArtifactInjection,
} from './reasoningHelpers.js';

export {
  runJiraEpicCreation,
  postJiraFailureComment,
  runJiraProtoComment,
  runJiraTraceComment,
} from './jiraHelpers.js';

export {
  runCriticSpecReview,
  runCriticCodeReview,
  evaluateTraceIterateLoop,
  evaluateCriticIterateLoop,
} from './criticHelpers.js';
