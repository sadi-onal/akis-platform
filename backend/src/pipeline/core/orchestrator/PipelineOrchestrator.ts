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
} from '../../integrations/jiraIntegration.js';
import { RETRY_CONFIG, createPipelineError, PipelineErrorCode, PipelineNotFoundError, InvalidStageError } from '../contracts/PipelineErrors.js';
import { createActivityEmitter, emitActivity, cleanupPipelineListeners } from '../activityEmitter.js';
import { withRetry } from '../retryWrapper.js';
import { scoreScribeEffort, scoreProtoEffort, scoreTraceEffort } from '../effortScorer.js';
import { logger } from '../../../lib/logger.js';
import { PipelineKnowledgeIngester } from '../../../services/knowledge/ingestion/PipelineKnowledgeIngester.js';
import { incrementUsage } from '../../../services/billing/BillingService.js';
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
import { LearningService } from '../learning/LearningService.js';

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

/** Safely get epoch ms from a Date or ISO string (JSONB stores dates as strings). */
function toEpoch(d: Date | string | undefined): number {
  if (!d) return Date.now();
  return typeof d === 'string' ? new Date(d).getTime() : d.getTime();
}

// ─── Store Interface ──────────────────────────────

export interface PipelineStore {
  create(userId: string): Promise<PipelineState>;
  getById(id: string): Promise<PipelineState | null>;
  listByUser(userId: string): Promise<PipelineState[]>;
  update(id: string, data: Partial<PipelineStateUpdate>, opts?: { expectedStageVersion?: number }): Promise<PipelineState>;
}

export interface PipelineStateUpdate {
  stage: PipelineStage;
  title: string;
  model: string;
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

  // ─── Level 3 Services ───────────────────────────
  private criticAgent?: CriticAgent;
  private fixLoopService = new FixLoopService();
  private metricsService = new PipelineMetricsService();

  // ─── Level 4 Services ───────────────────────────
  private validator = new DeterministicValidator();
  private securityGate = new SecurityGate();
  private explainability = new ExplainabilityService();
  private learningService = new LearningService();

  constructor(
    private store: PipelineStore,
    private scribe: ScribeAgent,
    private proto: ProtoAgent,
    private trace: TraceAgent,
    private getGitHubOwner: (userId: string) => Promise<string>,
    private getGitHubToken: (userId: string) => Promise<string | null>,
    private createGitHubService: (token: string) => import('../pipeline-factory.js').GitHubServiceLike,
    private emit?: (event: PipelineEvent) => void,
    private createAgentsForModel?: (model: string, githubService?: import('../pipeline-factory.js').GitHubServiceLike, onTokenUsage?: import('../pipeline-factory.js').TokenUsageCallback) => AgentSet,
  ) {}

  /** Inject optional agent activity logger for integrity metrics */
  setActivityLogger(logger: { record(entry: Record<string, unknown>): Promise<void> }): void {
    this.activityLogger = logger;
  }

  /** Inject CriticAgent for Level 3 adversarial review (optional — backward-compatible) */
  setCriticAgent(critic: CriticAgent): void {
    this.criticAgent = critic;
  }

  /** Access the pipeline metrics service for reporting */
  getMetricsService(): PipelineMetricsService {
    return this.metricsService;
  }

  /** Level 4: Access explainability service */
  getExplainability(): ExplainabilityService {
    return this.explainability;
  }

  /** Level 4: Access learning service */
  getLearningService(): LearningService {
    return this.learningService;
  }

  /** Log agent activity (non-blocking, best-effort) */
  private logActivity(pipelineId: string, agent: 'scribe' | 'proto' | 'trace', action: string, data: Record<string, unknown> = {}): void {
    this.activityLogger?.record({ pipelineId, agent, action, ...data }).catch((err) => logger.warn({ err }, '[Pipeline] Non-blocking task failed'));
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
    traceEnabled?: boolean,
  ): Promise<PipelineState> {
    const pipeline = await this.store.create(userId);

    const conversation: ScribeMessageType[] = [
      { type: 'user_idea', content: input.idea },
    ];

    const updateData: Partial<PipelineStateUpdate> = {
      title: input.idea.slice(0, 100),
      model,
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
        ).catch((err) => {
          logger.error({ err, pipelineId: pipeline.id }, '[Pipeline] Background iteration Proto+Trace failed');
          this.failPipeline(pipeline.id, 'Proto', err).catch((e) => logger.error({ err: e }, '[Pipeline] failPipeline also failed'));
        }).finally(() => {
          cleanupPipelineListeners(pipeline.id);
        });

        return updated;
      }
      // If parent spec not found, fall through to normal Scribe flow
      logger.warn({ parentPipelineId, pipelineId: pipeline.id }, '[Pipeline] skipScribe requested but parent spec not found, falling back to Scribe');
    }

    const updated = await this.store.update(pipeline.id, updateData);

    // Run Scribe in background (non-blocking)
    this.runScribeAnalysis(pipeline.id, pipeline.metrics, input, conversation, model).catch((err) => {
      logger.error({ err, pipelineId: pipeline.id }, '[Pipeline] Background Scribe failed');
      this.failPipeline(pipeline.id, 'Scribe', err).catch((e) => logger.error({ err: e }, '[Pipeline] failPipeline also failed'));
    });

    return updated;
  }

  // ─── Background Scribe Analysis ───────────────

  private async runScribeAnalysis(
    pipelineId: string,
    metrics: PipelineMetrics,
    input: ScribeInput,
    conversation: ScribeMessageType[],
    model?: string,
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
          existingRepo.branch,
        );
        // Cache in DB for later use by Proto
        await this.store.update(pipelineId, { repoContext });

        repoKnowledge = `\n\n--- EXISTING REPOSITORY CONTEXT ---\n`
          + `Repository: ${repoContext.owner}/${repoContext.repo} (branch: ${repoContext.branch})\n`
          + `Tech Stack: ${repoContext.techStack.join(', ')}\n`
          + `Summary: ${repoContext.summary}\n\n`
          + `File Tree:\n${repoContext.fileTree}\n`
          + `--- END REPOSITORY CONTEXT ---\n`
          + `\nIMPORTANT: You are writing a spec for a CHANGE to this existing codebase, not a new project. `
          + `The spec should describe what to ADD or MODIFY in the existing code.`;
        logger.info({ pipelineId, owner: existingRepo.owner, repo: existingRepo.repo }, '[Pipeline] RepoContext fetched');
      } catch (err) {
        logger.warn({ err, pipelineId }, '[Pipeline] RepoContext fetch failed, continuing without context');
        emit('progress', 'Repo analizi atlandı, devam ediliyor...', 15);
      }
    }

    // Effort-based model routing
    const effort = scoreScribeEffort(input.idea);
    const effectiveModel = model ?? effort.model;
    logger.info(`[Scribe] Effort: ${effort.score}/10 → Model: ${effectiveModel} (${effort.reasoning})`);

    const agents = this.getAgents(effectiveModel, pipelineId);
    const scribeState = agents.scribe.createInitialState(input);
    scribeState.pipelineId = pipelineId;

    // Inject repo context as knowledge context
    if (repoKnowledge) {
      scribeState.knowledgeContext = (scribeState.knowledgeContext ?? '') + repoKnowledge;
    }

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
      },
    );

    await this.handleScribeResult(pipelineId, metrics, conversation, result);

    if (result.type === 'clarification') {
      emit('clarification', 'Açıklayıcı sorular oluşturuldu', 100);
    } else if (result.type === 'error') {
      emit('error', 'Scribe analizi başarısız oldu', 0);
    }
  }

  // ─── Send Message (Scribe Chat) ──────────────

  async sendMessage(pipelineId: string, message: string): Promise<PipelineState> {
    return this.withLock(pipelineId, () => this._sendMessage(pipelineId, message));
  }
  private async _sendMessage(pipelineId: string, message: string): Promise<PipelineState> {
    const pipeline = await this.getPipeline(pipelineId);

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
        'Maksimum konuşma limiti aşıldı (20 mesaj). Lütfen yeni bir pipeline başlatın.',
      );
      const failed = await this.store.update(pipelineId, { stage: 'failed', error });
      this.emitEvent(pipelineId, 'error', 'failed', error);
      return failed;
    }

    const agents = this.getAgents(pipeline.model);
    const scribeState = this.reconstructScribeState(pipeline);
    agents.scribe.processUserAnswer(scribeState, message);

    const conversation: ScribeMessageType[] = [
      ...pipeline.scribeConversation,
      { type: 'user_answer', content: message },
    ];

    // Update with user answer immediately (optimistic lock prevents concurrent mutations)
    const updated = await this.store.update(pipelineId, {
      scribeConversation: conversation,
      stage: 'scribe_generating',
    }, { expectedStageVersion: pipeline.stageVersion });
    this.emitEvent(pipelineId, 'stage_change', 'scribe_generating');

    // Run Scribe continuation in background
    this.runScribeContinuation(pipelineId, pipeline.metrics, scribeState, conversation, pipeline.model).catch((err) => {
      logger.error({ err, pipelineId }, '[Pipeline] Background Scribe continuation failed');
      this.failPipeline(pipelineId, 'Scribe', err).catch((e) => logger.error({ err: e }, '[Pipeline] failPipeline also failed'));
    });

    return updated;
  }

  // ─── Background Scribe Continuation ───────────

  private async runScribeContinuation(
    pipelineId: string,
    metrics: PipelineMetrics,
    scribeState: ScribeState,
    conversation: ScribeMessageType[],
    model?: string,
  ): Promise<void> {
    const emit = createActivityEmitter(pipelineId, 'scribe');
    emit('start', 'Kullanıcı yanıtıyla devam ediliyor...', 10);
    scribeState.pipelineId = pipelineId;

    const agents = this.getAgents(model);
    const result = await withRetry(
      (attempt) => {
        if (attempt > 1) emit('retry', `Scribe devamı yeniden deneniyor (deneme ${attempt})...`, 35);
        return withTimeout(agents.scribe.continueAfterAnswer(scribeState), STAGE_TIMEOUT, 'Scribe');
      },
      {
        maxAttempts: 3,
        onError: (err, attempt) =>
          logger.warn({ err, attempt }, '[Pipeline] Scribe continueAfterAnswer attempt failed'),
      },
    );

    await this.handleScribeResult(pipelineId, metrics, conversation, result, scribeState.clarificationRound);

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
    cucumberEnabled?: boolean,
  ): Promise<PipelineState> {
    return this.withLock(pipelineId, () => this._approveSpec(pipelineId, repoName, repoVisibility, editedSpec, jiraConfig, cucumberEnabled));
  }
  private async _approveSpec(
    pipelineId: string,
    repoName: string,
    repoVisibility: 'public' | 'private',
    editedSpec?: StructuredSpec,
    jiraConfig?: { projectKey: string; enabled: boolean; epicKey?: string },
    cucumberEnabled?: boolean,
  ): Promise<PipelineState> {
    const pipeline = await this.getPipeline(pipelineId);
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
        `GitHub owner çözümlenemedi: ${err instanceof Error ? err.message : String(err)}`,
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
    const updated = await this.store.update(pipelineId, approveUpdate, { expectedStageVersion: pipeline.stageVersion });
    this.emitEvent(pipelineId, 'stage_change', 'proto_building');

    // Create per-user GitHub adapter and run Proto + Trace in background
    const userGithubService = this.createGitHubService(userGitHubToken);
    this.runProtoAndTrace(pipelineId, pipeline.metrics, spec, effectiveRepoName, repoVisibility, owner, pipeline.model, userGithubService).catch((err) => {
      logger.error({ err, pipelineId }, '[Pipeline] Background Proto+Trace failed');
      this.failPipeline(pipelineId, 'Proto/Trace', err).catch((e) => logger.error({ err: e }, '[Pipeline] failPipeline also failed'));
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
  ): Promise<void> {
    const protoEmit = createActivityEmitter(pipelineId, 'proto');
    protoEmit('start', 'Mevcut kod okunuyor...', 5);

    // Resolve GitHub access
    const pipeline = await this.getPipeline(pipelineId);
    let userGitHubToken: string;
    try {
      const gh = await this.validateGitHubAccess(pipeline.userId);
      userGitHubToken = gh.token;
    } catch (err) {
      const error = createPipelineError(
        PipelineErrorCode.GITHUB_NOT_CONNECTED,
        `GitHub bağlantısı bulunamadı: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.store.update(pipelineId, { stage: 'failed', error });
      this.emitEvent(pipelineId, 'error', 'failed', error);
      return;
    }

    // Read existing files from GitHub
    const userGithubService = this.createGitHubService(userGitHubToken);
    let existingFiles: Array<{ path: string; content: string }> = [];
    try {
      protoEmit('progress', `${existingRepo.owner}/${existingRepo.repo} deposundan dosyalar okunuyor...`, 15);
      existingFiles = await this.readRepoFiles(userGithubService, existingRepo.owner, existingRepo.repo, existingRepo.branch);
      protoEmit('progress', `${existingFiles.length} dosya okundu, değişiklikler uygulanıyor...`, 25);
    } catch (err) {
      logger.warn({ err, pipelineId }, '[Pipeline] Failed to read existing files, Proto will build from scratch');
      protoEmit('progress', 'Mevcut dosyalar okunamadı, sıfırdan oluşturuluyor...', 25);
    }

    const protoModel = model ?? 'claude-sonnet-4-6'; // Use stronger model for iterations
    const tokenCb = this.createTokenCallback(pipelineId);
    const agents = userGithubService
      ? (this.createAgentsForModel?.(protoModel, userGithubService, tokenCb) ?? this.getAgents(protoModel, pipelineId))
      : this.getAgents(protoModel, pipelineId);

    await this.writeCheckpoint(pipelineId, 'proto', `İterasyon: ${iterationRequest.slice(0, 80)}`);
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
          }),
          STAGE_TIMEOUT,
          'Proto',
        );
      },
      {
        maxAttempts: 3,
        onError: (err, attempt) =>
          logger.warn({ err, attempt }, '[Pipeline] Iteration Proto attempt failed'),
      },
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
      metrics: { ...protoCompletedMetrics, traceCompletedAt: new Date(), totalDurationMs: Date.now() - toEpoch(protoCompletedMetrics.startedAt) },
    });
    this.emitEvent(pipelineId, 'stage_change', 'completed');

    // Knowledge ingestion handled by caller if needed
  }

  /** Read source files from a GitHub repo (for iteration mode) */
  private async readRepoFiles(
    githubService: import('../pipeline-factory.js').GitHubServiceLike,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<Array<{ path: string; content: string }>> {
    const filePaths = await githubService.listFiles(owner, repo, branch);
    if (!filePaths?.length) return [];

    // Filter to source files only (skip node_modules, .git, images, etc.)
    const sourceExtensions = ['.html', '.css', '.js', '.ts', '.tsx', '.jsx', '.json', '.md', '.py', '.rb', '.go', '.rs', '.vue', '.svelte'];
    const ignorePaths = ['node_modules/', '.git/', 'dist/', 'build/', '.next/', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
    const sourceFiles = filePaths.filter((p: string) =>
      sourceExtensions.some(ext => p.endsWith(ext)) &&
      !ignorePaths.some(ignore => p.includes(ignore)),
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
    branch?: string,
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
    userGithubService?: import('../pipeline-factory.js').GitHubServiceLike,
  ): Promise<void> {
    const protoEmit = createActivityEmitter(pipelineId, 'proto');
    protoEmit('start', 'Onaylanan spec okunuyor...', 5);

    // Effort-based model routing for Proto
    const protoEffort = scoreProtoEffort(spec);
    const protoModel = model ?? protoEffort.model;
    logger.info(`[Proto] Effort: ${protoEffort.score}/10 → Model: ${protoModel} (${protoEffort.reasoning})`);

    // Use per-user GitHub adapter if available, otherwise default agents
    const tokenCbProto = this.createTokenCallback(pipelineId);
    const agents = userGithubService
      ? (this.createAgentsForModel?.(protoModel, userGithubService, tokenCbProto) ?? this.getAgents(protoModel, pipelineId))
      : this.getAgents(protoModel, pipelineId);
    // Inject repo context knowledge into Proto if available
    const pipelineData = await this.getPipeline(pipelineId);
    const repoCtx = pipelineData.repoContext;
    const protoKnowledge = repoCtx
      ? `\n\n--- EXISTING REPOSITORY CONTEXT ---\nRepository: ${repoCtx.owner}/${repoCtx.repo} (branch: ${repoCtx.branch})\nTech Stack: ${repoCtx.techStack.join(', ')}\nSummary: ${repoCtx.summary}\n\nFile Tree:\n${repoCtx.fileTree}\n--- END REPOSITORY CONTEXT ---\nIMPORTANT: Generate code that fits into this EXISTING codebase. Follow its conventions and patterns.`
      : undefined;

    await this.writeCheckpoint(pipelineId, 'proto', spec.title);
    const protoResult = await withRetry(
      (attempt) => {
        if (attempt > 1) protoEmit('retry', `Proto yeniden deneniyor (deneme ${attempt})...`, 25);
        return withTimeout(
          agents.proto.execute({ spec, repoName, repoVisibility, owner, pipelineId, knowledgeContext: protoKnowledge }),
          STAGE_TIMEOUT,
          'Proto',
        );
      },
      {
        maxAttempts: 3,
        onError: (err, attempt) =>
          logger.warn({ err, attempt }, '[Pipeline] Proto execute attempt failed'),
      },
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

    const protoCompletedMetrics = { ...metrics, approvedAt: metrics.approvedAt ?? new Date(), protoCompletedAt: new Date() };

    // Log Proto activity for integrity metrics
    this.logActivity(pipelineId, 'proto', 'scaffold_generated', {
      filesGenerated: protoResult.data.files?.length ?? 0,
      specCompliance: 0.85, // Proto succeeded → base compliance
    });

    // Check if Scribe marked this as not requiring tests
    const pipeline = await this.getPipeline(pipelineId);
    const requiresTests = pipeline.scribeOutput?.plan?.requiresTests ?? true;

    if (!requiresTests || !pipeline.traceEnabled) {
      // Skip Trace — mark as completed directly (either Scribe said no tests needed, or user disabled Trace)
      await this.store.update(pipelineId, {
        protoOutput: protoResult.data,
        stage: 'completed',
        metrics: { ...protoCompletedMetrics, traceCompletedAt: new Date(), totalDurationMs: Date.now() - toEpoch(protoCompletedMetrics.startedAt) },
      });
      this.emitEvent(pipelineId, 'stage_change', 'completed');
      return;
    }

    // ─── Level 4: Deterministic Validator (before CriticCode) ───
    if (protoResult.data.files && protoResult.data.files.length > 0) {
      const validationInput = {
        files: protoResult.data.files.map((f) => ({
          path: f.filePath,
          content: f.content,
          language: (f.filePath.endsWith('.ts') || f.filePath.endsWith('.tsx') ? 'typescript'
            : f.filePath.endsWith('.json') ? 'json'
            : f.filePath.endsWith('.html') ? 'html'
            : f.filePath.endsWith('.css') ? 'css'
            : 'javascript') as 'typescript' | 'javascript' | 'json' | 'html' | 'css',
        })),
        spec,
      };

      const validationResult = this.validator.validate(validationInput);
      logger.info({
        pipelineId,
        passed: validationResult.passed,
        score: validationResult.score,
        errors: validationResult.summary.errors,
        warnings: validationResult.summary.warnings,
      }, '[Pipeline] Level 4: Deterministic validation completed');

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
      this.explainability.addReasoning(pipelineId, {
        agentName: 'validator',
        timestamp: new Date(),
        decision: validationResult.passed ? 'Kod dogrulama basarili' : 'Kod dogrulama basarisiz',
        reasoning: [`Skor: ${validationResult.score}/100`, `${validationResult.summary.errors} hata, ${validationResult.summary.warnings} uyari`],
        assumptions: ['Deterministic kontroller yeterli'],
        confidence: { score: validationResult.score, factors: validationResult.summary.checksRun },
      });

      // If validator found errors → fail early (save LLM tokens)
      if (!validationResult.passed && validationResult.summary.errors > 0) {
        logger.warn({ pipelineId, score: validationResult.score }, '[Pipeline] Validator caught errors — failing before Critic');
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

      const ideaMsg = pipeline.scribeConversation.find((m) => m.type === 'user_idea');
      const originalIdea = typeof ideaMsg?.content === 'string' ? ideaMsg.content : '';
      const criticResult = await this.runCriticCodeReview(pipelineId, protoResult.data, spec, originalIdea);

      this.metricsService.endStage(pipelineId, 'critic_code', criticResult?.approved ?? true, {
        overallScore: criticResult?.overallScore ?? 0,
        findingsCount: criticResult?.findings?.length ?? 0,
        approved: criticResult?.approved ?? true,
      });

      if (criticResult) {
        const currentState = await this.store.getById(pipelineId);
        const existingIntermediate = (currentState?.intermediateState ?? {}) as Record<string, unknown>;
        await this.store.update(pipelineId, {
          intermediateState: { ...existingIntermediate, criticCodeOutput: criticResult },
        });
      }
      logger.info({ pipelineId, approved: criticResult?.approved, score: criticResult?.overallScore }, '[Pipeline] Critic code review completed');
    }

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

    await this.store.update(pipelineId, {
      stage: 'scribe_generating',
      scribeConversation: conversation,
      error: null,
    }, { expectedStageVersion: pipeline.stageVersion });

    const agents = this.getAgents(pipeline.model);
    const result = await withTimeout(
      agents.scribe.regenerateSpec(scribeState, feedback),
      STAGE_TIMEOUT,
      'Scribe',
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
        new Error(`Maksimum tekrar deneme limiti aşıldı (${MAX_MANUAL_RETRIES}). Lütfen yeni bir pipeline başlatın.`),
        { statusCode: 429 },
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
    const updated = await this.store.update(pipelineId, { stage: 'cancelled' }, { expectedStageVersion: pipeline.stageVersion });
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
    const updated = await this.store.update(pipelineId, {
      stage: 'completed_partial',
      metrics: {
        ...pipeline.metrics,
        totalDurationMs: Date.now() - toEpoch(pipeline.metrics.startedAt),
      },
    }, { expectedStageVersion: pipeline.stageVersion });
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
    const terminalOrTraceStages: PipelineStage[] = ['trace_testing', 'completed', 'completed_partial', 'failed', 'cancelled'];
    if (terminalOrTraceStages.includes(pipeline.stage)) {
      throw new InvalidStageError('pre-trace stage', pipeline.stage);
    }

    return this.store.update(pipelineId, { traceEnabled: enabled });
  }

  // ─── Level 4: Adaptive Autonomy Config ───────

  /** Update pipeline-level configuration (auto-approve, thresholds, etc.) */
  async updatePipelineConfig(pipelineId: string, config: Record<string, unknown>): Promise<PipelineState> {
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

  async listPipelines(userId: string): Promise<PipelineState[]> {
    return this.store.listByUser(userId);
  }

  async updateTitle(pipelineId: string, userId: string, title: string): Promise<PipelineState> {
    const pipeline = await this.getPipeline(pipelineId);
    if (pipeline.userId !== userId) {
      throw new Error('UNAUTHORIZED');
    }
    return this.store.update(pipelineId, { title });
  }

  // ─── Private: Scribe Result Handler ──────────

  private async handleScribeResult(
    pipelineId: string,
    metrics: PipelineMetrics,
    conversation: ScribeMessageType[],
    result: ScribeResult,
    clarificationRound?: number,
  ): Promise<PipelineState> {
    if (result.type === 'clarification') {
      conversation.push({ type: 'clarification', content: result.data });
      const updated = await this.store.update(pipelineId, {
        stage: 'scribe_clarifying',
        scribeConversation: conversation,
        metrics: {
          ...metrics,
          clarificationRounds: clarificationRound ?? (metrics.clarificationRounds + 1),
        },
      });
      this.emitEvent(pipelineId, 'scribe_message', 'scribe_clarifying', result.data);
      return updated;
    }

    if (result.type === 'spec') {
      conversation.push({ type: 'spec_draft', content: result.data });
      const pipelineForJira = await this.store.getById(pipelineId);

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

        const ideaMsg = conversation.find((m) => m.type === 'user_idea');
        const originalIdea = typeof ideaMsg?.content === 'string' ? ideaMsg.content : '';
        const criticResult = await this.runCriticSpecReview(pipelineId, result.data.spec, originalIdea);

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
        logger.info({ pipelineId, approved: criticResult?.approved, score: criticResult?.overallScore }, '[Pipeline] Critic spec review completed');

        // Level 4: Explainability — record critic reasoning
        if (criticResult) {
          this.explainability.addReasoning(pipelineId, {
            agentName: 'critic',
            timestamp: new Date(),
            decision: criticResult.approved ? 'Spec onaylandi' : 'Spec reddedildi',
            reasoning: criticResult.findings?.map((f) => f.description) ?? [],
            assumptions: [],
            confidence: {
              score: criticResult.overallScore ?? 0,
              factors: [`${criticResult.findings?.length ?? 0} bulgu raporlandi`],
            },
            risks: criticResult.findings?.filter((f) => f.severity === 'critical').map((f) => f.description),
          });
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
            '[Pipeline] Auto-approved: critic score meets adaptive autonomy threshold',
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
          const proto = currentPipeline.protoConfig ?? { repoName: result.data.spec.title.replace(/\s+/g, '-').toLowerCase().slice(0, 50), repoVisibility: 'private' as const };
          const autoOwner = await this.getGitHubOwner(currentPipeline.userId);
          // Trigger Proto directly (skip human gate)
          this.runProtoAndTrace(
            pipelineId,
            { ...metrics, scribeCompletedAt: new Date(), approvedAt: new Date() } as PipelineMetrics,
            result.data.spec,
            proto.repoName,
            proto.repoVisibility,
            autoOwner,
            currentPipeline.model,
          ).catch((err) => {
            logger.error({ err, pipelineId }, '[Pipeline] Background Proto+Trace failed after auto-approve');
            this.failPipeline(pipelineId, 'Proto', err).catch((e) => logger.error({ err: e }, '[Pipeline] failPipeline also failed'));
          }).finally(() => {
            cleanupPipelineListeners(pipelineId);
          });

          return await this.store.getById(pipelineId) as PipelineState;
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
        this.runJiraEpicCreation(pipelineId, pipelineForJira.userId, pipelineForJira.jiraConfig.projectKey, result.data.spec).catch((err) => logger.warn({ err }, '[Pipeline] Non-blocking task failed'));
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
    model?: string,
  ): Promise<PipelineState> {
    const traceEmit = createActivityEmitter(pipelineId, 'trace');
    traceEmit('start', 'Scaffold dosyaları analiz ediliyor...', 5);

    // Effort-based model routing for Trace (estimate from spec criteria count)
    const traceEffort = scoreTraceEffort({ fileCount: spec?.acceptanceCriteria?.length ?? 5 });
    const traceModel = model ?? traceEffort.model;
    logger.info(`[Trace] Effort: ${traceEffort.score}/10 → Model: ${traceModel} (${traceEffort.reasoning})`);

    const agents = this.getAgents(traceModel);
    await this.writeCheckpoint(pipelineId, 'trace', `${owner}/${repo}@${branch}`);
    // Read cucumberEnabled from pipeline intermediateState
    const pipelineForCucumber = await this.getPipeline(pipelineId);
    const cucumberEnabled = (pipelineForCucumber.intermediateState as Record<string, unknown> | undefined)?.cucumberEnabled === true;
    const traceResult = await withRetry(
      (attempt) => {
        if (attempt > 1) traceEmit('retry', `Trace yeniden deneniyor (deneme ${attempt})...`, 30);
        return withTimeout(
          agents.trace.execute({ repoOwner: owner, repo, branch, spec, pipelineId, cucumberEnabled }),
          TRACE_TIMEOUT,
          'Trace',
        );
      },
      {
        maxAttempts: 3,
        onError: (err, attempt) => {
          const isTimeout = err instanceof Error && err.message.includes('timed out');
          const detail = isTimeout ? 'stage timeout' : (err instanceof Error ? err.message : String(err));
          logger.warn({ attempt, detail }, '[Pipeline] Trace attempt failed');
          traceEmit('error', `Trace hatası (deneme ${attempt}): ${isTimeout ? 'zaman aşımı' : 'beklenmeyen hata'}`, 0);
        },
      },
    );

    if (traceResult.type === 'error') {
      const isAiTimeout = traceResult.error.code === 'TRACE_AI_CALL_TIMEOUT';
      traceEmit('error', isAiTimeout
        ? 'AI servisi yanıt vermedi — test üretimi atlandı'
        : `Test üretimi başarısız: ${traceResult.error.message}`, 0);
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

    // Track pipeline token usage in billing (non-blocking)
    const completedPipeline = await this.store.getById(pipelineId);
    if (completedPipeline) {
      const pipelineMetrics = completedPipeline.metrics as unknown as Record<string, unknown> | undefined;
      const totalTokens = (pipelineMetrics?.totalTokens as number) ?? 0;
      if (totalTokens > 0) {
        incrementUsage(completedPipeline.userId, totalTokens)
          .catch(err => logger.warn({ err, pipelineId }, '[Pipeline] Usage tracking failed (non-fatal)'));
      }
    }

    // Auto-ingest pipeline results into knowledge base (non-blocking)
    if (completedPipeline) {
      new PipelineKnowledgeIngester().ingestPipelineResults({
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
      }).catch(err => logger.warn({ err, pipelineId }, '[Pipeline] Knowledge ingestion failed (non-fatal)'));
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
        `GitHub owner çözümlenemedi: ${err instanceof Error ? err.message : String(err)}`,
      );
      const failed = await this.store.update(pipelineId, { stage: 'failed', error });
      this.emitEvent(pipelineId, 'error', 'failed', error);
      return failed;
    }

    const p = await this.getPipeline(pipelineId);
    await this.store.update(pipelineId, { stage: 'trace_testing' }, { expectedStageVersion: p.stageVersion });
    this.emitEvent(pipelineId, 'stage_change', 'trace_testing');

    if (!pipeline.protoOutput) {
      throw new Error('Cannot retry Trace: protoOutput is missing');
    }
    const repo = pipeline.protoConfig?.repoName ?? pipeline.protoOutput.repo.split('/')[1] ?? pipeline.protoOutput.repo;

    return this.runTrace(
      pipelineId,
      pipeline.metrics,
      owner,
      repo,
      pipeline.protoOutput.branch,
      pipeline.approvedSpec,
      pipeline.model,
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
        `GitHub owner çözümlenemedi: ${err instanceof Error ? err.message : String(err)}`,
      );
      const failed = await this.store.update(pipelineId, { stage: 'failed', error });
      this.emitEvent(pipelineId, 'error', 'failed', error);
      return failed;
    }
    if (!pipeline.approvedSpec) {
      throw new Error('Cannot retry Proto: approvedSpec is missing');
    }
    const repoName = pipeline.protoConfig?.repoName ?? this.deriveRepoName(pipeline.approvedSpec.title);
    const repoVisibility = pipeline.protoConfig?.repoVisibility ?? 'private';

    const current = await this.getPipeline(pipelineId);
    await this.store.update(pipelineId, { stage: 'proto_building' }, { expectedStageVersion: current.stageVersion });
    this.emitEvent(pipelineId, 'stage_change', 'proto_building');

    // Per-user GitHub adapter for retry
    const userGithubService = this.createGitHubService(userGitHubToken);
    const agents = this.createAgentsForModel?.(pipeline.model ?? '', userGithubService) ?? this.getAgents(pipeline.model);
    const result = await withTimeout(
      agents.proto.execute({
        spec: pipeline.approvedSpec,
        repoName,
        repoVisibility,
        owner,
        pipelineId,
      }),
      STAGE_TIMEOUT,
      'Proto',
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

    return this.runTrace(pipelineId, pipeline.metrics, owner, repoName, result.data.branch, pipeline.approvedSpec, pipeline.model);
  }

  private async retryScribe(pipelineId: string, pipeline: PipelineState): Promise<PipelineState> {
    const agents = this.getAgents(pipeline.model);
    const scribeState = this.reconstructScribeState(pipeline);
    scribeState.pipelineId = pipelineId;
    const current = await this.getPipeline(pipelineId);
    await this.store.update(pipelineId, { stage: 'scribe_clarifying' }, { expectedStageVersion: current.stageVersion });
    this.emitEvent(pipelineId, 'stage_change', 'scribe_clarifying');

    const result = await withTimeout(
      agents.scribe.analyzIdea(scribeState),
      STAGE_TIMEOUT,
      'Scribe',
    );
    return this.handleScribeResult(pipelineId, pipeline.metrics, [...pipeline.scribeConversation], result);
  }

  // ─── Private: Utilities ──────────────────────

  /** Validate GitHub token + resolve owner. Reusable by approveSpec and retry methods. */
  private async validateGitHubAccess(userId: string): Promise<{ token: string; owner: string }> {
    const token = await this.getGitHubToken(userId);
    if (!token) {
      throw new Error('GitHub bağlantısı bulunamadı. Ayarlar sayfasından GitHub hesabınızı bağlayın.');
    }
    // Pre-validate token (skip in test/mock mode)
    if (!token.startsWith('ghp_mock')) {
      const ghRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      }).catch(() => null);
      if (ghRes && !ghRes.ok) {
        throw new Error(`GitHub token geçersiz (HTTP ${ghRes.status}). Ayarlar → GitHub bölümünden yeniden bağlayın.`);
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
    const clarificationCount = pipeline.scribeConversation.filter((m) => m.type === 'clarification').length;

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
      ? createPipelineError(PipelineErrorCode.PIPELINE_TIMEOUT, `${label}: ${(err as Error).message}`)
      : createPipelineError(PipelineErrorCode.AI_PROVIDER_ERROR, `${label}: ${err instanceof Error ? err.message : String(err)}`);

    // Retry with exponential backoff — pipeline must not stay stuck in running state
    const retryDelays = [1_000, 5_000, 15_000];
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        await this.store.update(pipelineId, { stage: 'failed', error });
        this.emitEvent(pipelineId, 'error', 'failed', error);
        return; // success
      } catch (storeErr) {
        if (attempt < retryDelays.length) {
          logger.warn({ err: storeErr, pipelineId, attempt: attempt + 1 }, `[Pipeline] failPipeline attempt failed, retrying in ${retryDelays[attempt]}ms`);
          await new Promise((r) => setTimeout(r, retryDelays[attempt]));
        } else {
          logger.error({ err: storeErr, pipelineId }, '[Pipeline] CRITICAL: failPipeline exhausted all retries. Pipeline may be stuck.');
          // Last resort: emit error event even if store update failed — at least SSE clients get notified
          try { this.emitEvent(pipelineId, 'error', 'failed', error); } catch { /* exhausted */ }
        }
      }
    }
  }

  private emitEvent(
    pipelineId: string,
    type: PipelineEvent['type'],
    stage?: PipelineStage,
    data?: unknown,
  ): void {
    this.emit?.({ pipelineId, type, stage, data });
    // Clean up event listeners when pipeline reaches a terminal state
    if (stage === 'completed' || stage === 'completed_partial' || stage === 'failed' || stage === 'cancelled') {
      cleanupPipelineListeners(pipelineId);
      // Flush accumulated token usage to DB (best-effort, non-blocking)
      this.flushTokenUsage(pipelineId).catch((err) => logger.warn({ err, pipelineId }, '[Pipeline] Token flush failed'));
    }
  }

  // ─── Private: Jira Integration Helpers ────────

  private async runJiraEpicCreation(
    pipelineId: string,
    userId: string,
    projectKey: string,
    spec: StructuredSpec,
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
    result: { branch: string; repo: string; prUrl?: string; filesCreated: number },
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
    result: { totalTests: number; coveragePercentage: number; passed: boolean },
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
    input: unknown,
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
    originalIdea: string,
  ): Promise<CriticReviewOutput | null> {
    if (!this.criticAgent) return null;
    try {
      const result: CriticResult = await this.criticAgent.reviewSpec(
        { reviewType: 'spec_review', artifact: spec, originalIdea },
        1,
      );
      if (result.type === 'review') return result.data;
      logger.warn({ pipelineId, error: result.error }, '[Pipeline] Critic spec review returned error');
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
    originalIdea: string,
  ): Promise<CriticReviewOutput | null> {
    if (!this.criticAgent) return null;
    try {
      const result: CriticResult = await this.criticAgent.reviewCode(
        { reviewType: 'code_review', artifact: protoOutput, originalIdea, referenceSpec: spec },
        1,
      );
      if (result.type === 'review') return result.data;
      logger.warn({ pipelineId, error: result.error }, '[Pipeline] Critic code review returned error');
      return null;
    } catch (err) {
      logger.warn({ err, pipelineId }, '[Pipeline] Critic code review failed (non-fatal)');
      return null;
    }
  }
}
