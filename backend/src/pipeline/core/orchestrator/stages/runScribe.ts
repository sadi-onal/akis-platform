/**
 * Scribe stage runner functions extracted from PipelineOrchestrator.
 *
 * Kademe 2 refactor -- zero behavior change, mechanical extraction.
 * Every `this.X` dependency becomes an explicit `deps.X` parameter.
 */
import type {
  PipelineState,
  PipelineStage,
  PipelineMetrics,
  ScribeInput,
  ScribeOutput,
  ScribeMessageType,
  StructuredSpec,
  SubStep,
} from '../../contracts/PipelineTypes.js';
import { createPipelineError, PipelineErrorCode, RETRY_CONFIG } from '../../contracts/PipelineErrors.js';
import { createActivityEmitter, cleanupPipelineListeners } from '../../activityEmitter.js';
import { withRetry } from '../../retryWrapper.js';
import { scoreScribeEffort } from '../../effortScorer.js';
import { logger } from '../../../../lib/logger.js';
import { pipelineCallContext } from '../../ai-calls/pipelineCallContext.js';
import { buildCriticReasoning } from '../../explainability/reasoningFactory.js';
import type { ScribeState, ScribeResult } from '../../../agents/scribe/ScribeAgent.js';
import type { CriticAgent } from '../../../agents/critic/CriticAgent.js';
import type { CriticReviewOutput } from '../../../agents/critic/CriticTypes.js';
import type { PipelineStore, AgentSet, PipelineEvent } from '../PipelineOrchestrator.js';
import type { PipelineMetricsService } from '../../metrics/PipelineMetricsService.js';
import type { AgentReasoning } from '../../explainability/ExplainabilityTypes.js';

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

export interface RunScribeAnalysisDeps {
  store: PipelineStore;
  markStageStarted: (pipelineId: string, stage: 'scribe' | 'proto' | 'trace') => number;
  getPipeline: (id: string) => Promise<PipelineState>;
  fetchRepoContext: (
    userId: string,
    owner: string,
    repo: string,
    branch?: string
  ) => Promise<import('../../../agents/repo-context/RepoContextTypes.js').RepoContext>;
  getAgents: (model?: string, pipelineId?: string) => AgentSet;
  applyChatMemory: (
    pipeline: {
      id: string;
      scribeConversation?: readonly ScribeMessageType[];
      intermediateState?: Record<string, unknown> | null;
    },
    existingKnowledgeContext: string | undefined,
    query: string,
    opts: { messageIndex?: number }
  ) => Promise<string | undefined>;
  writeCheckpoint: (pipelineId: string, agentName: string, input: unknown) => Promise<void>;
  handleScribeResult: (
    pipelineId: string,
    metrics: PipelineMetrics,
    conversation: ScribeMessageType[],
    result: ScribeResult,
    clarificationRound?: number
  ) => Promise<PipelineState>;
}

export interface SendMessageDeps {
  store: PipelineStore;
  getPipeline: (id: string) => Promise<PipelineState>;
  emitEvent: (
    pipelineId: string,
    type: PipelineEvent['type'],
    stage?: PipelineStage,
    data?: unknown
  ) => void;
  getAgents: (model?: string, pipelineId?: string) => AgentSet;
  reconstructScribeState: (pipeline: PipelineState) => ScribeState;
  runScribeContinuation: (
    pipelineId: string,
    metrics: PipelineMetrics,
    scribeState: ScribeState,
    conversation: ScribeMessageType[],
    model?: string
  ) => Promise<void>;
  failPipeline: (pipelineId: string, label: string, err: unknown) => Promise<void>;
}

export interface RunScribeContinuationDeps {
  getAgents: (model?: string, pipelineId?: string) => AgentSet;
  getPipeline: (id: string) => Promise<PipelineState>;
  applyChatMemory: (
    pipeline: {
      id: string;
      scribeConversation?: readonly ScribeMessageType[];
      intermediateState?: Record<string, unknown> | null;
    },
    existingKnowledgeContext: string | undefined,
    query: string,
    opts: { messageIndex?: number }
  ) => Promise<string | undefined>;
  handleScribeResult: (
    pipelineId: string,
    metrics: PipelineMetrics,
    conversation: ScribeMessageType[],
    result: ScribeResult,
    clarificationRound?: number
  ) => Promise<PipelineState>;
}

export interface HandleScribeResultDeps {
  store: PipelineStore;
  emitEvent: (
    pipelineId: string,
    type: PipelineEvent['type'],
    stage?: PipelineStage,
    data?: unknown
  ) => void;
  recordScribeReasoning: (
    pipelineId: string,
    output: ScribeOutput,
    regenerated: boolean
  ) => void;
  emitStageCompleted: (
    pipelineId: string,
    stage: 'scribe' | 'proto' | 'trace',
    summary?: string
  ) => void;
  metricsService: PipelineMetricsService;
  criticAgent?: CriticAgent;
  runCriticSpecReview: (
    pipelineId: string,
    spec: StructuredSpec,
    originalIdea: string
  ) => Promise<CriticReviewOutput | null>;
  persistReasoning: (pipelineId: string, reasoning: AgentReasoning) => void;
  countPriorEvents: (
    conv: ScribeMessageType[],
    type: 'proto_completed' | 'trace_completed' | 'scribe_completed'
  ) => number;
  buildSubStepsForStage: (pipeline: PipelineState, stage: 'scribe' | 'proto' | 'trace') => SubStep[];
  buildScribeCompletedEvent: (
    pipelineId: string,
    iteration: number,
    output: ScribeOutput,
    subSteps?: SubStep[]
  ) => Extract<ScribeMessageType, { type: 'scribe_completed' }>;
  getGitHubOwner: (userId: string) => Promise<string>;
  runProtoAndTrace: (
    pipelineId: string,
    metrics: PipelineMetrics,
    spec: StructuredSpec,
    repoName: string,
    repoVisibility: 'public' | 'private',
    owner: string,
    model?: string
  ) => Promise<void>;
  failPipeline: (pipelineId: string, label: string, err: unknown) => Promise<void>;
  runJiraEpicCreation: (
    pipelineId: string,
    userId: string,
    projectKey: string,
    spec: StructuredSpec
  ) => Promise<void>;
}

// ── Extracted functions ──────────────────────────────

export async function runScribeAnalysis(
  pipelineId: string,
  metrics: PipelineMetrics,
  input: ScribeInput,
  conversation: ScribeMessageType[],
  model: string | undefined,
  deps: RunScribeAnalysisDeps
): Promise<void> {
  pipelineCallContext.enterWith({ pipelineId });
  const emit = createActivityEmitter(pipelineId, 'scribe');
  emit('start', 'Kullanıcı fikri analiz ediliyor...', 5);
  // Chat narrator (2026-05-23): snapshot stage start for server-truth
  // durationMs on the eventual `scribe_completed` event. Idempotent —
  // calling markStageStarted twice just refreshes the start (e.g. when
  // clarification rounds prolong Scribe — we treat the latest restart as
  // the wall-clock for the next completion).
  deps.markStageStarted(pipelineId, 'scribe');

  // ─── Repo Context: fetch if existingRepo is set ───
  const pipeline = await deps.getPipeline(pipelineId);
  const existingRepo = pipeline.intermediateState?.existingRepo as
    | { owner: string; repo: string; branch?: string }
    | undefined;
  let repoKnowledge = '';

  if (existingRepo) {
    try {
      emit('start', 'Mevcut repo analiz ediliyor...', 10);
      const repoContext = await deps.fetchRepoContext(
        pipeline.userId,
        existingRepo.owner,
        existingRepo.repo,
        existingRepo.branch
      );
      // Cache in DB for later use by Proto
      await deps.store.update(pipelineId, { repoContext });

      repoKnowledge =
        `\n\n--- EXISTING REPOSITORY CONTEXT ---\n` +
        `Repository: ${repoContext.owner}/${repoContext.repo} (branch: ${repoContext.branch})\n` +
        `Tech Stack: ${repoContext.techStack.join(', ')}\n` +
        `Summary: ${repoContext.summary}\n\n` +
        `File Tree:\n${repoContext.fileTree}\n` +
        `--- END REPOSITORY CONTEXT ---\n` +
        `\nIMPORTANT: You are writing a spec for a CHANGE to this existing codebase, not a new project. ` +
        `The spec should describe what to ADD or MODIFY in the existing code.`;
      logger.info(
        { pipelineId, owner: existingRepo.owner, repo: existingRepo.repo },
        '[Pipeline] RepoContext fetched'
      );
    } catch (err) {
      logger.warn(
        { err, pipelineId },
        '[Pipeline] RepoContext fetch failed, continuing without context'
      );
      emit('progress', 'Repo analizi atlandı, devam ediliyor...', 15);
    }
  }

  // Effort-based model routing
  const effort = scoreScribeEffort(input.idea);
  const effectiveModel = model ?? effort.model;
  logger.info(
    `[Scribe] Effort: ${effort.score}/10 → Model: ${effectiveModel} (${effort.reasoning})`
  );

  const agents = deps.getAgents(effectiveModel, pipelineId);
  const scribeState = agents.scribe.createInitialState(input);
  scribeState.pipelineId = pipelineId;

  // Thread multimodal image blocks into Scribe state so the agent can dispatch
  // to the multimodal API path when they exist. Issue #402 step 4.
  if (input.imageBlocks && input.imageBlocks.length > 0) {
    scribeState.imageBlocks = input.imageBlocks;
  }

  // Inject repo context as knowledge context
  if (repoKnowledge) {
    scribeState.knowledgeContext = (scribeState.knowledgeContext ?? '') + repoKnowledge;
  }

  // Inject file attachment context (uploaded files)
  const attachmentContext = (await deps.getPipeline(pipelineId)).intermediateState
    ?.attachmentContext as string | undefined;
  if (attachmentContext) {
    scribeState.knowledgeContext =
      (scribeState.knowledgeContext ?? '') + '\n\n' + attachmentContext;
  }

  // Issue #462 — chat-level conversation memory. First turn: no prior
  // anchors yet, but we still record the hit-set at messageIndex=0 so
  // subsequent turns can dedup. When `CHAT_CONTEXT_ENABLED=false` this
  // is a no-op and `scribeState.knowledgeContext` is unchanged.
  const scribeFirstPipeline = await deps.getPipeline(pipelineId);
  scribeState.knowledgeContext = await deps.applyChatMemory(
    scribeFirstPipeline,
    scribeState.knowledgeContext,
    input.idea,
    { messageIndex: 0 }
  );

  await deps.writeCheckpoint(pipelineId, 'scribe', input.idea);
  const result = await withRetry(
    (attempt) => {
      if (attempt > 1) emit('retry', `Scribe yeniden deneniyor (deneme ${attempt})...`, 30);
      return withTimeout(agents.scribe.analyzIdea(scribeState), STAGE_TIMEOUT, 'Scribe');
    },
    {
      maxAttempts: 3,
      onError: (err, attempt) =>
        logger.warn({ err, attempt }, '[Pipeline] Scribe analyzIdea attempt failed'),
    }
  );

  await deps.handleScribeResult(pipelineId, metrics, conversation, result);

  if (result.type === 'clarification') {
    emit('clarification', 'Açıklayıcı sorular oluşturuldu', 100);
  } else if (result.type === 'error') {
    emit('error', 'Scribe analizi başarısız oldu', 0);
  }
}

export async function sendMessageImpl(
  pipelineId: string,
  message: string,
  attachmentContext: string | undefined,
  deps: SendMessageDeps
): Promise<PipelineState> {
  const pipeline = await deps.getPipeline(pipelineId);

  // Persist new attachment context in intermediateState if provided
  if (attachmentContext) {
    const existingCtx = (pipeline.intermediateState?.attachmentContext as string) ?? '';
    await deps.store.update(pipelineId, {
      intermediateState: {
        ...pipeline.intermediateState,
        attachmentContext: existingCtx
          ? existingCtx + '\n\n' + attachmentContext
          : attachmentContext,
      },
    });
  }

  // Non-scribe states: save user note to conversation without changing pipeline state
  if (pipeline.stage !== 'scribe_clarifying') {
    const conversation: ScribeMessageType[] = [
      ...pipeline.scribeConversation,
      { type: 'user_note', content: message },
    ];
    const updated = await deps.store.update(pipelineId, {
      scribeConversation: conversation,
    });
    deps.emitEvent(pipelineId, 'scribe_message', pipeline.stage);
    return updated;
  }

  // Scribe clarifying flow (unchanged)
  // Guard: prevent unbounded conversation growth (max 20 entries ≈ 10 rounds)
  if (pipeline.scribeConversation.length >= 20) {
    const error = createPipelineError(
      PipelineErrorCode.AI_PROVIDER_ERROR,
      'Maksimum konuşma limiti aşıldı (20 mesaj). Lütfen yeni bir pipeline başlatın.'
    );
    const failed = await deps.store.update(pipelineId, { stage: 'failed', error });
    deps.emitEvent(pipelineId, 'error', 'failed', error);
    return failed;
  }

  const agents = deps.getAgents(pipeline.model, pipelineId);
  const scribeState = deps.reconstructScribeState(pipeline);

  // Inject accumulated attachment context into scribe state for this continuation
  const accumulatedCtx = (await deps.getPipeline(pipelineId)).intermediateState
    ?.attachmentContext as string | undefined;
  if (accumulatedCtx) {
    scribeState.knowledgeContext = (scribeState.knowledgeContext ?? '') + '\n\n' + accumulatedCtx;
  }

  agents.scribe.processUserAnswer(scribeState, message);

  const conversation: ScribeMessageType[] = [
    ...pipeline.scribeConversation,
    { type: 'user_answer', content: message },
  ];

  // Update with user answer immediately (optimistic lock prevents concurrent mutations)
  const updated = await deps.store.update(
    pipelineId,
    {
      scribeConversation: conversation,
      stage: 'scribe_generating',
    },
    { expectedStageVersion: pipeline.stageVersion }
  );
  deps.emitEvent(pipelineId, 'stage_change', 'scribe_generating');

  // Run Scribe continuation in background
  deps
    .runScribeContinuation(pipelineId, pipeline.metrics, scribeState, conversation, pipeline.model)
    .catch((err) => {
      logger.error({ err, pipelineId }, '[Pipeline] Background Scribe continuation failed');
      deps.failPipeline(pipelineId, 'Scribe', err).catch((e) =>
        logger.error({ err: e }, '[Pipeline] failPipeline also failed')
      );
    });

  return updated;
}

export async function runScribeContinuation(
  pipelineId: string,
  metrics: PipelineMetrics,
  scribeState: ScribeState,
  conversation: ScribeMessageType[],
  model: string | undefined,
  deps: RunScribeContinuationDeps
): Promise<void> {
  pipelineCallContext.enterWith({ pipelineId });
  const emit = createActivityEmitter(pipelineId, 'scribe');
  emit('start', 'Kullanıcı yanıtıyla devam ediliyor...', 10);
  scribeState.pipelineId = pipelineId;

  const agents = deps.getAgents(model, pipelineId);

  // Issue #462 — inject prior-turn memory for the continuation call. The
  // query is the most recent user answer in the conversation (latest
  // user-side message). `conversation.length` doubles as the message
  // index so anchors are written one-per-turn.
  const latestUserMsg = [...conversation]
    .reverse()
    .find((m) => m.type === 'user_answer' || m.type === 'user_note' || m.type === 'user_idea');
  const continuationQuery =
    typeof latestUserMsg?.content === 'string' ? latestUserMsg.content : '';
  const pipelineForMemory = await deps.getPipeline(pipelineId);
  scribeState.knowledgeContext = await deps.applyChatMemory(
    pipelineForMemory,
    scribeState.knowledgeContext,
    continuationQuery,
    { messageIndex: conversation.length }
  );

  const result = await withRetry(
    (attempt) => {
      if (attempt > 1)
        emit('retry', `Scribe devamı yeniden deneniyor (deneme ${attempt})...`, 35);
      return withTimeout(agents.scribe.continueAfterAnswer(scribeState), STAGE_TIMEOUT, 'Scribe');
    },
    {
      maxAttempts: 3,
      onError: (err, attempt) =>
        logger.warn({ err, attempt }, '[Pipeline] Scribe continueAfterAnswer attempt failed'),
    }
  );

  await deps.handleScribeResult(
    pipelineId,
    metrics,
    conversation,
    result,
    scribeState.clarificationRound
  );

  if (result.type === 'clarification') {
    emit('clarification', 'Ek sorular oluşturuldu', 100);
  } else if (result.type === 'error') {
    emit('error', 'Scribe devamı başarısız oldu', 0);
  }
}

export async function handleScribeResult(
  pipelineId: string,
  metrics: PipelineMetrics,
  conversation: ScribeMessageType[],
  result: ScribeResult,
  clarificationRound: number | undefined,
  deps: HandleScribeResultDeps
): Promise<PipelineState> {
  if (result.type === 'clarification') {
    conversation.push({ type: 'clarification', content: result.data });
    const updated = await deps.store.update(pipelineId, {
      stage: 'scribe_clarifying',
      scribeConversation: conversation,
      metrics: {
        ...metrics,
        clarificationRounds: clarificationRound ?? metrics.clarificationRounds + 1,
      },
    });
    deps.emitEvent(pipelineId, 'scribe_message', 'scribe_clarifying', result.data);
    return updated;
  }

  if (result.type === 'spec') {
    conversation.push({ type: 'spec_draft', content: result.data });
    const pipelineForJira = await deps.store.getById(pipelineId);

    deps.recordScribeReasoning(pipelineId, result.data, /* regenerated */ false);

    // PR-V5: explicit Scribe completion signal BEFORE the next stage
    // (critic_reviewing_spec / awaiting_approval) takes over the SSE
    // stream. Without this, the frontend "stage X is no longer latest"
    // heuristic would flip Scribe's checkmark on as soon as the first
    // critic/proto activity lands — i.e. before Scribe's real exit.
    deps.emitStageCompleted(pipelineId, 'scribe');

    // ─── Level 3: CriticAgent spec review (if available) ───
    if (deps.criticAgent) {
      deps.metricsService.startStage(pipelineId, 'critic_spec');
      await deps.store.update(pipelineId, {
        stage: 'critic_reviewing_spec',
        scribeConversation: conversation,
        scribeOutput: result.data,
        title: result.data.spec.title,
        metrics: { ...metrics, scribeCompletedAt: new Date() },
      });
      deps.emitEvent(pipelineId, 'stage_change', 'critic_reviewing_spec');

      const criticSpecEmit = createActivityEmitter(pipelineId, 'critic', {
        criticPhase: 'spec',
      });
      criticSpecEmit(
        'start',
        'Spesifikasyon inceleniyor...',
        10,
        undefined,
        undefined,
        'pipeline.critic.spec.start'
      );

      const ideaMsg = conversation.find((m) => m.type === 'user_idea');
      const originalIdea = typeof ideaMsg?.content === 'string' ? ideaMsg.content : '';
      const criticResult = await deps.runCriticSpecReview(
        pipelineId,
        result.data.spec,
        originalIdea
      );

      if (criticResult) {
        criticSpecEmit(
          criticResult.approved ? 'approved' : 'rejected',
          criticResult.approved
            ? `Spec incelemesi tamamlandı: ${criticResult.overallScore}/100 puan`
            : `Spec incelemesi: ${criticResult.findings?.length ?? 0} bulgu raporlandı`,
          100,
          criticResult.summary,
          undefined,
          'pipeline.critic.spec.done',
          {
            decision: criticResult.approved ? 'Spec uygun bulundu' : 'Spec düzeltme gerekli',
            snippet: criticResult.summary,
            confidence: criticResult.overallScore ?? 0,
          }
        );
      }

      deps.metricsService.endStage(pipelineId, 'critic_spec', criticResult?.approved ?? true, {
        overallScore: criticResult?.overallScore ?? 0,
        findingsCount: criticResult?.findings?.length ?? 0,
        approved: criticResult?.approved ?? true,
      });

      // Store critic output in intermediateState (merge with existing keys)
      if (criticResult) {
        const currentPipelineForCritic = await deps.store.getById(pipelineId);
        const existingCriticState = (currentPipelineForCritic?.intermediateState ?? {}) as Record<
          string,
          unknown
        >;
        await deps.store.update(pipelineId, {
          intermediateState: { ...existingCriticState, criticSpecOutput: criticResult },
        });
      }
      // If critic rejected and score < threshold, log but proceed (human gate is next)
      logger.info(
        { pipelineId, approved: criticResult?.approved, score: criticResult?.overallScore },
        '[Pipeline] Critic spec review completed'
      );

      // Level 4: Explainability — record critic-spec reasoning
      if (criticResult) {
        deps.persistReasoning(
          pipelineId,
          buildCriticReasoning(criticResult, { reviewType: 'spec' })
        );
      }

      // ─── Level 4: Adaptive Autonomy — auto-approve if threshold met ───
      const currentPipeline = await deps.store.getById(pipelineId);
      const autoThreshold = currentPipeline?.autoApproveThreshold ?? 85;
      if (
        currentPipeline?.autoApproveEnabled &&
        criticResult?.approved &&
        criticResult.overallScore >= autoThreshold
      ) {
        logger.info(
          { pipelineId, criticScore: criticResult.overallScore, threshold: autoThreshold },
          '[Pipeline] Auto-approved: critic score meets adaptive autonomy threshold'
        );
        // Chat narrator (2026-05-23): emit scribe_completed event into the
        // same conversation snapshot. subSteps include Critic findings.
        // Iteration counter = prior scribe_completed events + 1.
        const scribeIterationAuto = deps.countPriorEvents(conversation, 'scribe_completed') + 1;
        const scribeSubStepsAuto = deps.buildSubStepsForStage(
          {
            ...currentPipeline,
            scribeOutput: result.data,
            intermediateState: {
              ...(currentPipeline?.intermediateState ?? {}),
              criticSpecOutput: criticResult,
            },
          } as PipelineState,
          'scribe'
        );
        conversation.push(
          deps.buildScribeCompletedEvent(
            pipelineId,
            scribeIterationAuto,
            result.data,
            scribeSubStepsAuto.length > 0 ? scribeSubStepsAuto : undefined
          )
        );
        await deps.store.update(pipelineId, {
          scribeConversation: conversation,
          scribeOutput: result.data,
          approvedSpec: result.data.spec,
          title: result.data.spec.title,
          metrics: { ...metrics, scribeCompletedAt: new Date(), approvedAt: new Date() },
          intermediateState: {
            ...currentPipeline.intermediateState,
            autoApproved: true,
            autoApproveScore: criticResult.overallScore,
          },
        });

        // Determine repo config
        const proto = currentPipeline.protoConfig ?? {
          repoName: result.data.spec.title.replace(/\s+/g, '-').toLowerCase().slice(0, 50),
          repoVisibility: 'private' as const,
        };
        const autoOwner = await deps.getGitHubOwner(currentPipeline.userId);
        // Trigger Proto directly (skip human gate)
        deps
          .runProtoAndTrace(
            pipelineId,
            {
              ...metrics,
              scribeCompletedAt: new Date(),
              approvedAt: new Date(),
            } as PipelineMetrics,
            result.data.spec,
            proto.repoName,
            proto.repoVisibility,
            autoOwner,
            currentPipeline.model
          )
          .catch((err) => {
            logger.error(
              { err, pipelineId },
              '[Pipeline] Background Proto+Trace failed after auto-approve'
            );
            deps.failPipeline(pipelineId, 'Proto', err).catch((e) =>
              logger.error({ err: e }, '[Pipeline] failPipeline also failed')
            );
          })
          .finally(() => {
            cleanupPipelineListeners(pipelineId);
          });

        return (await deps.store.getById(pipelineId)) as PipelineState;
      }
    }

    // Chat narrator (2026-05-23): emit scribe_completed into the same
    // conversation snapshot so the chat baloncuğu shows summary + plan
    // card + critic-derived sub-steps. Iteration counter = prior
    // scribe_completed events + 1.
    const scribePipelineForSubSteps = await deps.store.getById(pipelineId);
    const scribeIteration = deps.countPriorEvents(conversation, 'scribe_completed') + 1;
    const scribeSubSteps = deps.buildSubStepsForStage(
      {
        ...(scribePipelineForSubSteps ?? {}),
        scribeOutput: result.data,
      } as PipelineState,
      'scribe'
    );
    conversation.push(
      deps.buildScribeCompletedEvent(
        pipelineId,
        scribeIteration,
        result.data,
        scribeSubSteps.length > 0 ? scribeSubSteps : undefined
      )
    );

    const updated = await deps.store.update(pipelineId, {
      stage: 'awaiting_approval',
      scribeConversation: conversation,
      scribeOutput: result.data,
      title: result.data.spec.title,
      metrics: { ...metrics, scribeCompletedAt: new Date() },
    });
    deps.emitEvent(pipelineId, 'stage_change', 'awaiting_approval', result.data);

    // Jira hook: create Epic from spec (non-blocking, failures are swallowed)
    if (pipelineForJira?.jiraConfig?.enabled && pipelineForJira.jiraConfig.projectKey) {
      deps
        .runJiraEpicCreation(
          pipelineId,
          pipelineForJira.userId,
          pipelineForJira.jiraConfig.projectKey,
          result.data.spec
        )
        .catch((err) => logger.warn({ err }, '[Pipeline] Non-blocking task failed'));
    }

    return updated;
  }

  // Error
  const updated = await deps.store.update(pipelineId, {
    stage: 'failed',
    scribeConversation: conversation,
    error: result.error,
  });
  deps.emitEvent(pipelineId, 'error', 'failed', result.error);
  return updated;
}
