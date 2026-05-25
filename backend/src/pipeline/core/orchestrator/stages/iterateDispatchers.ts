/**
 * Iterate-loop dispatch functions extracted from PipelineOrchestrator.
 *
 * Kademe 2 refactor -- zero behavior change, mechanical extraction.
 * Every `this.X` dependency becomes an explicit `deps.X` parameter.
 */
import type {
  PipelineStage,
  PipelineMetrics,
  StructuredSpec,
} from '../../contracts/PipelineTypes.js';
import { pipelineCallContext } from '../../ai-calls/pipelineCallContext.js';
import { logger } from '../../../../lib/logger.js';
import type { PipelineStore } from '../PipelineOrchestrator.js';
import { isTerminalStage } from '../helpers/stateHelpers.js';

// ── Deps interfaces ──────────────────────────────

export interface DispatchTraceIterateDeps {
  store: PipelineStore;
  validateGitHubAccess: (userId: string) => Promise<{ token: string; owner: string }>;
  emitEvent: (
    pipelineId: string,
    type: 'stage_change' | 'scribe_message' | 'error' | 'completed',
    stage?: PipelineStage,
    data?: unknown
  ) => void;
  runProtoAndTrace: (
    pipelineId: string,
    metrics: PipelineMetrics,
    spec: StructuredSpec,
    repoName: string,
    repoVisibility: 'public' | 'private',
    owner: string,
    model?: string,
    userGithubService?: import('../../pipeline-factory.js').GitHubServiceLike,
    feedbackContext?: string
  ) => Promise<void>;
}

export interface DispatchCriticIterateDeps {
  store: PipelineStore;
  validateGitHubAccess: (userId: string) => Promise<{ token: string; owner: string }>;
  emitEvent: (
    pipelineId: string,
    type: 'stage_change' | 'scribe_message' | 'error' | 'completed',
    stage?: PipelineStage,
    data?: unknown
  ) => void;
  runProtoAndTrace: (
    pipelineId: string,
    metrics: PipelineMetrics,
    spec: StructuredSpec,
    repoName: string,
    repoVisibility: 'public' | 'private',
    owner: string,
    model?: string,
    userGithubService?: import('../../pipeline-factory.js').GitHubServiceLike,
    feedbackContext?: string
  ) => Promise<void>;
}

// ── Extracted functions ──────────────────────────────

export async function dispatchTraceIterate(
  pipelineId: string,
  feedback: string,
  deps: DispatchTraceIterateDeps
): Promise<void> {
  pipelineCallContext.enterWith({ pipelineId });
  const pipeline = await deps.store.getById(pipelineId);
  if (!pipeline) return;
  if (!pipeline.approvedSpec || !pipeline.protoConfig) {
    logger.warn(
      { pipelineId },
      '[Pipeline] PR-F Trace iterate-loop: missing approvedSpec/protoConfig'
    );
    return;
  }
  // Owner re-resolve (DOGFOOD_MODE'ta stub doner).
  let owner: string;
  try {
    const gh = await deps.validateGitHubAccess(pipeline.userId);
    owner = gh.owner;
  } catch (err) {
    logger.warn({ err, pipelineId }, '[Pipeline] PR-F iterate dispatch: GitHub owner failed');
    return;
  }
  const intermediate = (pipeline.intermediateState ?? {}) as Record<string, unknown>;
  const currentRetry =
    typeof intermediate.traceIterateRetryCount === 'number'
      ? (intermediate.traceIterateRetryCount as number)
      : 0;
  // PR-U1 C4: cancel race guard -- re-read state right before the update.
  // Between the top-of-fn `getById` and here, the user may have clicked
  // "Iptal" and the pipeline transitioned to `cancelled`. We must NOT
  // overwrite a terminal state and resurrect the pipeline.
  const fresh = await deps.store.getById(pipelineId);
  if (!fresh || isTerminalStage(fresh.stage)) {
    logger.info(
      { pipelineId, terminalStage: fresh?.stage },
      '[Pipeline] PR-U1 Trace iterate-loop: pipeline reached terminal state mid-flight, skipping re-iterate'
    );
    return;
  }
  // proto_building'a gec + retry counter'i kaydet.
  await deps.store.update(pipelineId, {
    stage: 'proto_building',
    intermediateState: {
      ...intermediate,
      traceIterateRetryCount: currentRetry + 1,
      traceIterateLastFeedback: feedback,
      traceIterateLastAt: new Date().toISOString(),
    },
  });
  deps.emitEvent(pipelineId, 'stage_change', 'proto_building');
  // Fire-and-forget. Trace fail'de fix-loop yine kendi icinde sarmalanir.
  deps
    .runProtoAndTrace(
      pipelineId,
      pipeline.metrics,
      pipeline.approvedSpec,
      pipeline.protoConfig.repoName,
      pipeline.protoConfig.repoVisibility,
      owner,
      pipeline.model,
      undefined,
      feedback
    )
    .catch((err) => {
      logger.error(
        { err, pipelineId },
        '[Pipeline] PR-F Trace iterate-loop runProtoAndTrace failed'
      );
    });
}

export async function dispatchCriticIterate(
  pipelineId: string,
  feedback: string,
  deps: DispatchCriticIterateDeps
): Promise<void> {
  pipelineCallContext.enterWith({ pipelineId });
  const pipeline = await deps.store.getById(pipelineId);
  if (!pipeline) return;
  if (!pipeline.approvedSpec || !pipeline.protoConfig) {
    logger.warn(
      { pipelineId },
      '[Pipeline] PR-F3 Critic iterate-loop: missing approvedSpec/protoConfig'
    );
    return;
  }
  // Owner re-resolve (DOGFOOD_MODE'ta stub doner).
  let owner: string;
  try {
    const gh = await deps.validateGitHubAccess(pipeline.userId);
    owner = gh.owner;
  } catch (err) {
    logger.warn(
      { err, pipelineId },
      '[Pipeline] PR-F3 Critic iterate dispatch: GitHub owner failed'
    );
    return;
  }
  const intermediate = (pipeline.intermediateState ?? {}) as Record<string, unknown>;
  const currentRetry =
    typeof intermediate.criticIterateRetryCount === 'number'
      ? (intermediate.criticIterateRetryCount as number)
      : 0;
  // PR-U1 C4: cancel race guard -- ayni dispatchTraceIterate'deki pattern.
  // User Critic-iterate'in mid-flight'inda "Iptal"e basarsa burada yakala.
  const fresh = await deps.store.getById(pipelineId);
  if (!fresh || isTerminalStage(fresh.stage)) {
    logger.info(
      { pipelineId, terminalStage: fresh?.stage },
      '[Pipeline] PR-U1 Critic iterate-loop: pipeline reached terminal state mid-flight, skipping re-iterate'
    );
    return;
  }
  // proto_building'a gec + retry counter'i kaydet.
  await deps.store.update(pipelineId, {
    stage: 'proto_building',
    intermediateState: {
      ...intermediate,
      criticIterateRetryCount: currentRetry + 1,
      criticIterateLastFeedback: feedback,
      criticIterateLastAt: new Date().toISOString(),
    },
  });
  deps.emitEvent(pipelineId, 'stage_change', 'proto_building');
  // Fire-and-forget. Critic review yine kendi icinde sarmalanir; sonraki
  // run da yine kritik bulgu raporlarsa loop devam eder (maxRetries'a kadar).
  deps
    .runProtoAndTrace(
      pipelineId,
      pipeline.metrics,
      pipeline.approvedSpec,
      pipeline.protoConfig.repoName,
      pipeline.protoConfig.repoVisibility,
      owner,
      pipeline.model,
      undefined,
      feedback
    )
    .catch((err) => {
      logger.error(
        { err, pipelineId },
        '[Pipeline] PR-F3 Critic iterate-loop runProtoAndTrace failed'
      );
    });
}
