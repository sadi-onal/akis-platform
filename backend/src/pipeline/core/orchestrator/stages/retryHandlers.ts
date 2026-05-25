/**
 * Retry handler functions extracted from PipelineOrchestrator.
 *
 * Kademe 2 refactor -- zero behavior change, mechanical extraction.
 * Every `this.X` dependency becomes an explicit `deps.X` parameter.
 */
import type {
  PipelineState,
  PipelineMetrics,
  StructuredSpec,
} from '../../contracts/PipelineTypes.js';
import {
  createPipelineError,
  PipelineErrorCode,
  RETRY_CONFIG,
} from '../../contracts/PipelineErrors.js';
import { buildUnifiedAgentKnowledgeContext } from '../../unifiedPipelineContext.js';
import type { PipelineStore, AgentSet } from '../PipelineOrchestrator.js';
import type { ScribeState } from '../../../agents/scribe/ScribeAgent.js';

const STAGE_TIMEOUT = RETRY_CONFIG.stageTimeoutMs;

/** Timeout guard -- duplicated from orchestrator (module-private there). */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} stage timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

// ── Deps interfaces ──────────────────────────────

export interface RetryTraceDeps {
  store: PipelineStore;
  validateGitHubAccess: (userId: string) => Promise<{ token: string; owner: string }>;
  getPipeline: (id: string) => Promise<PipelineState>;
  emitEvent: (
    pipelineId: string,
    type: 'stage_change' | 'scribe_message' | 'error' | 'completed',
    stage?: string,
    data?: unknown
  ) => void;
  runTrace: (
    pipelineId: string,
    metrics: PipelineMetrics,
    owner: string,
    repo: string,
    branch: string,
    spec?: StructuredSpec,
    model?: string,
    options?: {
      dryRun?: boolean;
      inputFiles?: Array<{ filePath: string; content: string }>;
      postSuccess?: 'completed' | 'awaiting_push_confirm';
    }
  ) => Promise<PipelineState>;
}

export interface RetryProtoDeps {
  store: PipelineStore;
  validateGitHubAccess: (userId: string) => Promise<{ token: string; owner: string }>;
  getPipeline: (id: string) => Promise<PipelineState>;
  emitEvent: (
    pipelineId: string,
    type: 'stage_change' | 'scribe_message' | 'error' | 'completed',
    stage?: string,
    data?: unknown
  ) => void;
  createAgentsForModel?: (
    model: string,
    githubService?: import('../../pipeline-factory.js').GitHubServiceLike,
    onTokenUsage?: import('../../pipeline-factory.js').TokenUsageCallback
  ) => AgentSet;
  getAgents: (model?: string, pipelineId?: string) => AgentSet;
  createGitHubService: (token: string) => import('../../pipeline-factory.js').GitHubServiceLike;
  runTrace: (
    pipelineId: string,
    metrics: PipelineMetrics,
    owner: string,
    repo: string,
    branch: string,
    spec?: StructuredSpec,
    model?: string,
    options?: {
      dryRun?: boolean;
      inputFiles?: Array<{ filePath: string; content: string }>;
      postSuccess?: 'completed' | 'awaiting_push_confirm';
    }
  ) => Promise<PipelineState>;
}

export interface RetryScribeDeps {
  store: PipelineStore;
  getPipeline: (id: string) => Promise<PipelineState>;
  emitEvent: (
    pipelineId: string,
    type: 'stage_change' | 'scribe_message' | 'error' | 'completed',
    stage?: string,
    data?: unknown
  ) => void;
  getAgents: (model?: string, pipelineId?: string) => AgentSet;
  reconstructScribeState: (pipeline: PipelineState) => ScribeState;
  handleScribeResult: (
    pipelineId: string,
    metrics: PipelineMetrics,
    conversation: import('../../contracts/PipelineTypes.js').ScribeMessageType[],
    result: import('../../../agents/scribe/ScribeAgent.js').ScribeResult,
    clarificationRound?: number
  ) => Promise<PipelineState>;
}

// ── Extracted functions ──────────────────────────────

export async function retryTrace(
  pipelineId: string,
  pipeline: PipelineState,
  deps: RetryTraceDeps
): Promise<PipelineState> {
  let owner: string;
  try {
    const gh = await deps.validateGitHubAccess(pipeline.userId);
    owner = gh.owner;
  } catch (err) {
    const error = createPipelineError(
      PipelineErrorCode.GITHUB_NOT_CONNECTED,
      `GitHub owner coezuemlenemedi: ${err instanceof Error ? err.message : String(err)}`
    );
    const failed = await deps.store.update(pipelineId, { stage: 'failed', error });
    deps.emitEvent(pipelineId, 'error', 'failed', error);
    return failed;
  }

  const p = await deps.getPipeline(pipelineId);

  // Clear stale traceDryRun status from the previous failed attempt
  const existingTraceState = (p.intermediateState ?? {}) as Record<string, unknown>;
  const { traceDryRunStatus, traceDryRunErrorCode, traceDryRunErrorAt, ...cleanTraceState } =
    existingTraceState;
  if (traceDryRunStatus || traceDryRunErrorCode || traceDryRunErrorAt) {
    await deps.store.update(pipelineId, { intermediateState: cleanTraceState });
  }

  await deps.store.update(
    pipelineId,
    { stage: 'trace_testing' },
    { expectedStageVersion: p.stageVersion }
  );
  deps.emitEvent(pipelineId, 'stage_change', 'trace_testing');

  if (!pipeline.protoOutput) {
    throw new Error('Cannot retry Trace: protoOutput is missing');
  }
  const repo =
    pipeline.protoConfig?.repoName ??
    pipeline.protoOutput.repo.split('/')[1] ??
    pipeline.protoOutput.repo;

  return deps.runTrace(
    pipelineId,
    pipeline.metrics,
    owner,
    repo,
    pipeline.protoOutput.branch,
    pipeline.approvedSpec,
    pipeline.model
  );
}

export async function retryProto(
  pipelineId: string,
  pipeline: PipelineState,
  deps: RetryProtoDeps
): Promise<PipelineState> {
  let owner: string;
  let userGitHubToken: string;
  try {
    const gh = await deps.validateGitHubAccess(pipeline.userId);
    userGitHubToken = gh.token;
    owner = gh.owner;
  } catch (err) {
    const error = createPipelineError(
      PipelineErrorCode.GITHUB_NOT_CONNECTED,
      `GitHub owner coezuemlenemedi: ${err instanceof Error ? err.message : String(err)}`
    );
    const failed = await deps.store.update(pipelineId, { stage: 'failed', error });
    deps.emitEvent(pipelineId, 'error', 'failed', error);
    return failed;
  }
  if (!pipeline.approvedSpec) {
    throw new Error('Cannot retry Proto: approvedSpec is missing');
  }
  const repoName =
    pipeline.protoConfig?.repoName ??
    pipeline.approvedSpec.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
  const repoVisibility = pipeline.protoConfig?.repoVisibility ?? 'private';

  const current = await deps.getPipeline(pipelineId);
  await deps.store.update(
    pipelineId,
    { stage: 'proto_building' },
    { expectedStageVersion: current.stageVersion }
  );
  deps.emitEvent(pipelineId, 'stage_change', 'proto_building');

  // Per-user GitHub adapter for retry
  const userGithubService = deps.createGitHubService(userGitHubToken);
  const agents =
    deps.createAgentsForModel?.(pipeline.model ?? '', userGithubService) ??
    deps.getAgents(pipeline.model, pipelineId);
  const retryProtoKbRaw = buildUnifiedAgentKnowledgeContext(pipeline, { role: 'proto' });
  const retryProtoKb = retryProtoKbRaw.trim() ? retryProtoKbRaw : undefined;
  // M-4: Respect preview gate on retry -- same logic as the normal Proto path
  const retryPreviewGateEnabled = process.env.AUTO_PUSH_AFTER_PROTO !== 'true';
  const result = await withTimeout(
    agents.proto.execute({
      spec: pipeline.approvedSpec,
      repoName,
      repoVisibility,
      owner,
      pipelineId,
      knowledgeContext: retryProtoKb,
      dryRun: retryPreviewGateEnabled,
    }),
    STAGE_TIMEOUT,
    'Proto'
  );

  if (result.type === 'error') {
    const updated = await deps.store.update(pipelineId, { stage: 'failed', error: result.error });
    deps.emitEvent(pipelineId, 'error', 'failed', result.error);
    return updated;
  }

  await deps.store.update(pipelineId, {
    protoOutput: result.data,
    stage: 'trace_testing',
    metrics: { ...pipeline.metrics, protoCompletedAt: new Date() },
  });
  deps.emitEvent(pipelineId, 'stage_change', 'trace_testing');

  if (retryPreviewGateEnabled) {
    // Preview gate enabled: run Trace in dryRun mode, then hand off to push gate
    return deps.runTrace(
      pipelineId,
      pipeline.metrics,
      owner,
      repoName,
      result.data.branch,
      pipeline.approvedSpec,
      pipeline.model,
      {
        dryRun: true,
        inputFiles: result.data.files.map((f) => ({
          filePath: f.filePath,
          content: f.content,
        })),
        postSuccess: 'awaiting_push_confirm',
      }
    );
  }

  return deps.runTrace(
    pipelineId,
    pipeline.metrics,
    owner,
    repoName,
    result.data.branch,
    pipeline.approvedSpec,
    pipeline.model
  );
}

export async function retryScribe(
  pipelineId: string,
  pipeline: PipelineState,
  deps: RetryScribeDeps
): Promise<PipelineState> {
  const agents = deps.getAgents(pipeline.model, pipelineId);
  const scribeState = deps.reconstructScribeState(pipeline);
  scribeState.pipelineId = pipelineId;
  const current = await deps.getPipeline(pipelineId);
  await deps.store.update(
    pipelineId,
    { stage: 'scribe_clarifying' },
    { expectedStageVersion: current.stageVersion }
  );
  deps.emitEvent(pipelineId, 'stage_change', 'scribe_clarifying');

  const result = await withTimeout(agents.scribe.analyzIdea(scribeState), STAGE_TIMEOUT, 'Scribe');
  return deps.handleScribeResult(
    pipelineId,
    pipeline.metrics,
    [...pipeline.scribeConversation],
    result
  );
}
