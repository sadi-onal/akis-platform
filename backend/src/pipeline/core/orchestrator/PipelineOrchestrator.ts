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
import type { ScribeAgent, ScribeState, ScribeResult } from '../../agents/scribe/ScribeAgent.js';
import type { ProtoAgent } from '../../agents/proto/ProtoAgent.js';
import type { TraceAgent } from '../../agents/trace/TraceAgent.js';

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
  scribeConversation: ScribeMessageType[];
  scribeOutput: ScribeOutput;
  approvedSpec: StructuredSpec;
  protoOutput: ProtoOutput;
  traceOutput: TraceOutput;
  protoConfig: { repoName: string; repoVisibility: 'public' | 'private' };
  jiraConfig: { projectKey: string; enabled: boolean; epicKey?: string };
  metrics: PipelineMetrics;
  error: PipelineError | null;
  intermediateState: Record<string, unknown>;
  attemptCount: number;
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
}

export class PipelineOrchestrator {
  /** Per-pipeline mutation lock — serializes concurrent operations on the same pipeline. */
  private locks = new Map<string, Promise<unknown>>();

  private activityLogger?: { record(entry: Record<string, unknown>): Promise<void> };

  constructor(
    private store: PipelineStore,
    private scribe: ScribeAgent,
    private proto: ProtoAgent,
    private trace: TraceAgent,
    private getGitHubOwner: (userId: string) => Promise<string>,
    private getGitHubToken: (userId: string) => Promise<string | null>,
    private createGitHubService: (token: string) => import('../pipeline-factory.js').GitHubServiceLike,
    private emit?: (event: PipelineEvent) => void,
    private createAgentsForModel?: (model: string, githubService?: import('../pipeline-factory.js').GitHubServiceLike) => AgentSet,
  ) {}

  /** Inject optional agent activity logger for integrity metrics */
  setActivityLogger(logger: { record(entry: Record<string, unknown>): Promise<void> }): void {
    this.activityLogger = logger;
  }

  /** Log agent activity (non-blocking, best-effort) */
  private logActivity(pipelineId: string, agent: 'scribe' | 'proto' | 'trace', action: string, data: Record<string, unknown> = {}): void {
    this.activityLogger?.record({ pipelineId, agent, action, ...data }).catch(() => {});
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

  private getAgents(model?: string): AgentSet {
    if (model && this.createAgentsForModel) {
      return this.createAgentsForModel(model);
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
  ): Promise<PipelineState> {
    const pipeline = await this.store.create(userId);

    const conversation: ScribeMessageType[] = [
      { type: 'user_idea', content: input.idea },
    ];

    const updateData: Partial<PipelineStateUpdate> = {
      title: input.idea.slice(0, 100),
      model,
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

    // Effort-based model routing
    const effort = scoreScribeEffort(input.idea);
    const effectiveModel = model ?? effort.model;
    logger.info(`[Scribe] Effort: ${effort.score}/10 → Model: ${effectiveModel} (${effort.reasoning})`);

    const agents = this.getAgents(effectiveModel);
    const scribeState = agents.scribe.createInitialState(input);
    scribeState.pipelineId = pipelineId;

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
    const agents = userGithubService
      ? (this.createAgentsForModel?.(protoModel, userGithubService) ?? this.getAgents(protoModel))
      : this.getAgents(protoModel);
    await this.writeCheckpoint(pipelineId, 'proto', spec.title);
    const protoResult = await withRetry(
      (attempt) => {
        if (attempt > 1) protoEmit('retry', `Proto yeniden deneniyor (deneme ${attempt})...`, 25);
        return withTimeout(
          agents.proto.execute({ spec, repoName, repoVisibility, owner, pipelineId }),
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

    if (!requiresTests) {
      // Skip Trace — mark as completed directly
      await this.store.update(pipelineId, {
        protoOutput: protoResult.data,
        stage: 'completed',
        metrics: { ...protoCompletedMetrics, traceCompletedAt: new Date(), totalDurationMs: Date.now() - toEpoch(protoCompletedMetrics.startedAt) },
      });
      this.emitEvent(pipelineId, 'stage_change', 'completed');
      return;
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
      }).catch(() => {});
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
        this.runJiraEpicCreation(pipelineId, pipelineForJira.userId, pipelineForJira.jiraConfig.projectKey, result.data.spec).catch(() => {});
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
      }).catch(() => {});
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
      await this.store.update(pipelineId, {
        intermediateState: {
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
}
