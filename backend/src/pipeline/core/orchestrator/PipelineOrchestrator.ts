import type {
  PipelineState,
  PipelineStage,
  PipelineError,
  PipelineMetrics,
  ScribeInput,
  ScribeOutput,
  ScribeMessageType,
  StructuredSpec,
  ProtoOutput,
  TraceOutput,
} from '../contracts/PipelineTypes.js';
import { JiraMCPService } from '../../../services/mcp/adapters/JiraMCPService.js';
import {
  createJiraEpicFromSpec,
  commentJiraWithProtoResult,
  commentJiraWithTraceResult,
  commentJiraWithFailure,
} from '../../integrations/jiraIntegration.js';
import {
  RETRY_CONFIG,
  createPipelineError,
  PipelineErrorCode,
  PipelineNotFoundError,
  InvalidStageError,
} from '../contracts/PipelineErrors.js';
import {
  createActivityEmitter,
  emitActivity,
  cleanupPipelineListeners,
} from '../activityEmitter.js';
import { withRetry } from '../retryWrapper.js';
import { scoreScribeEffort, scoreProtoEffort, scoreTraceEffort } from '../effortScorer.js';
import { logger } from '../../../lib/logger.js';
import { PipelineKnowledgeIngester } from '../../../services/knowledge/ingestion/PipelineKnowledgeIngester.js';
import type { ScribeAgent, ScribeState, ScribeResult } from '../../agents/scribe/ScribeAgent.js';
import type { ProtoAgent } from '../../agents/proto/ProtoAgent.js';
import type { TraceAgent } from '../../agents/trace/TraceAgent.js';
import type { CriticAgent, CriticResult } from '../../agents/critic/CriticAgent.js';
import type { CriticReviewOutput } from '../../agents/critic/CriticTypes.js';
import { FixLoopService } from '../fix-loop/FixLoopService.js';
import { PipelineMetricsService } from '../metrics/PipelineMetricsService.js';

// ─── Level 4 Imports ─────────────────────────────
import { DeterministicValidator } from '../validator/DeterministicValidator.js';
import { SecurityGate } from '../security-gate/SecurityGate.js';
import { ExplainabilityService } from '../explainability/ExplainabilityService.js';
import { RegressionService } from '../regression/RegressionService.js';
import {
  buildScribeReasoning,
  buildProtoReasoning,
  buildTraceReasoning,
  buildCriticReasoning,
} from '../explainability/reasoningFactory.js';
import { LearningService } from '../learning/LearningService.js';
import { buildUnifiedAgentKnowledgeContext } from '../unifiedPipelineContext.js';
import {
  chatMemoryContextService,
  type ChatMemoryContextService,
} from '../../../services/knowledge/ChatMemoryContextService.js';
import { getEnv } from '../../../config/env.js';

// ─── Timeout Guard ───────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} stage timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

const STAGE_TIMEOUT = RETRY_CONFIG.stageTimeoutMs;
const TRACE_TIMEOUT = RETRY_CONFIG.traceStageTimeoutMs;

/**
 * Pull persisted image blocks out of a pipeline's intermediateState. The
 * orchestrator stashes user-uploaded screenshots here on startPipeline so
 * background Proto + Trace runs (which wake up hours later on approve) can
 * forward the same images to their multimodal calls. Issue #464 BUG-C.
 *
 * Returns `undefined` when the field is absent or empty so downstream
 * agents can treat it as "no images" and skip the multimodal dispatch.
 */
function readPipelineImageBlocks(
  intermediateState: Record<string, unknown> | undefined | null
): readonly import('../../../services/ai/multimodalClient.js').AnthropicImageBlock[] | undefined {
  if (!intermediateState) return undefined;
  const raw = (intermediateState as Record<string, unknown>).imageBlocks;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw as readonly import('../../../services/ai/multimodalClient.js').AnthropicImageBlock[];
}

const PIPELINE_TITLE_MAX = 100;

/**
 * Default model used when a chat is created without an explicit model. Kept
 * separate from `RECOMMENDED_MODELS.anthropic` so a future RECOMMENDED bump
 * doesn't silently change which model in-flight pipelines lock to.
 */
const DEFAULT_PIPELINE_MODEL = 'claude-haiku-4-5-20251001';

export function ideaToTitle(idea: string): string {
  const firstLine = idea.split('\n')[0]?.trim() ?? '';
  return firstLine.slice(0, PIPELINE_TITLE_MAX);
}

/** Safely get epoch ms from a Date or ISO string (JSONB stores dates as strings). */
function toEpoch(d: Date | string | undefined): number {
  if (!d) return Date.now();
  return typeof d === 'string' ? new Date(d).getTime() : d.getTime();
}

// ─── Store Interface ──────────────────────────────

export interface PipelineStore {
  create(userId: string): Promise<PipelineState>;
  getById(id: string): Promise<PipelineState | null>;
  /**
   * List all pipelines for a user, regardless of parent-child relationship.
   * For the chat sidebar, prefer {@link listRootsByUser} which filters out iteration children.
   */
  listByUser(userId: string): Promise<PipelineState[]>;
  /**
   * List only "root" pipelines (those without `intermediateState.parentPipelineId`).
   * Iteration child pipelines are hidden — they belong to their parent's chat timeline.
   */
  listRootsByUser?(userId: string): Promise<PipelineState[]>;
  /**
   * List child pipelines (iterations) of a given root, oldest first.
   * Used to merge iteration activities into the chat timeline.
   */
  listChildrenOf?(parentPipelineId: string): Promise<PipelineState[]>;
  update(
    id: string,
    data: Partial<PipelineStateUpdate>,
    opts?: { expectedStageVersion?: number }
  ): Promise<PipelineState>;
}

export interface PipelineStateUpdate {
  stage: PipelineStage;
  title: string;
  model: string;
  modelLockedAt: Date;
  traceEnabled: boolean;
  scribeConversation: ScribeMessageType[];
  scribeOutput: ScribeOutput;
  approvedSpec: StructuredSpec;
  protoOutput: ProtoOutput;
  traceOutput: TraceOutput;
  repoContext: import('../../agents/repo-context/RepoContextTypes.js').RepoContext;
  protoConfig: { repoName: string; repoVisibility: 'public' | 'private' };
  jiraConfig: { projectKey: string; enabled: boolean; epicKey?: string };
  metrics: PipelineMetrics;
  error: PipelineError | null;
  intermediateState: Record<string, unknown>;
  attemptCount: number;
  autoApproveEnabled: boolean;
  autoApproveThreshold: number;
}

// ─── Event Interface ──────────────────────────────

export interface PipelineEvent {
  pipelineId: string;
  type: 'stage_change' | 'scribe_message' | 'error' | 'completed';
  stage?: PipelineStage;
  data?: unknown;
}

// ─── Orchestrator ─────────────────────────────────

export interface AgentSet {
  scribe: ScribeAgent;
  proto: ProtoAgent;
  trace: TraceAgent;
  critic?: CriticAgent;
}

export class PipelineOrchestrator {
  /** Per-pipeline mutation lock — serializes concurrent operations on the same pipeline. */
  private locks = new Map<string, Promise<unknown>>();

  private activityLogger?: { record(entry: Record<string, unknown>): Promise<void> };

  // ─── Token Usage Tracking ─────────────────────────
  /** Accumulated token usage per pipeline (flushed to DB when stage completes). */
  private tokenAccumulators = new Map<string, { inputTokens: number; outputTokens: number }>();

  /** Create a callback that accumulates token usage for a specific pipeline. */
  createTokenCallback(pipelineId: string): import('../pipeline-factory.js').TokenUsageCallback {
    return (usage) => {
      const acc = this.tokenAccumulators.get(pipelineId) ?? { inputTokens: 0, outputTokens: 0 };
      acc.inputTokens += usage.inputTokens;
      acc.outputTokens += usage.outputTokens;
      this.tokenAccumulators.set(pipelineId, acc);
    };
  }

  /** Flush accumulated token usage to the pipeline's metrics in the DB. */
  private async flushTokenUsage(pipelineId: string): Promise<void> {
    const acc = this.tokenAccumulators.get(pipelineId);
    if (!acc || (acc.inputTokens === 0 && acc.outputTokens === 0)) return;

    try {
      const pipeline = await this.store.getById(pipelineId);
      if (!pipeline) return;
      const metrics = pipeline.metrics;
      const updatedMetrics = {
        ...metrics,
        inputTokens: (metrics.inputTokens ?? 0) + acc.inputTokens,
        outputTokens: (metrics.outputTokens ?? 0) + acc.outputTokens,
        totalTokens: (metrics.totalTokens ?? 0) + acc.inputTokens + acc.outputTokens,
      };
      await this.store.update(pipelineId, { metrics: updatedMetrics });
      this.tokenAccumulators.delete(pipelineId);
    } catch (err) {
      logger.warn({ err, pipelineId }, '[Pipeline] Token usage flush failed (non-fatal)');
    }
  }

  /**
   * Return the live token usage for a pipeline by summing the DB-persisted
   * metrics with any in-memory accumulator that has not been flushed yet.
   * This lets the chat token gauge (issue #438) show an up-to-date value
   * even while the pipeline is mid-stage and {@link flushTokenUsage} has
   * not yet written the latest call's tokens into `pipelines.metrics`.
   */
  getLiveTokenUsage(
    pipelineId: string,
    persistedMetrics?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  ): { inputTokens: number; outputTokens: number; totalTokens: number } {
    const persisted = persistedMetrics ?? {};
    const acc = this.tokenAccumulators.get(pipelineId) ?? { inputTokens: 0, outputTokens: 0 };
    const inputTokens = (persisted.inputTokens ?? 0) + acc.inputTokens;
    const outputTokens = (persisted.outputTokens ?? 0) + acc.outputTokens;
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }

  // ─── Level 3 Services ───────────────────────────
  private criticAgent?: CriticAgent;
  private fixLoopService = new FixLoopService();
  private metricsService = new PipelineMetricsService();

  // ─── Level 4 Services ───────────────────────────
  private validator = new DeterministicValidator();
  private securityGate = new SecurityGate();
  private explainability = new ExplainabilityService();
  private learningService = new LearningService();
  // ─── Tier 1.A — Regression Confidence ──────────────
  private regressionService: RegressionService | null = null;

  // ─── Chat memory (issue #462) ────────────────────
  private chatMemory: ChatMemoryContextService = chatMemoryContextService;

  constructor(
    private store: PipelineStore,
    private scribe: ScribeAgent,
    private proto: ProtoAgent,
    private trace: TraceAgent,
    private getGitHubOwner: (userId: string) => Promise<string>,
    private getGitHubToken: (userId: string) => Promise<string | null>,
    private createGitHubService: (
      token: string
    ) => import('../pipeline-factory.js').GitHubServiceLike,
    private emit?: (event: PipelineEvent) => void,
    private createAgentsForModel?: (
      model: string,
      githubService?: import('../pipeline-factory.js').GitHubServiceLike,
      onTokenUsage?: import('../pipeline-factory.js').TokenUsageCallback
    ) => AgentSet
  ) {}

  /** Inject optional agent activity logger for integrity metrics */
  setActivityLogger(logger: { record(entry: Record<string, unknown>): Promise<void> }): void {
    this.activityLogger = logger;
  }

  /** Inject CriticAgent for Level 3 adversarial review (optional — backward-compatible) */
  setCriticAgent(critic: CriticAgent): void {
    this.criticAgent = critic;
  }

  /**
   * Issue #462 — allow tests / integration harnesses to swap in a stubbed
   * ChatMemoryContextService. Production callers never need this; it's
   * strictly a seam for unit tests that mock retrieval.
   */
  setChatMemoryService(svc: ChatMemoryContextService): void {
    this.chatMemory = svc;
  }

  /**
   * Build the chat-memory + retrieval context block for a pipeline turn
   * (issue #462). Returns the passed-in `existingKnowledgeContext` unchanged
   * when `CHAT_CONTEXT_ENABLED=false` so rollout is a pure flag flip.
   *
   * The returned string is threaded into the agent's existing
   * `knowledgeContext` plumbing — which is already wrapped into the cacheable
   * system prompt prefix via `buildCacheableSystemBlocks` (issue #436).
   * Appending the memory block to the same prefix means subsequent turns
   * benefit from Anthropic's content-hash cache automatically.
   */
  private async applyChatMemory(
    pipeline: {
      id: string;
      scribeConversation?: readonly ScribeMessageType[];
      intermediateState?: Record<string, unknown> | null;
    },
    existingKnowledgeContext: string | undefined,
    query: string,
    opts: { messageIndex?: number } = {}
  ): Promise<string | undefined> {
    let env: ReturnType<typeof getEnv>;
    try {
      env = getEnv();
    } catch {
      // If env parsing fails for any reason, behave as if the flag is off.
      return existingKnowledgeContext?.trim() ? existingKnowledgeContext : undefined;
    }
    if (!env.CHAT_CONTEXT_ENABLED) {
      return existingKnowledgeContext?.trim() ? existingKnowledgeContext : undefined;
    }

    try {
      const { block } = await this.chatMemory.build(pipeline, {
        enabled: true,
        query,
        maxTokens: env.CHAT_CONTEXT_MAX_TOKENS,
        messageIndex: opts.messageIndex,
      });
      if (!block) return existingKnowledgeContext?.trim() ? existingKnowledgeContext : undefined;
      const base = existingKnowledgeContext?.trim() ? existingKnowledgeContext : '';
      return base ? `${block}\n${base}` : block;
    } catch (err) {
      logger.warn(
        { err, pipelineId: pipeline.id },
        '[Pipeline] Chat-memory context build failed (non-fatal)'
      );
      return existingKnowledgeContext?.trim() ? existingKnowledgeContext : undefined;
    }
  }

  /** Read-only accessor for tests — exposes the active chat-memory service. */
  getChatMemoryService(): ChatMemoryContextService {
    return this.chatMemory;
  }

  /** Access the pipeline metrics service for reporting */
  getMetricsService(): PipelineMetricsService {
    return this.metricsService;
  }

  /** Level 4: Access explainability service */
  getExplainability(): ExplainabilityService {
    return this.explainability;
  }

  /**
   * Tier 1.A: Lazily-built RegressionService.
   * Reuses the orchestrator's PipelineStore (for parent lookup) +
   * PipelineMetricsService (for FixLoop run/success signal). The
   * activity-log fallback is intentionally not wired here — we'd need
   * a `listByPipeline` slice that the orchestrator's `activityLogger`
   * does not currently expose. The metrics service path is enough for
   * the rail; the report falls through to "0 runs" gracefully when
   * neither source has data (e.g. iteration child whose parent ran on
   * a previous process where in-memory metrics are gone).
   */
  getRegressionService(): RegressionService {
    if (!this.regressionService) {
      this.regressionService = new RegressionService({
        store: this.store,
        metricsService: this.metricsService,
      });
    }
    return this.regressionService;
  }

  /** Level 4: Access learning service */
  getLearningService(): LearningService {
    return this.learningService;
  }

  /** Log agent activity (non-blocking, best-effort) */
  private logActivity(
    pipelineId: string,
    agent: 'scribe' | 'proto' | 'trace',
    action: string,
    data: Record<string, unknown> = {}
  ): void {
    this.activityLogger
      ?.record({ pipelineId, agent, action, ...data })
      .catch((err) => logger.warn({ err }, '[Pipeline] Non-blocking task failed'));
  }

  /**
   * Persist a reasoning entry without blocking the caller.
   *
   * `addReasoning` is async since PDP-2 Wave 2 (F-03 + F-11 / NFR-1) — it
   * upserts into `pipeline_reasonings`. Most call sites in this orchestrator
   * are inside long-running stage transitions where adding ~5ms of DB latency
   * sequentially would compound; we fire-and-forget and surface failures via
   * the logger instead.
   */
  private persistReasoning(
    pipelineId: string,
    reasoning: import('../explainability/ExplainabilityTypes.js').AgentReasoning
  ): void {
    this.explainability.addReasoning(pipelineId, reasoning).catch((err) => {
      logger.warn(
        { err, pipelineId, agent: reasoning.agentName },
        '[Pipeline] Failed to persist reasoning (cache still hot)'
      );
    });
  }

  /** Level 4: Explainability — Scribe reasoning after spec generation. */
  private recordScribeReasoning(
    pipelineId: string,
    output: import('../contracts/PipelineTypes.js').ScribeOutput,
    regenerated: boolean
  ): void {
    this.persistReasoning(pipelineId, buildScribeReasoning(output, { regenerated }));
  }

  /** Level 4: Explainability — Proto reasoning after scaffold push. */
  private recordProtoReasoning(
    pipelineId: string,
    output: import('../contracts/PipelineTypes.js').ProtoOutput
  ): void {
    this.persistReasoning(pipelineId, buildProtoReasoning(output));
  }

  /** Level 4: Explainability — Trace reasoning after test generation. */
  private recordTraceReasoning(
    pipelineId: string,
    output: import('../contracts/PipelineTypes.js').TraceOutput
  ): void {
    this.persistReasoning(pipelineId, buildTraceReasoning(output));
  }

  /**
   * Serialize operations on the same pipeline — prevents concurrent mutations
   * from corrupting FSM state. Different pipeline IDs run in parallel.
   */
  private async withLock<T>(pipelineId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(pipelineId) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run fn regardless of prev result
    this.locks.set(pipelineId, next);
    try {
      return await next;
    } finally {
      // Clean up if this is still the latest entry (avoid memory leak)
      if (this.locks.get(pipelineId) === next) {
        this.locks.delete(pipelineId);
      }
    }
  }

  private getAgents(model?: string, pipelineId?: string): AgentSet {
    const tokenCb = pipelineId ? this.createTokenCallback(pipelineId) : undefined;
    if (model && this.createAgentsForModel) {
      return this.createAgentsForModel(model, undefined, tokenCb);
    }
    return { scribe: this.scribe, proto: this.proto, trace: this.trace };
  }

  // ─── Start Pipeline ──────────────────────────

  async startPipeline(
    userId: string,
    input: ScribeInput,
    model?: string,
    jiraConfig?: { projectKey: string; enabled: boolean; epicKey?: string },
    parentPipelineId?: string,
    skipScribe?: boolean,
    traceEnabled?: boolean
  ): Promise<PipelineState> {
    const pipeline = await this.store.create(userId);

    const conversation: ScribeMessageType[] = [{ type: 'user_idea', content: input.idea }];

    // Model is locked at pipeline creation. If the caller didn't pass one,
    // fall back to the system default (Haiku 4.5) so the chat still has a
    // concrete model recorded.
    const lockedModel = model ?? DEFAULT_PIPELINE_MODEL;
    const updateData: Partial<PipelineStateUpdate> = {
      title: ideaToTitle(input.idea),
      model: lockedModel,
      modelLockedAt: new Date(),
      traceEnabled: traceEnabled ?? false,
      scribeConversation: conversation,
      metrics: { ...pipeline.metrics, startedAt: new Date() },
    };
    if (jiraConfig) {
      updateData.jiraConfig = jiraConfig;
    }
    // Store existing repo info for pipeline continuation (iterate on same repo)
    if (input.existingRepo) {
      updateData.intermediateState = {
        ...updateData.intermediateState,
        existingRepo: input.existingRepo,
        parentPipelineId,
      };
    }
    // Store attachment context for Scribe knowledge injection
    if (input.attachmentContext) {
      updateData.intermediateState = {
        ...updateData.intermediateState,
        attachmentContext: input.attachmentContext,
      };
    }
    // Persist imageBlocks in intermediateState so Proto/Trace (background
    // stages running after approve) can forward the same screenshots to
    // their multimodal paths. Issue #464 BUG-C.
    if (input.imageBlocks && input.imageBlocks.length > 0) {
      updateData.intermediateState = {
        ...updateData.intermediateState,
        imageBlocks: input.imageBlocks,
      };
    }

    // ─── Iteration Mode: skip Scribe, jump directly to Proto ───
    if (skipScribe && parentPipelineId && input.existingRepo) {
      // Fetch parent pipeline to get the original approved spec
      const parentPipeline = await this.store.getById(parentPipelineId);
      if (parentPipeline?.approvedSpec) {
        updateData.stage = 'proto_building';
        updateData.approvedSpec = parentPipeline.approvedSpec;
        updateData.intermediateState = {
          ...updateData.intermediateState,
          existingRepo: input.existingRepo,
          parentPipelineId,
          iterationRequest: input.idea, // The user's fix/change request
        };
        updateData.metrics = {
          ...updateData.metrics,
          startedAt: new Date(),
          approvedAt: new Date(),
          clarificationRounds: 0,
          retryCount: 0,
        } as PipelineMetrics;

        const updated = await this.store.update(pipeline.id, updateData);
        this.emitEvent(pipeline.id, 'stage_change', 'proto_building');

        // Run Proto+Trace in background with iteration context
        this.runIterationProtoAndTrace(
          pipeline.id,
          updated.metrics!,
          parentPipeline.approvedSpec,
          input.existingRepo,
          input.idea,
          model,
          input.imageBlocks
        )
          .catch((err) => {
            logger.error(
              { err, pipelineId: pipeline.id },
              '[Pipeline] Background iteration Proto+Trace failed'
            );
            this.failPipeline(pipeline.id, 'Proto', err).catch((e) =>
              logger.error({ err: e }, '[Pipeline] failPipeline also failed')
            );
          })
          .finally(() => {
            cleanupPipelineListeners(pipeline.id);
          });

        return updated;
      }
      // If parent spec not found, fall through to normal Scribe flow
      logger.warn(
        { parentPipelineId, pipelineId: pipeline.id },
        '[Pipeline] skipScribe requested but parent spec not found, falling back to Scribe'
      );
    }

    const updated = await this.store.update(pipeline.id, updateData);

    // Run Scribe in background (non-blocking)
    this.runScribeAnalysis(pipeline.id, pipeline.metrics, input, conversation, model).catch(
      (err) => {
        logger.error({ err, pipelineId: pipeline.id }, '[Pipeline] Background Scribe failed');
        this.failPipeline(pipeline.id, 'Scribe', err).catch((e) =>
          logger.error({ err: e }, '[Pipeline] failPipeline also failed')
        );
      }
    );

    return updated;
  }

  // ─── Background Scribe Analysis ───────────────

  private async runScribeAnalysis(
    pipelineId: string,
    metrics: PipelineMetrics,
    input: ScribeInput,
    conversation: ScribeMessageType[],
    model?: string
  ): Promise<void> {
    const emit = createActivityEmitter(pipelineId, 'scribe');
    emit('start', 'Kullanıcı fikri analiz ediliyor...', 5);

    // ─── Repo Context: fetch if existingRepo is set ───
    const pipeline = await this.getPipeline(pipelineId);
    const existingRepo = pipeline.intermediateState?.existingRepo as
      | { owner: string; repo: string; branch?: string }
      | undefined;
    let repoKnowledge = '';

    if (existingRepo) {
      try {
        emit('start', 'Mevcut repo analiz ediliyor...', 10);
        const repoContext = await this.fetchRepoContext(
          pipeline.userId,
          existingRepo.owner,
          existingRepo.repo,
          existingRepo.branch
        );
        // Cache in DB for later use by Proto
        await this.store.update(pipelineId, { repoContext });

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

    const agents = this.getAgents(effectiveModel, pipelineId);
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
    const attachmentContext = (await this.getPipeline(pipelineId)).intermediateState
      ?.attachmentContext as string | undefined;
    if (attachmentContext) {
      scribeState.knowledgeContext =
        (scribeState.knowledgeContext ?? '') + '\n\n' + attachmentContext;
    }

    // Issue #462 — chat-level conversation memory. First turn: no prior
    // anchors yet, but we still record the hit-set at messageIndex=0 so
    // subsequent turns can dedup. When `CHAT_CONTEXT_ENABLED=false` this
    // is a no-op and `scribeState.knowledgeContext` is unchanged.
    const scribeFirstPipeline = await this.getPipeline(pipelineId);
    scribeState.knowledgeContext = await this.applyChatMemory(
      scribeFirstPipeline,
      scribeState.knowledgeContext,
      input.idea,
      { messageIndex: 0 }
    );

    await this.writeCheckpoint(pipelineId, 'scribe', input.idea);
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

    await this.handleScribeResult(pipelineId, metrics, conversation, result);

    if (result.type === 'clarification') {
      emit('clarification', 'Açıklayıcı sorular oluşturuldu', 100);
    } else if (result.type === 'error') {
      emit('error', 'Scribe analizi başarısız oldu', 0);
    }
  }

  // ─── Send Message (Scribe Chat) ──────────────

  async sendMessage(
    pipelineId: string,
    message: string,
    attachmentContext?: string
  ): Promise<PipelineState> {
    return this.withLock(pipelineId, () =>
      this._sendMessage(pipelineId, message, attachmentContext)
    );
  }
  private async _sendMessage(
    pipelineId: string,
    message: string,
    attachmentContext?: string
  ): Promise<PipelineState> {
    const pipeline = await this.getPipeline(pipelineId);

    // Persist new attachment context in intermediateState if provided
    if (attachmentContext) {
      const existingCtx = (pipeline.intermediateState?.attachmentContext as string) ?? '';
      await this.store.update(pipelineId, {
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
      const updated = await this.store.update(pipelineId, {
        scribeConversation: conversation,
      });
      this.emitEvent(pipelineId, 'scribe_message', pipeline.stage);
      return updated;
    }

    // Scribe clarifying flow (unchanged)
    // Guard: prevent unbounded conversation growth (max 20 entries ≈ 10 rounds)
    if (pipeline.scribeConversation.length >= 20) {
      const error = createPipelineError(
        PipelineErrorCode.AI_PROVIDER_ERROR,
        'Maksimum konuşma limiti aşıldı (20 mesaj). Lütfen yeni bir pipeline başlatın.'
      );
      const failed = await this.store.update(pipelineId, { stage: 'failed', error });
      this.emitEvent(pipelineId, 'error', 'failed', error);
      return failed;
    }

    const agents = this.getAgents(pipeline.model);
    const scribeState = this.reconstructScribeState(pipeline);

    // Inject accumulated attachment context into scribe state for this continuation
    const accumulatedCtx = (await this.getPipeline(pipelineId)).intermediateState
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
    const updated = await this.store.update(
      pipelineId,
      {
        scribeConversation: conversation,
        stage: 'scribe_generating',
      },
      { expectedStageVersion: pipeline.stageVersion }
    );
    this.emitEvent(pipelineId, 'stage_change', 'scribe_generating');

    // Run Scribe continuation in background
    this.runScribeContinuation(
      pipelineId,
      pipeline.metrics,
      scribeState,
      conversation,
      pipeline.model
    ).catch((err) => {
      logger.error({ err, pipelineId }, '[Pipeline] Background Scribe continuation failed');
      this.failPipeline(pipelineId, 'Scribe', err).catch((e) =>
        logger.error({ err: e }, '[Pipeline] failPipeline also failed')
      );
    });

    return updated;
  }

  // ─── Background Scribe Continuation ───────────

  private async runScribeContinuation(
    pipelineId: string,
    metrics: PipelineMetrics,
    scribeState: ScribeState,
    conversation: ScribeMessageType[],
    model?: string
  ): Promise<void> {
    const emit = createActivityEmitter(pipelineId, 'scribe');
    emit('start', 'Kullanıcı yanıtıyla devam ediliyor...', 10);
    scribeState.pipelineId = pipelineId;

    const agents = this.getAgents(model);

    // Issue #462 — inject prior-turn memory for the continuation call. The
    // query is the most recent user answer in the conversation (latest
    // user-side message). `conversation.length` doubles as the message
    // index so anchors are written one-per-turn.
    const latestUserMsg = [...conversation]
      .reverse()
      .find((m) => m.type === 'user_answer' || m.type === 'user_note' || m.type === 'user_idea');
    const continuationQuery =
      typeof latestUserMsg?.content === 'string' ? latestUserMsg.content : '';
    const pipelineForMemory = await this.getPipeline(pipelineId);
    scribeState.knowledgeContext = await this.applyChatMemory(
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

    await this.handleScribeResult(
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

  // ─── Approve Spec → Proto → Trace ───────────

  async approveSpec(
    pipelineId: string,
    repoName: string,
    repoVisibility: 'public' | 'private',
    editedSpec?: StructuredSpec,
    jiraConfig?: { projectKey: string; enabled: boolean; epicKey?: string },
    cucumberEnabled?: boolean
  ): Promise<PipelineState> {
    return this.withLock(pipelineId, () =>
      this._approveSpec(
        pipelineId,
        repoName,
        repoVisibility,
        editedSpec,
        jiraConfig,
        cucumberEnabled
      )
    );
  }
  private async _approveSpec(
    pipelineId: string,
    repoName: string,
    repoVisibility: 'public' | 'private',
    editedSpec?: StructuredSpec,
    jiraConfig?: { projectKey: string; enabled: boolean; epicKey?: string },
    cucumberEnabled?: boolean
  ): Promise<PipelineState> {
    const pipeline = await this.getPipeline(pipelineId);

    // Idempotency guard (#488 BUG-L): when the same chat is open in two tabs,
    // the second tab often still shows the Onayla button after the first tab
    // already approved. Re-approving a pipeline that has already advanced past
    // awaiting_approval is a no-op — return the current state so the stale tab
    // transparently syncs instead of surfacing a scary INVALID_STAGE toast.
    // Only short-circuit when approvedSpec is already persisted, so an empty
    // mis-routed POST still hits the assertStage guard below.
    const alreadyApprovedStages: readonly PipelineStage[] = [
      'proto_building',
      'trace_testing',
      'completed',
      'completed_partial',
    ];
    if (alreadyApprovedStages.includes(pipeline.stage) && pipeline.approvedSpec) {
      logger.info(
        { pipelineId, stage: pipeline.stage },
        '[Pipeline] approveSpec idempotent hit — pipeline already advanced, returning current state'
      );
      return pipeline;
    }

    this.assertStage(pipeline, 'awaiting_approval');

    if (!editedSpec && !pipeline.scribeOutput?.spec) {
      throw new Error('Cannot approve: no spec available (scribeOutput is missing)');
    }
    const spec = editedSpec ?? pipeline.scribeOutput!.spec;

    // Pipeline continuation: if existingRepo was set during startPipeline,
    // use the existing repo name/owner instead of creating a new one.
    const existingRepo = pipeline.intermediateState?.existingRepo as
      | { owner: string; repo: string; branch: string }
      | undefined;
    const effectiveRepoName = existingRepo?.repo ?? repoName;

    // Resolve per-user GitHub token and owner, validate token is still valid
    let owner: string;
    let userGitHubToken: string;
    try {
      const gh = await this.validateGitHubAccess(pipeline.userId);
      userGitHubToken = gh.token;
      owner = existingRepo?.owner ?? gh.owner;
    } catch (err) {
      const error = createPipelineError(
        PipelineErrorCode.GITHUB_NOT_CONNECTED,
        `GitHub owner çözümlenemedi: ${err instanceof Error ? err.message : String(err)}`
      );
      const failed = await this.store.update(pipelineId, { stage: 'failed', error });
      this.emitEvent(pipelineId, 'error', 'failed', error);
      return failed;
    }

    const conversation: ScribeMessageType[] = [
      ...pipeline.scribeConversation,
      { type: 'spec_approved', content: spec },
    ];

    // Transition to proto_building — return immediately (optimistic lock)
    const approveUpdate: Partial<PipelineStateUpdate> = {
      stage: 'proto_building',
      approvedSpec: spec,
      protoConfig: { repoName: effectiveRepoName, repoVisibility },
      scribeConversation: conversation,
      metrics: { ...pipeline.metrics, approvedAt: new Date() },
      error: null,
    };
    if (jiraConfig) {
      approveUpdate.jiraConfig = jiraConfig;
    }
    if (cucumberEnabled != null) {
      approveUpdate.intermediateState = { ...approveUpdate.intermediateState, cucumberEnabled };
    }
    const updated = await this.store.update(pipelineId, approveUpdate, {
      expectedStageVersion: pipeline.stageVersion,
    });
    this.emitEvent(pipelineId, 'stage_change', 'proto_building');

    // Create per-user GitHub adapter and run Proto + Trace in background
    const userGithubService = this.createGitHubService(userGitHubToken);
    this.runProtoAndTrace(
      pipelineId,
      pipeline.metrics,
      spec,
      effectiveRepoName,
      repoVisibility,
      owner,
      pipeline.model,
      userGithubService
    ).catch((err) => {
      logger.error({ err, pipelineId }, '[Pipeline] Background Proto+Trace failed');
      this.failPipeline(pipelineId, 'Proto/Trace', err).catch((e) =>
        logger.error({ err: e }, '[Pipeline] failPipeline also failed')
      );
    });

    return updated;
  }

  // ─── Iteration Mode: Proto reads existing code and modifies ────────

  private async runIterationProtoAndTrace(
    pipelineId: string,
    metrics: PipelineMetrics,
    originalSpec: StructuredSpec,
    existingRepo: { owner: string; repo: string; branch: string },
    iterationRequest: string,
    model?: string,
    imageBlocks?: readonly import('../../../services/ai/multimodalClient.js').AnthropicImageBlock[]
  ): Promise<void> {
    const protoEmit = createActivityEmitter(pipelineId, 'proto');
    protoEmit('start', 'Mevcut kod okunuyor...', 5);
    logger.info(
      { pipelineId, imageCount: imageBlocks?.length ?? 0 },
      '[Pipeline] Iteration Proto dispatch'
    );

    // Resolve GitHub access
    const pipeline = await this.getPipeline(pipelineId);
    let userGitHubToken: string;
    try {
      const gh = await this.validateGitHubAccess(pipeline.userId);
      userGitHubToken = gh.token;
    } catch (err) {
      const error = createPipelineError(
        PipelineErrorCode.GITHUB_NOT_CONNECTED,
        `GitHub bağlantısı bulunamadı: ${err instanceof Error ? err.message : String(err)}`
      );
      await this.store.update(pipelineId, { stage: 'failed', error });
      this.emitEvent(pipelineId, 'error', 'failed', error);
      return;
    }

    // Read existing files from GitHub
    const userGithubService = this.createGitHubService(userGitHubToken);
    let existingFiles: Array<{ path: string; content: string }> = [];
    try {
      protoEmit(
        'progress',
        `${existingRepo.owner}/${existingRepo.repo} deposundan dosyalar okunuyor...`,
        15
      );
      existingFiles = await this.readRepoFiles(
        userGithubService,
        existingRepo.owner,
        existingRepo.repo,
        existingRepo.branch
      );
      protoEmit(
        'progress',
        `${existingFiles.length} dosya okundu, değişiklikler uygulanıyor...`,
        25
      );
    } catch (err) {
      logger.warn(
        { err, pipelineId },
        '[Pipeline] Failed to read existing files, Proto will build from scratch'
      );
      protoEmit('progress', 'Mevcut dosyalar okunamadı, sıfırdan oluşturuluyor...', 25);
    }

    const protoModel = model ?? 'claude-sonnet-4-6'; // Use stronger model for iterations
    const tokenCb = this.createTokenCallback(pipelineId);
    const agents = userGithubService
      ? (this.createAgentsForModel?.(protoModel, userGithubService, tokenCb) ??
        this.getAgents(protoModel, pipelineId))
      : this.getAgents(protoModel, pipelineId);

    await this.writeCheckpoint(pipelineId, 'proto', `İterasyon: ${iterationRequest.slice(0, 80)}`);
    const iterationKnowledgeRaw = buildUnifiedAgentKnowledgeContext(pipeline, { role: 'proto' });
    const iterationKnowledgeBase = iterationKnowledgeRaw.trim() ? iterationKnowledgeRaw : undefined;
    // Issue #462 — prepend chat-memory + anchor-dedup retrieval for this
    // iteration turn. Uses `resolveChatId` under the hood, so the memory
    // scope is the PARENT pipeline id (root chat) — matches the anchor
    // store's collapse rule.
    const iterationKnowledge = await this.applyChatMemory(
      pipeline,
      iterationKnowledgeBase,
      iterationRequest,
      { messageIndex: (pipeline.scribeConversation?.length ?? 0) + 1 }
    );
    const protoResult = await withRetry(
      (attempt) => {
        if (attempt > 1) protoEmit('retry', `Proto yeniden deneniyor (deneme ${attempt})...`, 30);
        return withTimeout(
          agents.proto.execute({
            spec: originalSpec,
            repoName: existingRepo.repo,
            repoVisibility: 'private',
            owner: existingRepo.owner,
            pipelineId,
            iterationRequest,
            existingFiles,
            knowledgeContext: iterationKnowledge,
            imageBlocks: imageBlocks && imageBlocks.length > 0 ? imageBlocks : undefined,
          }),
          STAGE_TIMEOUT,
          'Proto'
        );
      },
      {
        maxAttempts: 3,
        onError: (err, attempt) =>
          logger.warn({ err, attempt }, '[Pipeline] Iteration Proto attempt failed'),
      }
    );

    if (await this.isCancelled(pipelineId)) return;

    if (protoResult.type === 'error') {
      await this.store.update(pipelineId, { stage: 'failed', error: protoResult.error });
      this.emitEvent(pipelineId, 'error', 'failed', protoResult.error);
      return;
    }

    const protoCompletedMetrics = { ...metrics, protoCompletedAt: new Date() };
    this.logActivity(pipelineId, 'proto', 'iteration_applied', {
      filesGenerated: protoResult.data.files?.length ?? 0,
      iterationRequest: iterationRequest.slice(0, 200),
    });

    // For iterations, skip Trace by default (direct fix) → completed
    await this.store.update(pipelineId, {
      protoOutput: protoResult.data,
      stage: 'completed',
      metrics: {
        ...protoCompletedMetrics,
        traceCompletedAt: new Date(),
        totalDurationMs: Date.now() - toEpoch(protoCompletedMetrics.startedAt),
      },
    });
    this.emitEvent(pipelineId, 'stage_change', 'completed');

    // Knowledge ingestion handled by caller if needed
  }

  /** Read source files from a GitHub repo (for iteration mode) */
  private async readRepoFiles(
    githubService: import('../pipeline-factory.js').GitHubServiceLike,
    owner: string,
    repo: string,
    branch: string
  ): Promise<Array<{ path: string; content: string }>> {
    const filePaths = await githubService.listFiles(owner, repo, branch);
    if (!filePaths?.length) return [];

    // Filter to source files only (skip node_modules, .git, images, etc.)
    const sourceExtensions = [
      '.html',
      '.css',
      '.js',
      '.ts',
      '.tsx',
      '.jsx',
      '.json',
      '.md',
      '.py',
      '.rb',
      '.go',
      '.rs',
      '.vue',
      '.svelte',
    ];
    const ignorePaths = [
      'node_modules/',
      '.git/',
      'dist/',
      'build/',
      '.next/',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
    ];
    const sourceFiles = filePaths.filter(
      (p: string) =>
        sourceExtensions.some((ext) => p.endsWith(ext)) &&
        !ignorePaths.some((ignore) => p.includes(ignore))
    );

    // Read up to 30 files (context limit)
    const filesToRead = sourceFiles.slice(0, 30);
    const results: Array<{ path: string; content: string }> = [];

    for (const filePath of filesToRead) {
      try {
        const content = await githubService.getFileContent(owner, repo, branch, filePath);
        if (content) results.push({ path: filePath, content });
      } catch {
        // Skip unreadable files
      }
    }

    return results;
  }

  /** Inject optional AI service for RepoContextAgent */
  private aiService?: import('../pipeline-factory.js').AIServiceLike;
  setAIService(aiService: import('../pipeline-factory.js').AIServiceLike): void {
    this.aiService = aiService;
  }

  /** Fetch repo context using RepoContextAgent with per-user GitHub token. */
  private async fetchRepoContext(
    userId: string,
    owner: string,
    repo: string,
    branch?: string
  ): Promise<import('../../agents/repo-context/RepoContextTypes.js').RepoContext> {
    const { token } = await this.validateGitHubAccess(userId);
    const githubService = this.createGitHubService(token);
    const { createRepoContextAgent } = await import('../pipeline-factory.js');

    if (!this.aiService) {
      throw new Error('AI service not configured for RepoContextAgent');
    }

    const agent = createRepoContextAgent(this.aiService, githubService, 'claude-haiku-4-5');
    return agent.fetchContext({ owner, repo, branch });
  }

  // ─── Background Proto + Trace Runner ────────

  private async runProtoAndTrace(
    pipelineId: string,
    metrics: PipelineMetrics,
    spec: StructuredSpec,
    repoName: string,
    repoVisibility: 'public' | 'private',
    owner: string,
    model?: string,
    userGithubService?: import('../pipeline-factory.js').GitHubServiceLike
  ): Promise<void> {
    const protoEmit = createActivityEmitter(pipelineId, 'proto');
    protoEmit('start', 'Onaylanan spec okunuyor...', 5);

    // Effort-based model routing for Proto
    const protoEffort = scoreProtoEffort(spec);
    const protoModel = model ?? protoEffort.model;
    logger.info(
      `[Proto] Effort: ${protoEffort.score}/10 → Model: ${protoModel} (${protoEffort.reasoning})`
    );

    // Use per-user GitHub adapter if available, otherwise default agents
    const tokenCbProto = this.createTokenCallback(pipelineId);
    const agents = userGithubService
      ? (this.createAgentsForModel?.(protoModel, userGithubService, tokenCbProto) ??
        this.getAgents(protoModel, pipelineId))
      : this.getAgents(protoModel, pipelineId);
    // Unified pipeline chat + GitHub/repo signals (Cursor-like single context bundle)
    const pipelineData = await this.getPipeline(pipelineId);
    const protoKnowledgeRaw = buildUnifiedAgentKnowledgeContext(pipelineData, { role: 'proto' });
    const protoKnowledgeBase = protoKnowledgeRaw.trim() ? protoKnowledgeRaw : undefined;
    // Issue #462 — prepend chat-level conversation memory for the Proto
    // turn. Uses the approved spec title as the retrieval query (best
    // signal for "what is this chat about?" at the Proto phase).
    const protoKnowledge = await this.applyChatMemory(
      pipelineData,
      protoKnowledgeBase,
      spec.title,
      { messageIndex: (pipelineData.scribeConversation?.length ?? 0) + 1 }
    );
    // Issue #464 BUG-C — pull persisted imageBlocks from intermediateState
    // so downstream Proto + Trace calls can see the same screenshots Scribe saw.
    const pipelineImageBlocks = readPipelineImageBlocks(pipelineData.intermediateState);

    await this.writeCheckpoint(pipelineId, 'proto', spec.title);
    const protoResult = await withRetry(
      (attempt) => {
        if (attempt > 1) protoEmit('retry', `Proto yeniden deneniyor (deneme ${attempt})...`, 25);
        return withTimeout(
          agents.proto.execute({
            spec,
            repoName,
            repoVisibility,
            owner,
            pipelineId,
            knowledgeContext: protoKnowledge,
            imageBlocks: pipelineImageBlocks,
          }),
          STAGE_TIMEOUT,
          'Proto'
        );
      },
      {
        maxAttempts: 3,
        onError: (err, attempt) =>
          logger.warn({ err, attempt }, '[Pipeline] Proto execute attempt failed'),
      }
    );

    // Abort if pipeline was cancelled during Proto execution
    if (await this.isCancelled(pipelineId)) return;

    if (protoResult.type === 'error') {
      await this.store.update(pipelineId, {
        stage: 'failed',
        error: protoResult.error,
      });
      this.emitEvent(pipelineId, 'error', 'failed', protoResult.error);
      return;
    }

    const protoCompletedMetrics = {
      ...metrics,
      approvedAt: metrics.approvedAt ?? new Date(),
      protoCompletedAt: new Date(),
    };

    // Log Proto activity for integrity metrics
    this.logActivity(pipelineId, 'proto', 'scaffold_generated', {
      filesGenerated: protoResult.data.files?.length ?? 0,
      specCompliance: 0.85, // Proto succeeded → base compliance
    });

    const pipeline = await this.getPipeline(pipelineId);

    if (!pipeline.traceEnabled) {
      // User explicitly disabled Trace — skip and mark completed.
      await this.store.update(pipelineId, {
        protoOutput: protoResult.data,
        stage: 'completed',
        metrics: {
          ...protoCompletedMetrics,
          traceCompletedAt: new Date(),
          totalDurationMs: Date.now() - toEpoch(protoCompletedMetrics.startedAt),
        },
      });
      this.emitEvent(pipelineId, 'stage_change', 'completed');
      return;
    }

    // If Scribe's plan said requiresTests=false but the user enabled Trace, proceed
    // anyway — user intent wins. Emit a warning activity so it's visible in the chat.
    const requiresTests = pipeline.scribeOutput?.plan?.requiresTests ?? true;
    if (!requiresTests) {
      this.logActivity(pipelineId, 'trace', 'proceeding_without_plan', {
        message: "Plan testleri zorunlu kılmadı ama kullanıcı Trace'i açtı, devam ediliyor",
      });
      const traceEmit = createActivityEmitter(pipelineId, 'trace');
      traceEmit(
        'proceeding_without_plan',
        "Plan testleri zorunlu kılmadı ama kullanıcı Trace'i açtı, devam ediliyor",
        undefined,
        undefined,
        undefined,
        'pipeline.trace.proceedingWithoutPlan'
      );
    }

    // ─── Level 4: Deterministic Validator (before CriticCode) ───
    if (protoResult.data.files && protoResult.data.files.length > 0) {
      // F-08: ScaffoldEnricher adds portability files (install.sh, Dockerfile,
      // docker-compose.yml, .env.example) that aren't source code. Validators
      // only know typescript/javascript/json/html/css; sending unrelated files
      // through the JS brace-balance check produces false-positive errors.
      // Only forward files whose extension maps to a real source language.
      const isValidatableLang = (path: string): 'typescript' | 'javascript' | 'json' | 'html' | 'css' | null => {
        if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
        if (path.endsWith('.js') || path.endsWith('.jsx') || path.endsWith('.mjs') || path.endsWith('.cjs')) return 'javascript';
        if (path.endsWith('.json')) return 'json';
        if (path.endsWith('.html') || path.endsWith('.htm')) return 'html';
        if (path.endsWith('.css')) return 'css';
        return null;
      };
      const validationInput = {
        files: protoResult.data.files
          .map((f) => {
            const lang = isValidatableLang(f.filePath);
            return lang ? { path: f.filePath, content: f.content, language: lang } : null;
          })
          .filter((f): f is { path: string; content: string; language: 'typescript' | 'javascript' | 'json' | 'html' | 'css' } => f !== null),
        spec,
      };

      const validationResult = this.validator.validate(validationInput);
      logger.info(
        {
          pipelineId,
          passed: validationResult.passed,
          score: validationResult.score,
          errors: validationResult.summary.errors,
          warnings: validationResult.summary.warnings,
        },
        '[Pipeline] Level 4: Deterministic validation completed'
      );

      // Store validation result
      const currentStateForValidation = await this.store.getById(pipelineId);
      await this.store.update(pipelineId, {
        intermediateState: {
          ...(currentStateForValidation?.intermediateState ?? {}),
          validationResult: {
            passed: validationResult.passed,
            score: validationResult.score,
            summary: validationResult.summary,
          },
        },
      });

      // Add explainability reasoning
      this.persistReasoning(pipelineId, {
        agentName: 'validator',
        timestamp: new Date(),
        decision: validationResult.passed ? 'Kod dogrulama basarili' : 'Kod dogrulama basarisiz',
        reasoning: [
          `Skor: ${validationResult.score}/100`,
          `${validationResult.summary.errors} hata, ${validationResult.summary.warnings} uyari`,
        ],
        assumptions: ['Deterministic kontroller yeterli'],
        confidence: { score: validationResult.score, factors: validationResult.summary.checksRun },
      });

      // If validator found errors → fail early (save LLM tokens)
      if (!validationResult.passed && validationResult.summary.errors > 0) {
        logger.warn(
          { pipelineId, score: validationResult.score },
          '[Pipeline] Validator caught errors — failing before Critic'
        );
        await this.store.update(pipelineId, {
          stage: 'failed',
          protoOutput: protoResult.data,
          error: {
            code: 'VALIDATION_FAILED',
            message: `Deterministic validation failed: ${validationResult.summary.errors} error(s) found (score: ${validationResult.score}/100)`,
            retryable: true,
            recoveryAction: 'retry',
          },
        });
        this.emitEvent(pipelineId, 'error', 'failed');
        return;
      }
    }

    // ─── Level 3: CriticAgent code review (if available) ───
    if (this.criticAgent) {
      this.metricsService.startStage(pipelineId, 'critic_code');
      await this.store.update(pipelineId, {
        protoOutput: protoResult.data,
        stage: 'critic_reviewing_code',
        metrics: protoCompletedMetrics,
      });
      this.emitEvent(pipelineId, 'stage_change', 'critic_reviewing_code');

      const criticCodeEmit = createActivityEmitter(pipelineId, 'critic');
      criticCodeEmit(
        'start',
        'Üretilen kod inceleniyor (adversarial review)...',
        10,
        undefined,
        undefined,
        'pipeline.critic.code.start'
      );

      const ideaMsg = pipeline.scribeConversation.find((m) => m.type === 'user_idea');
      const originalIdea = typeof ideaMsg?.content === 'string' ? ideaMsg.content : '';
      const criticResult = await this.runCriticCodeReview(
        pipelineId,
        protoResult.data,
        spec,
        originalIdea
      );

      if (criticResult) {
        criticCodeEmit(
          criticResult.approved ? 'approved' : 'rejected',
          criticResult.approved
            ? `Kod incelemesi tamamlandı: ${criticResult.overallScore}/100 puan`
            : `Kod incelemesi: ${criticResult.findings?.length ?? 0} bulgu raporlandı`,
          100,
          criticResult.summary,
          undefined,
          'pipeline.critic.code.done',
          {
            decision: criticResult.approved ? 'Kod onaylandı' : 'Kod reddedildi',
            snippet: criticResult.summary,
            confidence: criticResult.overallScore ?? 0,
          }
        );
      }

      this.metricsService.endStage(pipelineId, 'critic_code', criticResult?.approved ?? true, {
        overallScore: criticResult?.overallScore ?? 0,
        findingsCount: criticResult?.findings?.length ?? 0,
        approved: criticResult?.approved ?? true,
      });

      if (criticResult) {
        const currentState = await this.store.getById(pipelineId);
        const existingIntermediate = (currentState?.intermediateState ?? {}) as Record<
          string,
          unknown
        >;
        await this.store.update(pipelineId, {
          intermediateState: { ...existingIntermediate, criticCodeOutput: criticResult },
        });

        // Level 4: Explainability — record critic-code reasoning
        this.persistReasoning(
          pipelineId,
          buildCriticReasoning(criticResult, { reviewType: 'code' })
        );
      }
      logger.info(
        { pipelineId, approved: criticResult?.approved, score: criticResult?.overallScore },
        '[Pipeline] Critic code review completed'
      );
    }

    // Level 4: Explainability — record Proto reasoning
    this.recordProtoReasoning(pipelineId, protoResult.data);

    // Proto succeeded → transition to trace_testing
    await this.store.update(pipelineId, {
      protoOutput: protoResult.data,
      stage: 'trace_testing',
      metrics: protoCompletedMetrics,
    });
    this.emitEvent(pipelineId, 'stage_change', 'trace_testing');

    // Jira hook: comment Proto result (non-blocking)
    if (pipeline.jiraConfig?.epicKey) {
      this.runJiraProtoComment(pipeline.userId, pipeline.jiraConfig.epicKey, {
        branch: protoResult.data.branch,
        repo: protoResult.data.repo,
        prUrl: protoResult.data.prUrl,
        filesCreated: protoResult.data.metadata.filesCreated,
      }).catch((err) => logger.warn({ err }, '[Pipeline] Non-blocking task failed'));
    }

    // Abort if pipeline was cancelled before Trace starts
    if (await this.isCancelled(pipelineId)) return;

    // Run Trace
    await this.runTrace(pipelineId, metrics, owner, repoName, protoResult.data.branch, spec, model);
  }

  // ─── Reject Spec ─────────────────────────────

  async rejectSpec(pipelineId: string, feedback: string): Promise<PipelineState> {
    return this.withLock(pipelineId, () => this._rejectSpec(pipelineId, feedback));
  }
  private async _rejectSpec(pipelineId: string, feedback: string): Promise<PipelineState> {
    const pipeline = await this.getPipeline(pipelineId);
    this.assertStage(pipeline, 'awaiting_approval');

    const scribeState = this.reconstructScribeState(pipeline);
    const conversation: ScribeMessageType[] = [
      ...pipeline.scribeConversation,
      { type: 'spec_rejected', content: { feedback } },
    ];

    await this.store.update(
      pipelineId,
      {
        stage: 'scribe_generating',
        scribeConversation: conversation,
        error: null,
      },
      { expectedStageVersion: pipeline.stageVersion }
    );

    const agents = this.getAgents(pipeline.model);
    const result = await withTimeout(
      agents.scribe.regenerateSpec(scribeState, feedback),
      STAGE_TIMEOUT,
      'Scribe'
    );

    if (result.type === 'spec') {
      conversation.push({ type: 'spec_draft', content: result.data });
      const updated = await this.store.update(pipelineId, {
        stage: 'awaiting_approval',
        scribeConversation: conversation,
        scribeOutput: result.data,
        title: result.data.spec.title,
      });
      this.emitEvent(pipelineId, 'stage_change', 'awaiting_approval', result.data);
      // Log Scribe activity for integrity metrics
      this.logActivity(pipelineId, 'scribe', 'spec_generated', {
        confidence: result.data.confidence,
        specCompliance: result.data.confidence, // use confidence as spec compliance proxy
        assumptions: result.data.assumptions,
      });
      this.recordScribeReasoning(pipelineId, result.data, /* regenerated */ true);
      return updated;
    }

    if (result.type === 'error') {
      const updated = await this.store.update(pipelineId, {
        stage: 'failed',
        scribeConversation: conversation,
        error: result.error,
      });
      this.emitEvent(pipelineId, 'error', 'failed', result.error);
      return updated;
    }

    return pipeline;
  }

  // ─── Retry ───────────────────────────────────

  async retryStage(pipelineId: string): Promise<PipelineState> {
    return this.withLock(pipelineId, () => this._retryStage(pipelineId));
  }
  private async _retryStage(pipelineId: string): Promise<PipelineState> {
    const pipeline = await this.getPipeline(pipelineId);
    this.assertStage(pipeline, 'failed');

    // Guard: max 5 manual retries per pipeline to prevent API cost runaway
    const MAX_MANUAL_RETRIES = 5;
    if (pipeline.metrics.retryCount >= MAX_MANUAL_RETRIES) {
      throw Object.assign(
        new Error(
          `Maksimum tekrar deneme limiti aşıldı (${MAX_MANUAL_RETRIES}). Lütfen yeni bir pipeline başlatın.`
        ),
        { statusCode: 429 }
      );
    }

    const updated = await this.store.update(pipelineId, {
      error: null,
      metrics: { ...pipeline.metrics, retryCount: pipeline.metrics.retryCount + 1 },
    });

    // Determine which stage failed based on existing data
    if (pipeline.protoOutput && !pipeline.traceOutput) {
      this.retryTrace(pipelineId, pipeline).catch((err) => {
        logger.error({ err, pipelineId }, '[Pipeline] Retry trace failed');
      });
      return updated;
    }
    if (pipeline.approvedSpec && !pipeline.protoOutput) {
      this.retryProto(pipelineId, pipeline).catch((err) => {
        logger.error({ err, pipelineId }, '[Pipeline] Retry proto failed');
      });
      return updated;
    }
    return this.retryScribe(pipelineId, pipeline);
  }

  // ─── Cancel ──────────────────────────────────

  async cancelPipeline(pipelineId: string): Promise<PipelineState> {
    return this.withLock(pipelineId, () => this._cancelPipeline(pipelineId));
  }
  private async _cancelPipeline(pipelineId: string): Promise<PipelineState> {
    const pipeline = await this.getPipeline(pipelineId);
    // Already cancelled — return as-is
    if (pipeline.stage === 'cancelled') return pipeline;
    // Any stage can be cancelled (including completed — acts as "delete from view")
    const updated = await this.store.update(
      pipelineId,
      { stage: 'cancelled' },
      { expectedStageVersion: pipeline.stageVersion }
    );
    this.emitEvent(pipelineId, 'stage_change', 'cancelled');
    return updated;
  }

  // ─── Skip Trace ──────────────────────────────

  async skipTrace(pipelineId: string): Promise<PipelineState> {
    return this.withLock(pipelineId, () => this._skipTrace(pipelineId));
  }
  private async _skipTrace(pipelineId: string): Promise<PipelineState> {
    const pipeline = await this.getPipeline(pipelineId);

    // Allow skip from trace_testing OR failed — but only if Proto already succeeded
    const isTraceFailure = pipeline.stage === 'failed' && pipeline.protoOutput != null;
    if (pipeline.stage !== 'trace_testing' && !isTraceFailure) {
      throw new Error(`Cannot skip trace in stage: ${pipeline.stage}`);
    }
    const updated = await this.store.update(
      pipelineId,
      {
        stage: 'completed_partial',
        metrics: {
          ...pipeline.metrics,
          totalDurationMs: Date.now() - toEpoch(pipeline.metrics.startedAt),
        },
      },
      { expectedStageVersion: pipeline.stageVersion }
    );
    this.emitEvent(pipelineId, 'completed', 'completed_partial');
    return updated;
  }

  // ─── Toggle Trace ───────────────────────────

  async toggleTrace(pipelineId: string, enabled: boolean): Promise<PipelineState> {
    return this.withLock(pipelineId, () => this._toggleTrace(pipelineId, enabled));
  }
  private async _toggleTrace(pipelineId: string, enabled: boolean): Promise<PipelineState> {
    const pipeline = await this.getPipeline(pipelineId);

    // Only allow toggling before trace stage has started
    const terminalOrTraceStages: PipelineStage[] = [
      'trace_testing',
      'completed',
      'completed_partial',
      'failed',
      'cancelled',
    ];
    if (terminalOrTraceStages.includes(pipeline.stage)) {
      throw new InvalidStageError('pre-trace stage', pipeline.stage);
    }

    return this.store.update(pipelineId, { traceEnabled: enabled });
  }

  // ─── Level 4: Adaptive Autonomy Config ───────

  /** Update pipeline-level configuration (auto-approve, thresholds, etc.) */
  async updatePipelineConfig(
    pipelineId: string,
    config: Record<string, unknown>
  ): Promise<PipelineState> {
    await this.getPipeline(pipelineId);
    const update: Partial<PipelineStateUpdate> = {};
    if ('autoApproveEnabled' in config && typeof config.autoApproveEnabled === 'boolean') {
      update.autoApproveEnabled = config.autoApproveEnabled;
    }
    if ('autoApproveThreshold' in config && typeof config.autoApproveThreshold === 'number') {
      update.autoApproveThreshold = config.autoApproveThreshold;
    }
    return this.store.update(pipelineId, update);
  }

  // ─── Query ───────────────────────────────────

  async getStatus(pipelineId: string): Promise<PipelineState> {
    return this.getPipeline(pipelineId);
  }

  /**
   * Default pipeline list for the chat sidebar. Filters out iteration children
   * (see issue #388 / BUG-08) so the sidebar shows one entry per root chat.
   * If the store does not implement {@link PipelineStore.listRootsByUser}, falls
   * back to the unfiltered list for backward compatibility with mock stores.
   */
  async listPipelines(userId: string): Promise<PipelineState[]> {
    if (this.store.listRootsByUser) {
      return this.store.listRootsByUser(userId);
    }
    return this.store.listByUser(userId);
  }

  /** List all pipelines for a user including iteration children (admin/internal use). */
  async listAllPipelines(userId: string): Promise<PipelineState[]> {
    return this.store.listByUser(userId);
  }

  /**
   * Return the iteration child pipelines of a given parent (ordered oldest-first).
   * Returns [] if the store does not implement {@link PipelineStore.listChildrenOf}
   * or the parent has no iterations yet.
   */
  async listChildren(parentPipelineId: string): Promise<PipelineState[]> {
    if (this.store.listChildrenOf) {
      return this.store.listChildrenOf(parentPipelineId);
    }
    return [];
  }

  async updateTitle(pipelineId: string, userId: string, title: string): Promise<PipelineState> {
    const pipeline = await this.getPipeline(pipelineId);
    if (pipeline.userId !== userId) {
      throw new Error('UNAUTHORIZED');
    }
    return this.store.update(pipelineId, { title });
  }

  /**
   * Persist the per-chat model selection (issue #437). The dropdown calls
   * this between turns so the next Scribe continuation / Proto retry /
   * iteration child picks up the new model via `pipeline.model`.
   *
   * Allowlist + provider compatibility are validated at the route layer
   * before we get here, so this method is intentionally minimal.
   */
  async setModel(pipelineId: string, userId: string, model: string): Promise<PipelineState> {
    const pipeline = await this.getPipeline(pipelineId);
    if (pipeline.userId !== userId) {
      throw new Error('UNAUTHORIZED');
    }

    // Model lock (PR-A Commit 5). Pipelines created from PR-A onward are
    // locked at creation. The only legitimate setModel callers are migrated
    // pre-PR-A pipelines whose model was nulled by migration 0046 — those
    // get exactly one transitional set, which also stamps the lock.
    if (pipeline.modelLockedAt !== null && pipeline.modelLockedAt !== undefined) {
      throw Object.assign(
        new Error('Bu sohbetin modeli sabit. Yeni model seçmek için yeni sohbet açın.'),
        { statusCode: 409, code: 'MODEL_LOCKED' as const }
      );
    }

    return this.store.update(pipelineId, { model, modelLockedAt: new Date() });
  }

  // ─── Private: Scribe Result Handler ──────────

  private async handleScribeResult(
    pipelineId: string,
    metrics: PipelineMetrics,
    conversation: ScribeMessageType[],
    result: ScribeResult,
    clarificationRound?: number
  ): Promise<PipelineState> {
    if (result.type === 'clarification') {
      conversation.push({ type: 'clarification', content: result.data });
      const updated = await this.store.update(pipelineId, {
        stage: 'scribe_clarifying',
        scribeConversation: conversation,
        metrics: {
          ...metrics,
          clarificationRounds: clarificationRound ?? metrics.clarificationRounds + 1,
        },
      });
      this.emitEvent(pipelineId, 'scribe_message', 'scribe_clarifying', result.data);
      return updated;
    }

    if (result.type === 'spec') {
      conversation.push({ type: 'spec_draft', content: result.data });
      const pipelineForJira = await this.store.getById(pipelineId);

      this.recordScribeReasoning(pipelineId, result.data, /* regenerated */ false);

      // ─── Level 3: CriticAgent spec review (if available) ───
      if (this.criticAgent) {
        this.metricsService.startStage(pipelineId, 'critic_spec');
        await this.store.update(pipelineId, {
          stage: 'critic_reviewing_spec',
          scribeConversation: conversation,
          scribeOutput: result.data,
          title: result.data.spec.title,
          metrics: { ...metrics, scribeCompletedAt: new Date() },
        });
        this.emitEvent(pipelineId, 'stage_change', 'critic_reviewing_spec');

        const criticSpecEmit = createActivityEmitter(pipelineId, 'critic');
        criticSpecEmit(
          'start',
          'Spesifikasyon inceleniyor (adversarial review)...',
          10,
          undefined,
          undefined,
          'pipeline.critic.spec.start'
        );

        const ideaMsg = conversation.find((m) => m.type === 'user_idea');
        const originalIdea = typeof ideaMsg?.content === 'string' ? ideaMsg.content : '';
        const criticResult = await this.runCriticSpecReview(
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
              decision: criticResult.approved ? 'Spec onaylandı' : 'Spec reddedildi',
              snippet: criticResult.summary,
              confidence: criticResult.overallScore ?? 0,
            }
          );
        }

        this.metricsService.endStage(pipelineId, 'critic_spec', criticResult?.approved ?? true, {
          overallScore: criticResult?.overallScore ?? 0,
          findingsCount: criticResult?.findings?.length ?? 0,
          approved: criticResult?.approved ?? true,
        });

        // Store critic output in intermediateState
        if (criticResult) {
          await this.store.update(pipelineId, {
            intermediateState: { criticSpecOutput: criticResult },
          });
        }
        // If critic rejected and score < threshold, log but proceed (human gate is next)
        logger.info(
          { pipelineId, approved: criticResult?.approved, score: criticResult?.overallScore },
          '[Pipeline] Critic spec review completed'
        );

        // Level 4: Explainability — record critic-spec reasoning
        if (criticResult) {
          this.persistReasoning(
            pipelineId,
            buildCriticReasoning(criticResult, { reviewType: 'spec' })
          );
        }

        // ─── Level 4: Adaptive Autonomy — auto-approve if threshold met ───
        const currentPipeline = await this.store.getById(pipelineId);
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
          await this.store.update(pipelineId, {
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
          const autoOwner = await this.getGitHubOwner(currentPipeline.userId);
          // Trigger Proto directly (skip human gate)
          this.runProtoAndTrace(
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
              this.failPipeline(pipelineId, 'Proto', err).catch((e) =>
                logger.error({ err: e }, '[Pipeline] failPipeline also failed')
              );
            })
            .finally(() => {
              cleanupPipelineListeners(pipelineId);
            });

          return (await this.store.getById(pipelineId)) as PipelineState;
        }
      }

      const updated = await this.store.update(pipelineId, {
        stage: 'awaiting_approval',
        scribeConversation: conversation,
        scribeOutput: result.data,
        title: result.data.spec.title,
        metrics: { ...metrics, scribeCompletedAt: new Date() },
      });
      this.emitEvent(pipelineId, 'stage_change', 'awaiting_approval', result.data);

      // Jira hook: create Epic from spec (non-blocking, failures are swallowed)
      if (pipelineForJira?.jiraConfig?.enabled && pipelineForJira.jiraConfig.projectKey) {
        this.runJiraEpicCreation(
          pipelineId,
          pipelineForJira.userId,
          pipelineForJira.jiraConfig.projectKey,
          result.data.spec
        ).catch((err) => logger.warn({ err }, '[Pipeline] Non-blocking task failed'));
      }

      return updated;
    }

    // Error
    const updated = await this.store.update(pipelineId, {
      stage: 'failed',
      scribeConversation: conversation,
      error: result.error,
    });
    this.emitEvent(pipelineId, 'error', 'failed', result.error);
    return updated;
  }

  // ─── Private: Trace Runner ───────────────────

  private async runTrace(
    pipelineId: string,
    metrics: PipelineMetrics,
    owner: string,
    repo: string,
    branch: string,
    spec?: StructuredSpec,
    model?: string
  ): Promise<PipelineState> {
    const traceEmit = createActivityEmitter(pipelineId, 'trace');
    traceEmit('start', 'Scaffold dosyaları analiz ediliyor...', 5);

    // Effort-based model routing for Trace (estimate from spec criteria count)
    const traceEffort = scoreTraceEffort({ fileCount: spec?.acceptanceCriteria?.length ?? 5 });
    const traceModel = model ?? traceEffort.model;
    logger.info(
      `[Trace] Effort: ${traceEffort.score}/10 → Model: ${traceModel} (${traceEffort.reasoning})`
    );

    const agents = this.getAgents(traceModel);
    await this.writeCheckpoint(pipelineId, 'trace', `${owner}/${repo}@${branch}`);
    // Read cucumberEnabled from pipeline intermediateState
    const pipelineForCucumber = await this.getPipeline(pipelineId);
    const cucumberEnabled =
      (pipelineForCucumber.intermediateState as Record<string, unknown> | undefined)
        ?.cucumberEnabled === true;
    const traceKnowledgeRaw = buildUnifiedAgentKnowledgeContext(pipelineForCucumber, {
      role: 'trace',
    });
    const traceKnowledgeBase = traceKnowledgeRaw.trim() ? traceKnowledgeRaw : undefined;
    // Issue #462 — prepend chat-memory block for Trace turn. Retrieval
    // query is the acceptance-criteria-rich spec title (if present),
    // else repo/branch breadcrumbs.
    const traceQuery = spec?.title ?? `${owner}/${repo}@${branch}`;
    const traceKnowledge = await this.applyChatMemory(
      pipelineForCucumber,
      traceKnowledgeBase,
      traceQuery,
      { messageIndex: (pipelineForCucumber.scribeConversation?.length ?? 0) + 2 }
    );
    // Issue #464 BUG-C — forward user-uploaded screenshots so Trace can see
    // the mockup while writing Playwright selectors/assertions.
    const traceImageBlocks = readPipelineImageBlocks(pipelineForCucumber.intermediateState);
    const traceResult = await withRetry(
      (attempt) => {
        if (attempt > 1) traceEmit('retry', `Trace yeniden deneniyor (deneme ${attempt})...`, 30);
        return withTimeout(
          agents.trace.execute({
            repoOwner: owner,
            repo,
            branch,
            spec,
            pipelineId,
            cucumberEnabled,
            knowledgeContext: traceKnowledge,
            imageBlocks: traceImageBlocks,
          }),
          TRACE_TIMEOUT,
          'Trace'
        );
      },
      {
        maxAttempts: 3,
        onError: (err, attempt) => {
          const isTimeout = err instanceof Error && err.message.includes('timed out');
          const detail = isTimeout
            ? 'stage timeout'
            : err instanceof Error
              ? err.message
              : String(err);
          logger.warn({ attempt, detail }, '[Pipeline] Trace attempt failed');
          traceEmit(
            'error',
            `Trace hatası (deneme ${attempt}): ${isTimeout ? 'zaman aşımı' : 'beklenmeyen hata'}`,
            0
          );
        },
      }
    );

    if (traceResult.type === 'error') {
      const isAiTimeout = traceResult.error.code === 'TRACE_AI_CALL_TIMEOUT';
      traceEmit(
        'error',
        isAiTimeout
          ? 'AI servisi yanıt vermedi — test üretimi atlandı'
          : `Test üretimi başarısız: ${traceResult.error.message}`,
        0
      );

      // ─── Level 3: FixLoop auto-trigger on Trace failure ───
      const currentPipelineForFix = await this.store.getById(pipelineId);
      const protoOutput = currentPipelineForFix?.protoOutput;
      if (protoOutput && spec && !isAiTimeout) {
        logger.info({ pipelineId }, '[Pipeline] Trace failed — triggering FixLoop');
        await this.store.update(pipelineId, { stage: 'fix_loop_iteration' });
        this.emitEvent(pipelineId, 'stage_change', 'fix_loop_iteration');
        this.metricsService.startStage(pipelineId, 'fix_loop');

        const fixResult = await this.fixLoopService.runFixLoop(
          spec,
          async (_s, feedback) => {
            const fixAgents = this.getAgents(model);
            const pl = await this.getPipeline(pipelineId);
            const baseCtx = buildUnifiedAgentKnowledgeContext(pl, { role: 'proto' });
            const fb = feedback
              ? `\n--- FIX LOOP FEEDBACK ---\n${feedback}\n--- END FEEDBACK ---\n`
              : '';
            const merged = [baseCtx, fb].filter(Boolean).join('\n');
            // Issue #464 BUG-C: forward user-uploaded screenshots to FixLoop
            // Proto retries so the regenerated scaffold stays aligned with
            // the original mockup intent.
            const fixProtoImages = readPipelineImageBlocks(pl.intermediateState);
            const protoRes = await fixAgents.proto.execute({
              spec,
              repoName: repo,
              repoVisibility: 'private',
              owner,
              pipelineId,
              knowledgeContext: merged.trim() ? merged : undefined,
              imageBlocks: fixProtoImages,
            });
            if (protoRes.type === 'error') throw new Error(protoRes.error.message);
            return protoRes.data;
          },
          async (protoOut) => {
            // SecurityGate regression check before trace
            const secScan = this.securityGate.scan(
              protoOut.files.map((f) => ({ path: f.filePath, content: f.content }))
            );
            const prevScan = (
              currentPipelineForFix?.intermediateState as Record<string, unknown> | undefined
            )?.lastSecurityScan as
              | import('../security-gate/SecurityGateTypes.js').SecurityScanResult
              | undefined;
            const gateDecision = this.securityGate.evaluate(secScan, prevScan);
            if (!gateDecision.allowed) {
              logger.warn(
                { pipelineId, reason: gateDecision.reason },
                '[Pipeline] SecurityGate blocked fix iteration'
              );
              throw new Error(`SecurityGate: ${gateDecision.reason}`);
            }

            const fixAgents = this.getAgents(model);
            const plTrace = await this.getPipeline(pipelineId);
            const traceKb = buildUnifiedAgentKnowledgeContext(plTrace, { role: 'trace' });
            // Issue #397: preserve the chat-level Cucumber/BDD toggle across
            // FixLoop retries so the user's preference is not silently
            // dropped when the first Trace attempt fails.
            const fixCucumberEnabled =
              (plTrace.intermediateState as Record<string, unknown> | undefined)
                ?.cucumberEnabled === true;
            // Issue #464 BUG-C: forward user-uploaded screenshots to Trace
            // during FixLoop retries too, so selector generation stays
            // visually anchored even after a failure bounce.
            const fixTraceImages = readPipelineImageBlocks(plTrace.intermediateState);
            const traceRes = await fixAgents.trace.execute({
              repoOwner: owner,
              repo,
              branch,
              spec,
              pipelineId,
              cucumberEnabled: fixCucumberEnabled,
              knowledgeContext: traceKb.trim() ? traceKb : undefined,
              imageBlocks: fixTraceImages,
            });
            if (traceRes.type === 'error') throw new Error(traceRes.error.message);
            return traceRes.data;
          }
        );

        this.metricsService.endStage(pipelineId, 'fix_loop', fixResult.success, {
          iterationCount: fixResult.totalIterations,
          terminationReason: fixResult.terminationReason,
        });

        if (fixResult.success && fixResult.finalTraceOutput) {
          const updated = await this.store.update(pipelineId, {
            stage: 'completed',
            protoOutput: fixResult.finalProtoOutput ?? protoOutput,
            traceOutput: fixResult.finalTraceOutput,
            metrics: {
              ...metrics,
              protoCompletedAt: metrics.protoCompletedAt ?? new Date(),
              traceCompletedAt: new Date(),
              totalDurationMs: Date.now() - toEpoch(metrics.startedAt),
            },
          });
          this.emitEvent(pipelineId, 'completed', 'completed');
          // Record learning
          this.learningService.recordOutcome(pipelineId, 'fix_loop', {
            success: true,
            duration: Date.now() - toEpoch(metrics.startedAt),
            score: fixResult.totalIterations,
          });
          return updated;
        }
        logger.info(
          { pipelineId, reason: fixResult.terminationReason },
          '[Pipeline] FixLoop failed — falling through to completed_partial'
        );
      }

      // Graceful degradation — completed_partial (keep error visible for UI)
      const updated = await this.store.update(pipelineId, {
        stage: 'completed_partial',
        error: traceResult.error,
        metrics: {
          ...metrics,
          protoCompletedAt: metrics.protoCompletedAt ?? new Date(),
          totalDurationMs: Date.now() - toEpoch(metrics.startedAt),
        },
      });
      this.emitEvent(pipelineId, 'completed', 'completed_partial');
      // Record learning for failed trace
      this.learningService.recordOutcome(pipelineId, 'trace', {
        success: false,
        errorType: traceResult.error.code,
        duration: Date.now() - toEpoch(metrics.startedAt),
      });
      return updated;
    }

    const updated = await this.store.update(pipelineId, {
      stage: 'completed',
      traceOutput: traceResult.data,
      metrics: {
        ...metrics,
        protoCompletedAt: metrics.protoCompletedAt ?? new Date(),
        traceCompletedAt: new Date(),
        totalDurationMs: Date.now() - toEpoch(metrics.startedAt),
      },
    });
    this.emitEvent(pipelineId, 'completed', 'completed');

    // Log Trace activity for integrity metrics
    const ts = traceResult.data.testSummary;
    this.logActivity(pipelineId, 'trace', 'tests_generated', {
      testsPassed: ts?.totalTests ?? 0,
      specCompliance: ts?.coveragePercentage ? ts.coveragePercentage / 100 : 0,
      confidence: ts?.coveragePercentage ? ts.coveragePercentage / 100 : 0,
    });

    // Level 4: Explainability — record Trace reasoning
    this.recordTraceReasoning(pipelineId, traceResult.data);

    // Record learning for successful pipeline
    this.learningService.recordOutcome(pipelineId, 'trace', {
      success: true,
      duration: Date.now() - toEpoch(metrics.startedAt),
      score: ts?.coveragePercentage ?? 0,
    });

    // Jira hook: comment Trace result (non-blocking)
    const pipelineForJira = await this.store.getById(pipelineId);
    if (pipelineForJira?.jiraConfig?.epicKey) {
      this.runJiraTraceComment(pipelineForJira.userId, pipelineForJira.jiraConfig.epicKey, {
        totalTests: traceResult.data.testSummary.totalTests,
        coveragePercentage: traceResult.data.testSummary.coveragePercentage,
        passed: traceResult.data.ok,
      }).catch((err) => logger.warn({ err }, '[Pipeline] Non-blocking task failed'));
    }

    // Pipeline tamamlanma sinyali
    emitActivity({
      pipelineId,
      stage: 'trace',
      step: 'pipeline_complete',
      message: 'Pipeline başarıyla tamamlandı',
      progress: 100,
      timestamp: new Date().toISOString(),
    });

    // Token usage stays on the pipelines table (`metrics` JSONB) — there is no
    // longer a separate billing counter to bump.
    const completedPipeline = await this.store.getById(pipelineId);

    // Auto-ingest pipeline results into knowledge base (non-blocking)
    if (completedPipeline) {
      new PipelineKnowledgeIngester()
        .ingestPipelineResults({
          pipelineId,
          userId: completedPipeline.userId,
          spec: completedPipeline.scribeOutput?.spec,
          specMarkdown: completedPipeline.scribeOutput?.rawMarkdown,
          protoFiles: completedPipeline.protoOutput?.files,
          repoName: completedPipeline.protoConfig?.repoName as string | undefined,
          repoOwner: completedPipeline.protoOutput?.repo?.split('/')[0],
          branch: completedPipeline.protoOutput?.branch,
          traceTestSummary: traceResult.data.testSummary,
          traceCoverageMatrix: traceResult.data.coverageMatrix,
        })
        .catch((err) =>
          logger.warn({ err, pipelineId }, '[Pipeline] Knowledge ingestion failed (non-fatal)')
        );
    }

    return updated;
  }

  // ─── Private: Retry Helpers ──────────────────

  private async retryTrace(pipelineId: string, pipeline: PipelineState): Promise<PipelineState> {
    let owner: string;
    try {
      const gh = await this.validateGitHubAccess(pipeline.userId);
      owner = gh.owner;
    } catch (err) {
      const error = createPipelineError(
        PipelineErrorCode.GITHUB_NOT_CONNECTED,
        `GitHub owner çözümlenemedi: ${err instanceof Error ? err.message : String(err)}`
      );
      const failed = await this.store.update(pipelineId, { stage: 'failed', error });
      this.emitEvent(pipelineId, 'error', 'failed', error);
      return failed;
    }

    const p = await this.getPipeline(pipelineId);
    await this.store.update(
      pipelineId,
      { stage: 'trace_testing' },
      { expectedStageVersion: p.stageVersion }
    );
    this.emitEvent(pipelineId, 'stage_change', 'trace_testing');

    if (!pipeline.protoOutput) {
      throw new Error('Cannot retry Trace: protoOutput is missing');
    }
    const repo =
      pipeline.protoConfig?.repoName ??
      pipeline.protoOutput.repo.split('/')[1] ??
      pipeline.protoOutput.repo;

    return this.runTrace(
      pipelineId,
      pipeline.metrics,
      owner,
      repo,
      pipeline.protoOutput.branch,
      pipeline.approvedSpec,
      pipeline.model
    );
  }

  private async retryProto(pipelineId: string, pipeline: PipelineState): Promise<PipelineState> {
    let owner: string;
    let userGitHubToken: string;
    try {
      const gh = await this.validateGitHubAccess(pipeline.userId);
      userGitHubToken = gh.token;
      owner = gh.owner;
    } catch (err) {
      const error = createPipelineError(
        PipelineErrorCode.GITHUB_NOT_CONNECTED,
        `GitHub owner çözümlenemedi: ${err instanceof Error ? err.message : String(err)}`
      );
      const failed = await this.store.update(pipelineId, { stage: 'failed', error });
      this.emitEvent(pipelineId, 'error', 'failed', error);
      return failed;
    }
    if (!pipeline.approvedSpec) {
      throw new Error('Cannot retry Proto: approvedSpec is missing');
    }
    const repoName =
      pipeline.protoConfig?.repoName ?? this.deriveRepoName(pipeline.approvedSpec.title);
    const repoVisibility = pipeline.protoConfig?.repoVisibility ?? 'private';

    const current = await this.getPipeline(pipelineId);
    await this.store.update(
      pipelineId,
      { stage: 'proto_building' },
      { expectedStageVersion: current.stageVersion }
    );
    this.emitEvent(pipelineId, 'stage_change', 'proto_building');

    // Per-user GitHub adapter for retry
    const userGithubService = this.createGitHubService(userGitHubToken);
    const agents =
      this.createAgentsForModel?.(pipeline.model ?? '', userGithubService) ??
      this.getAgents(pipeline.model);
    const retryProtoKbRaw = buildUnifiedAgentKnowledgeContext(pipeline, { role: 'proto' });
    const retryProtoKb = retryProtoKbRaw.trim() ? retryProtoKbRaw : undefined;
    const result = await withTimeout(
      agents.proto.execute({
        spec: pipeline.approvedSpec,
        repoName,
        repoVisibility,
        owner,
        pipelineId,
        knowledgeContext: retryProtoKb,
      }),
      STAGE_TIMEOUT,
      'Proto'
    );

    if (result.type === 'error') {
      const updated = await this.store.update(pipelineId, { stage: 'failed', error: result.error });
      this.emitEvent(pipelineId, 'error', 'failed', result.error);
      return updated;
    }

    await this.store.update(pipelineId, {
      protoOutput: result.data,
      stage: 'trace_testing',
      metrics: { ...pipeline.metrics, protoCompletedAt: new Date() },
    });
    this.emitEvent(pipelineId, 'stage_change', 'trace_testing');

    return this.runTrace(
      pipelineId,
      pipeline.metrics,
      owner,
      repoName,
      result.data.branch,
      pipeline.approvedSpec,
      pipeline.model
    );
  }

  private async retryScribe(pipelineId: string, pipeline: PipelineState): Promise<PipelineState> {
    const agents = this.getAgents(pipeline.model);
    const scribeState = this.reconstructScribeState(pipeline);
    scribeState.pipelineId = pipelineId;
    const current = await this.getPipeline(pipelineId);
    await this.store.update(
      pipelineId,
      { stage: 'scribe_clarifying' },
      { expectedStageVersion: current.stageVersion }
    );
    this.emitEvent(pipelineId, 'stage_change', 'scribe_clarifying');

    const result = await withTimeout(
      agents.scribe.analyzIdea(scribeState),
      STAGE_TIMEOUT,
      'Scribe'
    );
    return this.handleScribeResult(
      pipelineId,
      pipeline.metrics,
      [...pipeline.scribeConversation],
      result
    );
  }

  // ─── Private: Utilities ──────────────────────

  /** Validate GitHub token + resolve owner. Reusable by approveSpec and retry methods. */
  private async validateGitHubAccess(userId: string): Promise<{ token: string; owner: string }> {
    const token = await this.getGitHubToken(userId);
    if (!token) {
      throw new Error(
        'GitHub bağlantısı bulunamadı. Ayarlar sayfasından GitHub hesabınızı bağlayın.'
      );
    }
    // Pre-validate token (skip in test/mock mode)
    if (!token.startsWith('ghp_mock')) {
      const ghRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      }).catch(() => null);
      if (ghRes && !ghRes.ok) {
        throw new Error(
          `GitHub token geçersiz (HTTP ${ghRes.status}). Ayarlar → GitHub bölümünden yeniden bağlayın.`
        );
      }
    }
    const owner = await this.getGitHubOwner(userId);
    return { token, owner };
  }

  private async getPipeline(id: string): Promise<PipelineState> {
    const pipeline = await this.store.getById(id);
    if (!pipeline) throw new PipelineNotFoundError(id);
    return pipeline;
  }

  private assertStage(pipeline: PipelineState, expected: PipelineStage): void {
    if (pipeline.stage !== expected) {
      throw new InvalidStageError(expected, pipeline.stage);
    }
  }

  private reconstructScribeState(pipeline: PipelineState): ScribeState {
    const ideaMsg = pipeline.scribeConversation.find((m) => m.type === 'user_idea');
    const clarificationCount = pipeline.scribeConversation.filter(
      (m) => m.type === 'clarification'
    ).length;

    return {
      idea: typeof ideaMsg?.content === 'string' ? ideaMsg.content : '',
      conversation: [...pipeline.scribeConversation],
      clarificationRound: clarificationCount,
      phase: pipeline.stage === 'awaiting_approval' ? 'done' : 'clarifying',
      pendingQuestionIds: [],
      answeredQuestionIds: [],
    };
  }

  private deriveRepoName(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
  }

  /** Check if pipeline was cancelled while background work was running. */
  private async isCancelled(pipelineId: string): Promise<boolean> {
    try {
      const p = await this.store.getById(pipelineId);
      return p?.stage === 'cancelled';
    } catch {
      return false;
    }
  }

  private async failPipeline(pipelineId: string, label: string, err: unknown): Promise<void> {
    // Don't overwrite 'cancelled' with 'failed'
    if (await this.isCancelled(pipelineId)) return;

    const isTimeout = err instanceof Error && err.message.includes('timed out');
    const error = isTimeout
      ? createPipelineError(
          PipelineErrorCode.PIPELINE_TIMEOUT,
          `${label}: ${(err as Error).message}`
        )
      : createPipelineError(
          PipelineErrorCode.AI_PROVIDER_ERROR,
          `${label}: ${err instanceof Error ? err.message : String(err)}`
        );

    // Retry with exponential backoff — pipeline must not stay stuck in running state
    const retryDelays = [1_000, 5_000, 15_000];
    let persisted = false;
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        await this.store.update(pipelineId, { stage: 'failed', error });
        this.emitEvent(pipelineId, 'error', 'failed', error);
        persisted = true;
        break;
      } catch (storeErr) {
        if (attempt < retryDelays.length) {
          logger.warn(
            { err: storeErr, pipelineId, attempt: attempt + 1 },
            `[Pipeline] failPipeline attempt failed, retrying in ${retryDelays[attempt]}ms`
          );
          await new Promise((r) => setTimeout(r, retryDelays[attempt]));
        } else {
          logger.error(
            { err: storeErr, pipelineId },
            '[Pipeline] CRITICAL: failPipeline exhausted all retries. Pipeline may be stuck.'
          );
          // Last resort: emit error event even if store update failed — at least SSE clients get notified
          try {
            this.emitEvent(pipelineId, 'error', 'failed', error);
          } catch {
            /* exhausted */
          }
        }
      }
    }

    // Post a failure comment to the linked Jira Epic when there is one. Guarded
    // behind the persistent flag so a transient DB outage doesn't spam Jira.
    // Helper is non-throwing so we can fire-and-forget.
    if (persisted) {
      this.postJiraFailureComment(pipelineId, label, error).catch((jiraErr) => {
        logger.warn(
          { err: jiraErr, pipelineId },
          '[Pipeline] Jira failure comment handler itself threw'
        );
      });
    }
  }

  /**
   * Fetches the pipeline's linked Jira Epic (if any) and posts a failure
   * comment via `commentJiraWithFailure` (#396). Safe to call unconditionally —
   * returns silently when no Epic is linked or Atlassian isn't connected.
   * Introduced to close the gap where failed pipelines left their Epic silently
   * In Progress (see 2026-04-17 Jira verify task review).
   */
  private async postJiraFailureComment(
    pipelineId: string,
    label: string,
    error: { code: string; message: string; retryable: boolean }
  ): Promise<void> {
    let pipeline;
    try {
      pipeline = await this.store.getById(pipelineId);
    } catch {
      return;
    }
    const epicKey = pipeline?.jiraConfig?.epicKey;
    const userId = pipeline?.userId;
    if (!epicKey || !userId) return;

    const jira = await JiraMCPService.fromOAuth(userId);
    if (!jira) return;

    await commentJiraWithFailure(jira, epicKey, {
      stage: label,
      errorCode: error.code,
      errorMessage: error.message,
      retryable: error.retryable,
      pipelineId,
    });
  }

  private emitEvent(
    pipelineId: string,
    type: PipelineEvent['type'],
    stage?: PipelineStage,
    data?: unknown
  ): void {
    this.emit?.({ pipelineId, type, stage, data });
    // Clean up event listeners when pipeline reaches a terminal state
    if (
      stage === 'completed' ||
      stage === 'completed_partial' ||
      stage === 'failed' ||
      stage === 'cancelled'
    ) {
      cleanupPipelineListeners(pipelineId);
      // Flush accumulated token usage to DB (best-effort, non-blocking)
      this.flushTokenUsage(pipelineId).catch((err) =>
        logger.warn({ err, pipelineId }, '[Pipeline] Token flush failed')
      );
    }
  }

  // ─── Private: Jira Integration Helpers ────────

  private async runJiraEpicCreation(
    pipelineId: string,
    userId: string,
    projectKey: string,
    spec: StructuredSpec
  ): Promise<void> {
    try {
      const jira = await JiraMCPService.fromOAuth(userId);
      if (!jira) return;
      const epicKey = await createJiraEpicFromSpec(jira, projectKey, spec);
      if (epicKey) {
        await this.store.update(pipelineId, {
          jiraConfig: { projectKey, enabled: true, epicKey },
        });
        logger.info(`[Pipeline] Jira Epic ${epicKey} linked to pipeline ${pipelineId}`);
      }
    } catch (err) {
      logger.warn({ err }, '[Pipeline] Jira Epic creation failed (non-fatal)');
    }
  }

  private async runJiraProtoComment(
    userId: string,
    epicKey: string,
    result: { branch: string; repo: string; prUrl?: string; filesCreated: number }
  ): Promise<void> {
    try {
      const jira = await JiraMCPService.fromOAuth(userId);
      if (!jira) return;
      await commentJiraWithProtoResult(jira, epicKey, result);
    } catch (err) {
      logger.warn({ err }, '[Pipeline] Jira Proto comment failed (non-fatal)');
    }
  }

  private async runJiraTraceComment(
    userId: string,
    epicKey: string,
    result: { totalTests: number; coveragePercentage: number; passed: boolean }
  ): Promise<void> {
    try {
      const jira = await JiraMCPService.fromOAuth(userId);
      if (!jira) return;
      await commentJiraWithTraceResult(jira, epicKey, result);
    } catch (err) {
      logger.warn({ err }, '[Pipeline] Jira Trace comment failed (non-fatal)');
    }
  }

  private async writeCheckpoint(
    pipelineId: string,
    agentName: string,
    input: unknown
  ): Promise<void> {
    try {
      // Merge with existing intermediateState to preserve critic outputs
      const current = await this.store.getById(pipelineId);
      const existing = (current?.intermediateState ?? {}) as Record<string, unknown>;
      await this.store.update(pipelineId, {
        intermediateState: {
          ...existing,
          agent: agentName,
          startedAt: new Date().toISOString(),
          status: 'in_progress',
          inputSummary: typeof input === 'string' ? input.slice(0, 200) : 'structured',
        },
        attemptCount: 0, // will be incremented by retry wrapper
      });
    } catch {
      // checkpoint failure is non-fatal — don't block agent execution
    }
  }

  // ─── Level 3: Critic Review Helpers ────────────

  /**
   * Run CriticAgent spec review. Returns the review output or null on error.
   * Errors are logged but do not fail the pipeline — critic is advisory.
   */
  private async runCriticSpecReview(
    pipelineId: string,
    spec: StructuredSpec,
    originalIdea: string
  ): Promise<CriticReviewOutput | null> {
    if (!this.criticAgent) return null;
    try {
      const result: CriticResult = await this.criticAgent.reviewSpec(
        { reviewType: 'spec_review', artifact: spec, originalIdea },
        1
      );
      if (result.type === 'review') return result.data;
      logger.warn(
        { pipelineId, error: result.error },
        '[Pipeline] Critic spec review returned error'
      );
      return null;
    } catch (err) {
      logger.warn({ err, pipelineId }, '[Pipeline] Critic spec review failed (non-fatal)');
      return null;
    }
  }

  /**
   * Run CriticAgent code review. Returns the review output or null on error.
   * Errors are logged but do not fail the pipeline — critic is advisory.
   */
  private async runCriticCodeReview(
    pipelineId: string,
    protoOutput: ProtoOutput,
    spec: StructuredSpec,
    originalIdea: string
  ): Promise<CriticReviewOutput | null> {
    if (!this.criticAgent) return null;
    try {
      const result: CriticResult = await this.criticAgent.reviewCode(
        { reviewType: 'code_review', artifact: protoOutput, originalIdea, referenceSpec: spec },
        1
      );
      if (result.type === 'review') return result.data;
      logger.warn(
        { pipelineId, error: result.error },
        '[Pipeline] Critic code review returned error'
      );
      return null;
    } catch (err) {
      logger.warn({ err, pipelineId }, '[Pipeline] Critic code review failed (non-fatal)');
      return null;
    }
  }
}
