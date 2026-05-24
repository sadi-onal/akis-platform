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
  SubStep,
} from '../contracts/PipelineTypes.js';
import { JiraMCPService } from '../../../services/mcp/adapters/JiraMCPService.js';
import { getConnectionStatus as getAtlassianStatus } from '../../../services/atlassian/AtlassianMcpClient.js';
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
import { injectArtifacts } from '../../agents/proto/artifactInjector.js';
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
import { AiCallsService } from '../ai-calls/AiCallsService.js';
import { pipelineCallContext } from '../ai-calls/pipelineCallContext.js';
import {
  buildScribeReasoning,
  buildProtoReasoning,
  buildTraceReasoning,
  buildCriticReasoning,
} from '../explainability/reasoningFactory.js';
import { buildAcCoverage } from '../explainability/acCoverage.js';
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
  jiraConfig: { projectKey: string; enabled: boolean; epicKey?: string; siteUrl?: string };
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
  /**
   * Accumulated AI usage per pipeline (flushed to DB when each stage finalizes).
   *
   * `estimatedCostUsd` is summed alongside the token counts so the Settings →
   * Usage tab can show real spend. Each AI call's cost may be 0 (mock provider
   * or unknown model) — those are simply additive zeros and don't leak into
   * `pipelines.metrics.estimatedCost` when nothing real was charged
   * (`hasCost` gates the write).
   */
  private tokenAccumulators = new Map<
    string,
    { inputTokens: number; outputTokens: number; estimatedCostUsd: number; hasCost: boolean }
  >();

  /** Create a callback that accumulates token + cost usage for a specific pipeline. */
  createTokenCallback(pipelineId: string): import('../pipeline-factory.js').TokenUsageCallback {
    return (usage) => {
      const acc = this.tokenAccumulators.get(pipelineId) ?? {
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        hasCost: false,
      };
      acc.inputTokens += usage.inputTokens;
      acc.outputTokens += usage.outputTokens;
      if (typeof usage.estimatedCostUsd === 'number' && Number.isFinite(usage.estimatedCostUsd)) {
        acc.estimatedCostUsd += usage.estimatedCostUsd;
        acc.hasCost = true;
      }
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
      // Build the updated metrics blob. `estimatedCost` is only added when at
      // least one real per-call cost was reported in this run — keeps the
      // JSONB field absent for mock-provider pipelines so the usage endpoint's
      // per-token fallback still kicks in instead of pinning the value to 0.
      const updatedMetrics: PipelineMetrics = {
        ...metrics,
        inputTokens: (metrics.inputTokens ?? 0) + acc.inputTokens,
        outputTokens: (metrics.outputTokens ?? 0) + acc.outputTokens,
        totalTokens: (metrics.totalTokens ?? 0) + acc.inputTokens + acc.outputTokens,
      };
      const persistedCost = metrics.estimatedCost ?? 0;
      if (acc.hasCost || persistedCost > 0) {
        const sum = persistedCost + acc.estimatedCostUsd;
        // 6-decimal rounding matches `pricing.estimateCostUsd` and the
        // numeric(12,6) column on `job_ai_calls` so reads/writes stay stable.
        updatedMetrics.estimatedCost = Number(sum.toFixed(6));
      }
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
    const acc = this.tokenAccumulators.get(pipelineId);
    const accInput = acc?.inputTokens ?? 0;
    const accOutput = acc?.outputTokens ?? 0;
    const inputTokens = (persisted.inputTokens ?? 0) + accInput;
    const outputTokens = (persisted.outputTokens ?? 0) + accOutput;
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
  // ─── P5b — AI request log viewer ───────────────────
  private aiCallsService: AiCallsService | null = null;

  // ─── Chat memory (issue #462) ────────────────────
  private chatMemory: ChatMemoryContextService = chatMemoryContextService;

  // ─── Chat narrator: stage-start timestamps (2026-05-23) ──
  /**
   * In-memory started-at timestamps per stage per pipeline. Server-truth
   * source for `durationMs` calc on completion events (spec NF-2).
   * Key format: `${pipelineId}:${stage}`. Entries are cleared either:
   *   - per-stage on success via `getStageDurationMs` (one-shot read+delete);
   *   - per-pipeline on terminal transition via `clearStageStarts`, called
   *     from `failPipeline` and `_cancelPipeline` (code-review follow-up
   *     2026-05-23 — prevents unbounded growth in long-running backends).
   */
  private stageStartedAt = new Map<string, number>();

  /**
   * PR-V-github-401-graceful — optional hook to clear stale GitHub tokens
   * from `github_integrations` after a 401. Constructor-injected (not always
   * provided in tests / DI seams that don't talk to the DB). When unset, the
   * orchestrator still surfaces the user-facing GITHUB_TOKEN_INVALID error;
   * the cleanup is a separate concern.
   */
  private invalidateGitHubToken?: (userId: string) => Promise<boolean>;

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

  /** PR-V-github-401-graceful — install token-invalidation hook (DI seam). */
  setGitHubTokenInvalidator(fn: (userId: string) => Promise<boolean>): void {
    this.invalidateGitHubToken = fn;
  }

  /**
   * PR-V-github-401-graceful — best-effort cleanup helper. When a pipeline
   * error surfaces with code `GITHUB_TOKEN_INVALID`, drop the user's stale
   * token row from `github_integrations` so the next pipeline starts from
   * an empty state (forcing the reconnect modal). Safe to call without an
   * invalidator wired — becomes a logged no-op.
   */
  private async maybeInvalidateGitHubTokenOnAuthError(
    pipelineId: string,
    errorCode: string
  ): Promise<void> {
    if (errorCode !== 'GITHUB_TOKEN_INVALID') return;
    if (!this.invalidateGitHubToken) {
      logger.debug(
        { pipelineId },
        '[Pipeline] GITHUB_TOKEN_INVALID — no invalidator wired, skipping cleanup'
      );
      return;
    }
    const pipelineForAuth = await this.store.getById(pipelineId);
    const ownerId = pipelineForAuth?.userId;
    if (!ownerId) return;
    try {
      const cleared = await this.invalidateGitHubToken(ownerId);
      logger.warn(
        { pipelineId, userId: ownerId, cleared },
        '[Pipeline] GITHUB_TOKEN_INVALID — stale github_integrations row cleared'
      );
    } catch (cleanupErr) {
      logger.error(
        { pipelineId, userId: ownerId, err: String(cleanupErr) },
        '[Pipeline] GITHUB_TOKEN_INVALID — token invalidation failed (continuing)'
      );
    }
  }

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

  /**
   * P5b: Lazily-built AiCallsService for the admin/debug AI log viewer.
   * Returns the AI calls recorded under `job_ai_calls` for jobs whose
   * payload carries this pipeline's id. Pipelines that never spawn such a
   * job yield an empty list — the panel renders the empty state.
   */
  getAiCallsService(): AiCallsService {
    if (!this.aiCallsService) {
      this.aiCallsService = new AiCallsService();
    }
    return this.aiCallsService;
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
   * PR-V5: emit an explicit `status: 'completed'` SSE activity for the
   * outgoing stage BEFORE the orchestrator advances the pipeline to the
   * next stage. This replaces the frontend's old heuristic of "stage X is
   * not the latest activity ⇒ stage X is done", which caused premature
   * checkmarks on Scribe→Proto / Proto→Trace handoffs (the next stage's
   * first activity would land before the previous stage's actual exit).
   *
   * Encoding: `step: 'stage_completed'` is the DB-schema-compatible
   * carrier for the new `status` field (the `pipeline_activities` table
   * has no dedicated status column). `activityEmitter.rowToActivity`
   * rehydrates `status: 'completed'` from this step value on replay so
   * fresh page loads see the same completion signal as live SSE listeners.
   */
  private emitStageCompleted(
    pipelineId: string,
    stage: 'scribe' | 'proto' | 'trace',
    summary?: string
  ): void {
    emitActivity({
      pipelineId,
      stage,
      step: 'stage_completed',
      message: summary ?? `${stage} aşaması tamamlandı`,
      progress: 100,
      status: 'completed',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Persist a reasoning entry without blocking the caller.
   *
   * `addReasoning` is async since PDP-2 Wave 2 (F-03 + F-11 / NFR-1) — it
   * upserts into `pipeline_reasonings`. Most call sites in this orchestrator
   * are inside long-running stage transitions where adding ~5ms of DB latency
   * sequentially would compound; we fire-and-forget and surface failures via
   * the logger instead.
   *
   * PR-U3 M7: previously the write was a single fire-and-forget call — a
   * transient DB blip would silently drop reasoning, leaving the user with
   * an empty Açıklama tab and no signal anything went wrong. Three retries
   * with exponential backoff (50/200/600ms) cover the common transient
   * cases (connection saturation, brief lock contention) before we fall
   * back to logging + flagging the pipeline as "explainability degraded"
   * so the UI can surface a banner instead of an empty card.
   */
  private persistReasoning(
    pipelineId: string,
    reasoning: import('../explainability/ExplainabilityTypes.js').AgentReasoning
  ): void {
    const attempt = async (n: number): Promise<void> => {
      try {
        await this.explainability.addReasoning(pipelineId, reasoning);
      } catch (err) {
        if (n < 3) {
          const delay = 50 * 4 ** n; // 50, 200, 800 — caps under 1s for the 3rd retry
          await new Promise((r) => setTimeout(r, delay));
          return attempt(n + 1);
        }
        logger.warn(
          { err, pipelineId, agent: reasoning.agentName, retries: n },
          '[Pipeline] PR-U3 M7: failed to persist reasoning after retries; flagging pipeline as explainability-degraded'
        );
        // Best-effort flag so the UI can show a banner. Same error
        // tolerance — we never fail the pipeline on an explainability issue.
        try {
          const pipeline = await this.store.getById(pipelineId);
          const intermediate = (pipeline?.intermediateState ?? {}) as Record<string, unknown>;
          await this.store.update(pipelineId, {
            intermediateState: {
              ...intermediate,
              explainabilityDegraded: true,
              explainabilityDegradedAt: new Date().toISOString(),
            },
          });
        } catch (flagErr) {
          logger.warn(
            { flagErr, pipelineId },
            '[Pipeline] PR-U3 M7: also failed to set explainabilityDegraded flag — UI will see empty Açıklama'
          );
        }
      }
    };
    void attempt(0);
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
    output: import('../contracts/PipelineTypes.js').ProtoOutput,
    scribeOutput?: import('../contracts/PipelineTypes.js').ScribeOutput
  ): void {
    this.persistReasoning(pipelineId, buildProtoReasoning(output, { scribeOutput }));
  }

  /**
   * PR-V-spec-artifacts — inject `docs/PRD.md`, `docs/TECHNICAL-ANALYSIS.md`,
   * and optionally `docs/API-CONTRACT.md` into Proto's file set before the
   * orchestrator persists `protoOutput` or hands it to downstream stages.
   *
   * Called right after each Proto success path so the artifacts travel
   * through:
   *   - the dryRun preview cache (used by Sandpack + push-confirm gate)
   *   - Trace's `inputFiles` (so test plans see the spec artifacts)
   *   - the eventual GitHub push (auto-push, push-confirm, and iteration)
   *
   * Idempotent — see {@link injectArtifacts}. Failures here are non-fatal:
   * we log and continue with the original file set so a bad heuristic can't
   * brick a healthy pipeline run.
   */
  private applyArtifactInjection(
    protoOutput: import('../contracts/PipelineTypes.js').ProtoOutput,
    scribeOutput?: import('../contracts/PipelineTypes.js').ScribeOutput
  ): import('../contracts/PipelineTypes.js').ProtoOutput {
    try {
      const result = injectArtifacts({
        files: protoOutput.files,
        scribeOutput,
      });
      if (result.added.length === 0) return protoOutput;
      const totalLOC = result.files.reduce((sum, f) => sum + (f.linesOfCode ?? 0), 0);
      return {
        ...protoOutput,
        files: result.files,
        metadata: {
          ...protoOutput.metadata,
          filesCreated: result.files.length,
          totalLinesOfCode: totalLOC,
        },
      };
    } catch (err) {
      logger.warn({ err }, '[Pipeline] applyArtifactInjection failed — using original files');
      return protoOutput;
    }
  }

  /**
   * PR-D: Compute AC coverage report from the current pipeline outputs and
   * merge it into `intermediateState.acCoverage`. Read-modify-write keeps
   * existing keys (criticBlock, criticCodeOutput, …) intact. Best-effort —
   * persistence failures are swallowed with a warning so a transient DB hiccup
   * doesn't crash the orchestrator.
   */
  private async persistAcCoverage(
    pipelineId: string,
    protoOutput: import('../contracts/PipelineTypes.js').ProtoOutput,
    scribeOutput: import('../contracts/PipelineTypes.js').ScribeOutput | undefined,
    traceOutput?: import('../contracts/PipelineTypes.js').TraceOutput
  ): Promise<void> {
    try {
      const report = buildAcCoverage(scribeOutput, protoOutput, traceOutput);
      if (report.totalAcs === 0) return; // nothing to persist if spec had no AC
      const current = await this.store.getById(pipelineId);
      const existing = (current?.intermediateState ?? {}) as Record<string, unknown>;
      await this.store.update(pipelineId, {
        intermediateState: { ...existing, acCoverage: report },
      });
    } catch (err) {
      logger.warn({ err, pipelineId }, '[Pipeline] Failed to persist acCoverage');
    }
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
      // P9: single source of truth — schema default, DB column default, and
      // orchestrator fallback all align on `true`. Trace is opt-out: the user
      // can flip the ChatPanel toggle off before submitting, otherwise we run
      // the verification step the platform's whole "Scribe→Proto→Trace" thesis
      // depends on.
      traceEnabled: traceEnabled ?? true,
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
    pipelineCallContext.enterWith({ pipelineId });
    const emit = createActivityEmitter(pipelineId, 'scribe');
    emit('start', 'Kullanıcı fikri analiz ediliyor...', 5);
    // Chat narrator (2026-05-23): snapshot stage start for server-truth
    // durationMs on the eventual `scribe_completed` event. Idempotent —
    // calling markStageStarted twice just refreshes the start (e.g. when
    // clarification rounds prolong Scribe — we treat the latest restart as
    // the wall-clock for the next completion).
    this.markStageStarted(pipelineId, 'scribe');

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
    pipelineCallContext.enterWith({ pipelineId });
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

    // Jira hook: create the Epic now that the user has approved + opted in.
    // The old hook on Scribe completion never fires for our chat-driven flow
    // because the picker lives on the PlanCard (which only appears after
    // Scribe is done) — by the time the user opts in, that hook has long
    // since passed. Running here means Epic creation happens in parallel
    // with Proto, and Proto's completion comment lands on the same Epic.
    if (jiraConfig?.enabled && jiraConfig.projectKey) {
      this.runJiraEpicCreation(pipelineId, pipeline.userId, jiraConfig.projectKey, spec).catch(
        (err) => logger.warn({ err }, '[Pipeline] Jira Epic creation kicked off')
      );
    }

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
    pipelineCallContext.enterWith({ pipelineId });
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
      // PR-V-github-401-graceful — clear stale token row when Proto's
      // GitHub call surfaced a 401-derived error.
      await this.maybeInvalidateGitHubTokenOnAuthError(pipelineId, protoResult.error.code);
      await this.store.update(pipelineId, { stage: 'failed', error: protoResult.error });
      this.emitEvent(pipelineId, 'error', 'failed', protoResult.error);
      return;
    }

    // PR-V-spec-artifacts: refresh docs/PRD.md, docs/TECHNICAL-ANALYSIS.md
    // (and docs/API-CONTRACT.md when relevant) on every iteration so the
    // user's repo stays in sync with the latest spec snapshot.
    protoResult.data = this.applyArtifactInjection(protoResult.data, pipeline.scribeOutput);

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
    userGithubService?: import('../pipeline-factory.js').GitHubServiceLike,
    /**
     * B5 — user-supplied correction text from the push-confirm gate
     * (`POST /api/pipelines/:id/iterate-with-feedback`). When set, it is
     * prepended to Proto's knowledge context so the agent generates a
     * revised scaffold matching the request.
     */
    feedbackContext?: string
  ): Promise<void> {
    pipelineCallContext.enterWith({ pipelineId });
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
    let protoKnowledge = await this.applyChatMemory(pipelineData, protoKnowledgeBase, spec.title, {
      messageIndex: (pipelineData.scribeConversation?.length ?? 0) + 1,
    });
    // B5 — prepend user's correction request from the push-confirm gate so
    // Proto regenerates the scaffold honoring it. Block is intentionally
    // first + visually distinct so the AI gives it primary weight.
    if (feedbackContext && feedbackContext.trim().length > 0) {
      const feedbackBlock = [
        '## KULLANICI DÜZELTME İSTEĞİ',
        'Aşağıdaki düzeltme isteğini kodu üretirken **birinci öncelik** olarak dikkate al:',
        '',
        feedbackContext.trim(),
        '',
      ].join('\n');
      protoKnowledge = protoKnowledge ? `${feedbackBlock}\n\n${protoKnowledge}` : feedbackBlock;
    }
    // Issue #464 BUG-C — pull persisted imageBlocks from intermediateState
    // so downstream Proto + Trace calls can see the same screenshots Scribe saw.
    const pipelineImageBlocks = readPipelineImageBlocks(pipelineData.intermediateState);

    // PDP-3 B4: when the preview-confirm gate is active, run Proto in dryRun
    // mode so it generates the scaffold WITHOUT touching GitHub. The user
    // inspects the in-memory `protoOutput.files` via Sandpack preview, then
    // the orchestrator's `confirmPush` calls `proto.pushScaffoldFiles` to
    // commit the same files — no LLM regeneration cost. The legacy auto-push
    // behaviour stays available behind AUTO_PUSH_AFTER_PROTO=true.
    //
    // NOTE: Read `process.env` directly here rather than going through
    // `getEnv()`. The orchestrator is invoked from unit tests that don't
    // boot the full app and therefore haven't set every required env var
    // (notably DATABASE_URL). `getEnv()` would lazy-parse the full zod
    // schema here and throw; for a single-flag boolean, `process.env`
    // is sufficient and avoids the validation side effect.
    const previewGateEnabled = process.env.AUTO_PUSH_AFTER_PROTO !== 'true';

    await this.writeCheckpoint(pipelineId, 'proto', spec.title);
    const protoIteration = await this.appendProtoStarted(pipelineId);
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
            dryRun: previewGateEnabled,
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
      // PR-V-github-401-graceful — clear stale token row when Proto's
      // GitHub call surfaced a 401-derived error.
      await this.maybeInvalidateGitHubTokenOnAuthError(pipelineId, protoResult.error.code);
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

    // Chat narrator (2026-05-23, code-review follow-up): `proto_completed`
    // event is emitted AFTER the Validator + Critic-code block runs so
    // sub-steps reflect those agents' findings for THIS iteration (AC-2,
    // spec 2026-05-23-chat-agent-narrator-pattern-a-design.md §5). See the
    // three `emitProtoCompletedForThisIteration` call sites below — iterate-
    // retry return, hard-block return, and the happy path.

    const pipeline = await this.getPipeline(pipelineId);

    // PR-V-spec-artifacts: inject docs/PRD.md + docs/TECHNICAL-ANALYSIS.md
    // (and docs/API-CONTRACT.md when applicable) BEFORE Proto's files are
    // persisted, surfaced via Sandpack preview, fed to Trace, or pushed to
    // GitHub. The injection is idempotent + non-fatal — see
    // {@link applyArtifactInjection}.
    protoResult.data = this.applyArtifactInjection(protoResult.data, pipeline.scribeOutput);

    if (!pipeline.traceEnabled) {
      // PR-V5: explicit Proto completion signal — Trace is disabled so the
      // pipeline jumps straight to `completed`. Emit before the transition
      // so SSE consumers see Proto close cleanly.
      this.emitStageCompleted(pipelineId, 'proto');
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
      // Chat narrator: emit proto_completed before returning. Validator +
      // Critic-code haven't run on the no-Trace fast path, so sub-steps will
      // contain only the agent-sourced rows (files written / iskelet üretildi).
      await this.emitProtoCompletedForIteration(pipelineId, protoIteration, protoResult.data);
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
      const isValidatableLang = (
        path: string
      ): 'typescript' | 'javascript' | 'json' | 'html' | 'css' | null => {
        if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
        if (
          path.endsWith('.js') ||
          path.endsWith('.jsx') ||
          path.endsWith('.mjs') ||
          path.endsWith('.cjs')
        )
          return 'javascript';
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
          .filter(
            (
              f
            ): f is {
              path: string;
              content: string;
              language: 'typescript' | 'javascript' | 'json' | 'html' | 'css';
            } => f !== null
          ),
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
        decision: validationResult.passed ? 'Kod doğrulama başarılı' : 'Kod doğrulama başarısız',
        reasoning: [
          `Skor: ${validationResult.score}/100`,
          `${validationResult.summary.errors} hata, ${validationResult.summary.warnings} uyarı`,
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
        // Chat narrator: emit proto_completed for the iteration that the
        // validator rejected. validationResult is already persisted to
        // intermediateState (line above), so the sub-step row will show
        // the validator error count.
        await this.emitProtoCompletedForIteration(pipelineId, protoIteration, protoResult.data);
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

      const criticCodeEmit = createActivityEmitter(pipelineId, 'critic', { criticPhase: 'code' });
      criticCodeEmit(
        'start',
        'Üretilen kod inceleniyor...',
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

        // T4: append one entry to `iterationHistory` for every completed
        // Proto → Critic pass. Each entry pins the Proto confidence + Critic
        // score for the iteration so the UI can render the trajectory
        // ("Critic %52 → %67 → %84 — agent kendi kendine iyileşiyor")
        // instead of only showing the final iteration's score.
        //
        // Iteration number derives from existing history length so manual
        // iterations (iterateProtoFromFeedback) get the next sequential
        // number too — driving from `criticIterateRetryCount` would skip
        // user-driven iterations since that counter only tracks the auto
        // critic-iterate loop. Existing `criticCodeOutput` keeps tracking
        // the latest iteration so every downstream consumer (gate, score
        // bar, attention chip) stays backward-compatible.
        const protoVerification = (
          protoResult.data as { verificationReport?: { confidenceScore?: number } }
        ).verificationReport;
        const protoConfidence =
          typeof protoVerification?.confidenceScore === 'number'
            ? protoVerification.confidenceScore
            : null;
        const findings = criticResult.findings ?? [];
        const existingHistory = Array.isArray(existingIntermediate.iterationHistory)
          ? (existingIntermediate.iterationHistory as Array<Record<string, unknown>>)
          : [];
        const newIterationEntry = {
          iteration: existingHistory.length + 1,
          protoConfidence,
          criticScore: criticResult.overallScore ?? null,
          criticFindingsCount: findings.length,
          criticCriticalCount: findings.filter((f) => f.severity === 'critical').length,
          timestamp: new Date().toISOString(),
          decision: criticResult.approved ? 'approved' : 'rejected',
        };
        const nextHistory = [...existingHistory, newIterationEntry];

        await this.store.update(pipelineId, {
          intermediateState: {
            ...existingIntermediate,
            criticCodeOutput: criticResult,
            iterationHistory: nextHistory,
          },
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

      // ─── PR-F: Critic guardrail mode ──────────────
      // Mimari refactor (2026-05-19): Critic ana akıştan "guardrail"
      // konumuna çekildi. Pipeline yalnızca findings içinde severity=critical
      // bir bulgu varsa `awaiting_critic_resolution`'a düşer; aksi halde
      // findings intermediateState'e yazılır ve akış (Trace / push-gate)
      // sessizce devam eder. PR-A öncesi davranış (approved=false → her
      // zaman hard-block) artık geriye dönük yalnızca `hasCriticalFinding`
      // üzerinden tetiklenir. Bkz. memory: coverage_metric_research_findings.
      const hasCritical = criticResult?.hasCriticalFinding === true;
      if (criticResult && hasCritical) {
        this.recordProtoReasoning(pipelineId, protoResult.data, pipeline.scribeOutput);
        // PR-D: persist AC coverage even when Critic blocks — the user
        // still wants to see which kabul kriteri the (rejected) scaffold
        // does/doesn't address while deciding to iterate vs override.
        await this.persistAcCoverage(pipelineId, protoResult.data, pipeline.scribeOutput);

        // ─── PR-F3: Critic critical-finding iterate-loop ──────────────
        // Mimari karar (2026-05-19): Kullanıcıyı hard-block etmeden önce
        // Proto'yu kritik bulgular feedback olarak verilerek otomatik
        // re-iterate ediyoruz. Max retry sayısı CRITIC_CRITICAL_MAX_ITERATE_RETRIES
        // env var ile parametrik (default 3). Retry tükenince mevcut
        // hard-block davranışı (awaiting_critic_resolution) devreye girer.
        // Pattern Trace iterate-loop ile birebir aynı.
        const criticIterateDecision = await this.evaluateCriticIterateLoop(
          pipelineId,
          criticResult
        );
        if (criticIterateDecision.shouldIterate) {
          logger.info(
            {
              pipelineId,
              retry: criticIterateDecision.nextRetry,
              maxRetries: criticIterateDecision.maxRetries,
              criticalCount: criticIterateDecision.criticalCount,
            },
            '[Pipeline] PR-F3 Critic iterate-loop — re-iterating Proto with critical findings'
          );
          // Persist criticCodeOutput so the UI sees the failing snapshot
          // until the next retry overwrites it.
          const stateBeforeDispatch = await this.store.getById(pipelineId);
          const intermediateBeforeDispatch = (stateBeforeDispatch?.intermediateState ??
            {}) as Record<string, unknown>;
          await this.store.update(pipelineId, {
            protoOutput: protoResult.data,
            metrics: protoCompletedMetrics,
            intermediateState: {
              ...intermediateBeforeDispatch,
              criticCodeOutput: criticResult,
            },
          });
          // Chat narrator: emit proto_completed for THIS rejected iteration
          // before dispatching the retry. The next iteration's
          // `runProtoAndTrace` will append its own pair of proto events.
          await this.emitProtoCompletedForIteration(
            pipelineId,
            protoIteration,
            protoResult.data
          );
          // Activity emit — Critic retry-trigger surfaces on Proto column
          // ("Critic düzeltiyor (n/max)" badge).
          const criticIterateEmit = createActivityEmitter(pipelineId, 'critic', {
            criticPhase: 'code',
          });
          criticIterateEmit(
            'retry-trigger',
            // T5: display-only rename — Critic → Değerlendirme
            `Değerlendirme kritik bulgu raporladı — Proto yeniden çalışıyor (${criticIterateDecision.nextRetry}/${criticIterateDecision.maxRetries})`,
            80,
            criticIterateDecision.feedback,
            criticIterateDecision.nextRetry,
            'pipeline.critic.iterate.retry'
          );
          // Fire-and-forget dispatch. Critic review yine kendi içinde
          // sarmalanır; sonraki run da kritik bulgu raporlarsa loop devam
          // eder. Max retry sonrası fallback hard-block tetiklenir.
          void this.dispatchCriticIterate(pipelineId, criticIterateDecision.feedback).catch(
            (err) => {
              logger.error(
                { err, pipelineId },
                '[Pipeline] PR-F3 Critic iterate-loop dispatch failed'
              );
            }
          );
          return;
        }

        const currentStateForBlock = await this.store.getById(pipelineId);
        const existingIntermediateBlock = (currentStateForBlock?.intermediateState ?? {}) as Record<
          string,
          unknown
        >;
        await this.store.update(pipelineId, {
          protoOutput: protoResult.data,
          stage: 'awaiting_critic_resolution',
          metrics: protoCompletedMetrics,
          intermediateState: {
            ...existingIntermediateBlock,
            criticCodeOutput: criticResult,
            criticBlock: {
              blockedAt: new Date().toISOString(),
              overallScore: criticResult.overallScore,
              findingsCount: criticResult.findings?.length ?? 0,
              maxSeverity: criticResult.maxSeverity,
              manuallyOverridden: false,
            },
          },
        });
        // Chat narrator: emit proto_completed for the iteration that
        // triggered the hard-block so the user sees the gate-causing
        // Proto bubble with critic findings as sub-steps.
        await this.emitProtoCompletedForIteration(
          pipelineId,
          protoIteration,
          protoResult.data
        );
        this.emitEvent(pipelineId, 'stage_change', 'awaiting_critic_resolution');
        // PR-T3 S1: aynı `gate_open` pattern'i — frontend SSE üzerinden
        // bu transition'ı kaçırmasın diye sentetik bir activity yayınla.
        emitActivity({
          pipelineId,
          stage: 'critic',
          step: 'gate_open',
          // T5: display-only rename — Critic → Değerlendirme
          message: 'Değerlendirme kritik bulgu raporladı — kullanıcı kararı bekleniyor',
          progress: 100,
          timestamp: new Date().toISOString(),
        });
        logger.info(
          {
            pipelineId,
            score: criticResult.overallScore,
            findings: criticResult.findings?.length ?? 0,
            maxSeverity: criticResult.maxSeverity,
          },
          '[Pipeline] PR-F critic hard-block — severity=critical, pipeline halted at awaiting_critic_resolution'
        );
        return;
      }
      // Critic guardrail: findings intermediateState'te zaten yazıldı
      // (yukarıdaki `criticCodeOutput` yazımı). severity<critical ise akış
      // doğal olarak Trace / push-gate'e devam eder.
    }

    // Chat narrator (2026-05-23): emit proto_completed AFTER validator +
    // critic-code have written their results to intermediateState, so the
    // sub-step rows on the Proto bubble reflect THIS iteration's findings
    // (AC-2). For early-return paths (Trace disabled, validator hard-fail,
    // critic iterate-retry, critic hard-block) the emit happens at the
    // dedicated site before each `return` instead.
    await this.emitProtoCompletedForIteration(pipelineId, protoIteration, protoResult.data);

    // Level 4: Explainability — record Proto reasoning
    this.recordProtoReasoning(pipelineId, protoResult.data, pipeline.scribeOutput);
    // PR-D: AC coverage report — per-AC binary checklist surfaced in
    // intermediateState.acCoverage for the explanation rail to render.
    await this.persistAcCoverage(pipelineId, protoResult.data, pipeline.scribeOutput);

    // PR-F2 (2026-05-19): preview-confirm gate flow — Trace BEFORE push gate.
    //
    // Önceki davranış (PR-F öncesi): preview gate ON ise pipeline direkt
    // `awaiting_push_confirm`'a düşer, Trace ancak `confirmPush` sonrası
    // çalışır. Bu sırada Trace fail olursa kullanıcı zaten push yapmış olur
    // — iterate-loop dışında değişen bir şey yok ama "test sonucunu görmeden
    // GitHub'a kod gönderdim" hissi yaratıyordu. Manuel test (2026-05-19)
    // log'unda da:
    //   Critic code approved (88) → B4 gate
    //   ← Trace hiç çalışmadı.
    //
    // Yeni davranış: Proto'nun dryRun çıktısını TraceAgent'e `inputFiles`
    // olarak besle, GitHub fetch olmadan testler + AC coverage hesaplansın.
    // Trace iterate-loop (uncovered AC veya test fail → Proto re-iterate)
    // bu noktada zaten çalışır; retry tükenince push gate'e devredilir.
    if (previewGateEnabled) {
      // PR-V5: explicit Proto completion signal — preview-gate path hands
      // off to Trace dryRun. Emit before the transition so SSE consumers
      // see Proto close cleanly (the first Trace activity otherwise tips
      // the frontend into "Proto done" via stale lastIdx heuristic).
      this.emitStageCompleted(pipelineId, 'proto');
      // Persist Proto output + transition to trace_testing so the UI cinema
      // column lights up. We deliberately stay short of the gate until Trace
      // is done.
      await this.store.update(pipelineId, {
        protoOutput: protoResult.data,
        stage: 'trace_testing',
        metrics: protoCompletedMetrics,
      });
      this.emitEvent(pipelineId, 'stage_change', 'trace_testing');

      // Jira hook: comment Proto result (non-blocking) — same wiring as the
      // non-preview branch.
      if (pipeline.jiraConfig?.epicKey) {
        this.runJiraProtoComment(pipeline.userId, pipeline.jiraConfig.epicKey, {
          branch: protoResult.data.branch,
          repo: protoResult.data.repo,
          prUrl: protoResult.data.prUrl,
          filesCreated: protoResult.data.metadata.filesCreated,
        }).catch((err) => logger.warn({ err }, '[Pipeline] Non-blocking task failed'));
      }

      if (await this.isCancelled(pipelineId)) return;

      logger.info(
        { pipelineId, fileCount: protoResult.data.files.length },
        '[Pipeline] PR-F2 Trace dryRun starting before push gate'
      );

      await this.runTrace(
        pipelineId,
        metrics,
        owner,
        repoName,
        protoResult.data.branch,
        spec,
        model,
        // PR-F2: post-Trace handoff → awaiting_push_confirm instead of completed,
        // and feed Proto's in-memory files to Trace so it doesn't try to read
        // a branch that doesn't exist yet.
        {
          dryRun: true,
          inputFiles: protoResult.data.files.map((f) => ({
            filePath: f.filePath,
            content: f.content,
          })),
          postSuccess: 'awaiting_push_confirm',
        }
      );
      return;
    }

    // PR-V5: explicit Proto completion signal (legacy auto-push path).
    this.emitStageCompleted(pipelineId, 'proto');
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

    // PR-V-duplicate-repo (2026-05-20): the legacy auto-push path actually
    // creates the repo inside Proto.execute, so a suffix conflict here is
    // realized on GitHub. `protoResult.data.repo` carries the resolved
    // "<owner>/<name>" — pull the name half and feed it to Trace, otherwise
    // Trace would read from a stale `repoName` that no longer exists.
    const resolvedRepoName = protoResult.data.repo.split('/').pop() ?? repoName;
    if (resolvedRepoName !== repoName) {
      const pipelineForConfig = await this.getPipeline(pipelineId);
      if (pipelineForConfig.protoConfig) {
        await this.store.update(pipelineId, {
          protoConfig: { ...pipelineForConfig.protoConfig, repoName: resolvedRepoName },
        });
      }
    }
    await this.runTrace(
      pipelineId,
      metrics,
      owner,
      resolvedRepoName,
      protoResult.data.branch,
      spec,
      model
    );
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

    // Chat narrator (2026-05-23): reset scribe stage start so the
    // regenerated draft's `scribe_completed` event reports an accurate
    // durationMs for *this* attempt (not the original Scribe pass).
    this.markStageStarted(pipelineId, 'scribe');

    const agents = this.getAgents(pipeline.model);
    const result = await withTimeout(
      agents.scribe.regenerateSpec(scribeState, feedback),
      STAGE_TIMEOUT,
      'Scribe'
    );

    if (result.type === 'spec') {
      conversation.push({ type: 'spec_draft', content: result.data });
      // PR-V5: explicit Scribe completion signal — same rationale as
      // handleScribeResult's spec branch. Emit before the awaiting_approval
      // transition so SSE consumers see Scribe close cleanly.
      this.emitStageCompleted(pipelineId, 'scribe');
      // Chat narrator (2026-05-23): scribe_completed event for the
      // regenerated spec — iteration counter increments so the chat shows
      // a fresh Scribe baloncuğu.
      const scribeIterationRegen = this.countPriorEvents(conversation, 'scribe_completed') + 1;
      // Code-review follow-up 2026-05-23: drop the previous Scribe pass's
      // `criticSpecOutput` from the snapshot before computing sub-steps.
      // The regen path doesn't re-run Critic (architecture: regenerate-only,
      // no automatic critique pass), so leaving the old findings in place
      // would label the v2 draft with v1's stale criticism. Mutating just
      // the local snapshot — DB row is untouched so a future re-critique
      // (if architecture changes) still has its anchor.
      const cleanPipelineForRegen = {
        ...pipeline,
        scribeOutput: result.data,
        intermediateState: {
          ...(pipeline.intermediateState ?? {}),
          criticSpecOutput: undefined,
        },
      } as PipelineState;
      const scribeSubStepsRegen = this.buildSubStepsForStage(cleanPipelineForRegen, 'scribe');
      conversation.push(
        this.buildScribeCompletedEvent(
          pipelineId,
          scribeIterationRegen,
          result.data,
          scribeSubStepsRegen.length > 0 ? scribeSubStepsRegen : undefined
        )
      );
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

    // Determine which stage failed based on existing data.
    // PDP-3 B4 guard: if Proto succeeded but the push never committed
    // (dry-run cache only — `metadata.committed === false`), the failure
    // was at the push step itself. Retrying Trace would run tests against
    // `branch: 'dry-run'` on a non-existent repo. Instead, reset to the
    // push-confirm gate so the user can retry the push (or cancel).
    if (pipeline.protoOutput && !pipeline.traceOutput) {
      // PDP-3 B4: only divert to the push-confirm gate when committed is
      // EXPLICITLY false — this signals the dry-run cache from the new
      // gate flow. Legacy pipelines (and tests) leave `committed` undefined
      // because they predate the field; they should keep the old retry-trace
      // path so they don't break.
      const explicitlyNotCommitted = pipeline.protoOutput.metadata?.committed === false;
      if (explicitlyNotCommitted) {
        return this.store.update(pipelineId, {
          stage: 'awaiting_push_confirm',
          error: null,
        });
      }
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
    // Terminal state — prune any stage-start entries left behind by a
    // cancel that interrupted the success path (chat narrator durationMs
    // tracker, code-review follow-up 2026-05-23).
    this.clearStageStarts(pipelineId);
    this.emitEvent(pipelineId, 'stage_change', 'cancelled');
    return updated;
  }

  // ─── PDP-3 B4: Confirm / Cancel Push (preview gate) ────────

  /**
   * User confirmed they want to push the previewed scaffold to GitHub.
   *
   * Cached `protoOutput.files` (generated during the dryRun Proto run that
   * preceded `awaiting_push_confirm`) are pushed via
   * {@link ProtoAgent.pushScaffoldFiles} — no LLM regeneration. On success
   * the pipeline transitions to `trace_testing` and Trace runs in the
   * background, mirroring the legacy auto-push path. Idempotent: a second
   * call while the push is in flight returns the current state.
   */
  async confirmPush(pipelineId: string): Promise<PipelineState> {
    return this.withLock(pipelineId, () => this._confirmPush(pipelineId));
  }

  private async _confirmPush(pipelineId: string): Promise<PipelineState> {
    const pipeline = await this.getPipeline(pipelineId);

    // Idempotency: if the user double-clicks "Gönder", the second call sees
    // the pipeline already advanced past the gate and just returns state.
    // `proto_building` covers the mid-flight transient between the FE click
    // and the background `runConfirmedPush` actually completing — without
    // it, a fast double-click would throw `InvalidStageError` on the second
    // request instead of returning the in-flight state.
    const alreadyAdvanced: readonly PipelineStage[] = [
      'proto_building',
      'trace_testing',
      'completed',
      'completed_partial',
    ];
    if (alreadyAdvanced.includes(pipeline.stage)) {
      logger.info(
        { pipelineId, stage: pipeline.stage },
        '[Pipeline] confirmPush idempotent hit — pipeline already past gate'
      );
      return pipeline;
    }

    this.assertStage(pipeline, 'awaiting_push_confirm');

    if (!pipeline.protoOutput || !pipeline.protoOutput.files?.length) {
      throw new Error('Cannot confirm push: no scaffold files cached on pipeline');
    }
    if (!pipeline.approvedSpec) {
      throw new Error('Cannot confirm push: approvedSpec is missing');
    }
    if (!pipeline.protoConfig) {
      throw new Error('Cannot confirm push: protoConfig is missing');
    }

    // Resolve GitHub access (token + owner) the same way _approveSpec did.
    let owner: string;
    let userGitHubToken: string;
    try {
      const gh = await this.validateGitHubAccess(pipeline.userId);
      userGitHubToken = gh.token;
      // Pipeline-continuation case: existing owner takes precedence.
      const existingRepo = pipeline.intermediateState?.existingRepo as
        | { owner: string; repo: string; branch: string }
        | undefined;
      owner = existingRepo?.owner ?? gh.owner;
    } catch (err) {
      const error = createPipelineError(
        PipelineErrorCode.GITHUB_NOT_CONNECTED,
        `GitHub bağlantısı bulunamadı: ${err instanceof Error ? err.message : String(err)}`
      );
      const failed = await this.store.update(pipelineId, { stage: 'failed', error });
      this.emitEvent(pipelineId, 'error', 'failed', error);
      return failed;
    }

    // Push happens in the background; respond to the route immediately with
    // an optimistic transition to `proto_building` (re-use of the existing
    // FSM slot so the UI keeps showing Proto progress through the push).
    // The previewed files stay in protoOutput throughout so the rail's
    // Sandpack remains rendered until Trace finishes.
    const updated = await this.store.update(
      pipelineId,
      { stage: 'proto_building' },
      { expectedStageVersion: pipeline.stageVersion }
    );
    this.emitEvent(pipelineId, 'stage_change', 'proto_building');

    const userGithubService = this.createGitHubService(userGitHubToken);
    const agents =
      this.createAgentsForModel?.(pipeline.model ?? '', userGithubService) ??
      this.getAgents(pipeline.model, pipelineId);

    this.runConfirmedPush(
      pipelineId,
      pipeline,
      agents,
      owner,
      pipeline.protoConfig.repoName,
      pipeline.protoConfig.repoVisibility
    ).catch((err) => {
      logger.error({ err, pipelineId }, '[Pipeline] confirmPush background flow failed');
      this.failPipeline(pipelineId, 'Push', err).catch((e) =>
        logger.error({ err: e }, '[Pipeline] failPipeline also failed')
      );
    });

    return updated;
  }

  /**
   * Background helper for {@link confirmPush}: takes the cached scaffold
   * files, calls `proto.pushScaffoldFiles` (createRepo + pushFiles, no LLM),
   * updates `protoOutput` with the real branch/url metadata, and transitions
   * the pipeline to `completed`.
   *
   * PR-F2 (2026-05-19): Trace no longer runs here — it already ran in dryRun
   * mode BEFORE the push-confirm gate, so `traceOutput` (with coverage matrix
   * + test plan) is already persisted on the pipeline by the time the user
   * clicks "Gönder". We just push the cached files and finalize.
   */
  private async runConfirmedPush(
    pipelineId: string,
    pipeline: PipelineState,
    agents: AgentSet,
    owner: string,
    repoName: string,
    repoVisibility: 'public' | 'private'
  ): Promise<void> {
    if (!pipeline.protoOutput || !pipeline.approvedSpec) return;

    const protoEmit = createActivityEmitter(pipelineId, 'proto');
    protoEmit('start', "Onaylanan kod GitHub'a yükleniyor...", 10);

    const pushResult = await agents.proto.pushScaffoldFiles(
      owner,
      repoName,
      repoVisibility,
      pipeline.protoOutput.files,
      {
        setupCommands: pipeline.protoOutput.setupCommands,
        stackUsed: pipeline.protoOutput.metadata?.stackUsed,
        summary: pipeline.protoOutput.summary,
        pipelineId,
      }
    );

    if (await this.isCancelled(pipelineId)) return;

    if (pushResult.type === 'error') {
      await this.store.update(pipelineId, {
        stage: 'failed',
        error: pushResult.error,
      });
      this.emitEvent(pipelineId, 'error', 'failed', pushResult.error);
      return;
    }

    const updatedProtoOutput = pushResult.data;
    const pipelineNow = await this.getPipeline(pipelineId);

    if (pipelineNow.jiraConfig?.epicKey) {
      this.runJiraProtoComment(pipelineNow.userId, pipelineNow.jiraConfig.epicKey, {
        branch: updatedProtoOutput.branch,
        repo: updatedProtoOutput.repo,
        prUrl: updatedProtoOutput.prUrl,
        filesCreated: updatedProtoOutput.metadata.filesCreated,
      }).catch((err) => logger.warn({ err }, '[Pipeline] Non-blocking Jira task failed'));
    }

    if (await this.isCancelled(pipelineId)) return;

    // PR-F2: Trace already ran in dryRun before the gate. We just need to
    // finalize the pipeline. `traceOutput` (if any) is preserved as-is; the
    // pushed branch metadata on `protoOutput` is what changes here.
    //
    // PR-V-duplicate-repo (2026-05-20): if the repo name was suffixed on
    // conflict (`qr-kod-uretici` → `qr-kod-uretici-2`), `protoOutput.repo`
    // carries the resolved name. Sync `protoConfig.repoName` so any future
    // iteration or push retry against this pipeline uses the real repo.
    const completionStage: PipelineStage = pipelineNow.traceOutput
      ? 'completed'
      : 'completed_partial';
    // protoOutput.repo is "<owner>/<name>" — extract the name half.
    const resolvedRepoName = updatedProtoOutput.repo.split('/').pop() ?? repoName;
    const protoConfigUpdate =
      pipelineNow.protoConfig && resolvedRepoName !== pipelineNow.protoConfig.repoName
        ? { ...pipelineNow.protoConfig, repoName: resolvedRepoName }
        : pipelineNow.protoConfig;
    // T3: when Trace produced tests AND the push succeeded, kick off the
    // GitHub Actions workflow_dispatch and poll the run in the background.
    // The pipeline transitions through `ci_running` → `completed` /
    // `completed_partial`; failure to trigger or poll is fail-safe — it
    // logs and falls through to the standard completion state.
    const shouldRunCi = pipelineNow.traceOutput !== undefined && pipelineNow.traceEnabled !== false;
    const initialStage: PipelineStage = shouldRunCi ? 'ci_running' : completionStage;

    await this.store.update(pipelineId, {
      protoOutput: updatedProtoOutput,
      ...(protoConfigUpdate ? { protoConfig: protoConfigUpdate } : {}),
      stage: initialStage,
      metrics: {
        ...pipelineNow.metrics,
        protoCompletedAt: pipelineNow.metrics.protoCompletedAt ?? new Date(),
        traceCompletedAt: pipelineNow.metrics.traceCompletedAt ?? new Date(),
        totalDurationMs: Date.now() - toEpoch(pipelineNow.metrics.startedAt),
      },
    });
    this.emitEvent(pipelineId, 'stage_change', initialStage);
    logger.info(
      {
        pipelineId,
        stage: initialStage,
        hasTraceOutput: pipelineNow.traceOutput !== undefined,
        ciTriggered: shouldRunCi,
      },
      '[Pipeline] PR-F2 confirmPush finalized — Trace already ran in dryRun pre-gate'
    );

    if (shouldRunCi) {
      const branch = updatedProtoOutput.branch;
      const repoFull = updatedProtoOutput.repo;
      const [ciOwner, ciRepo] = repoFull.split('/');
      if (ciOwner && ciRepo) {
        this.runCiPolling(pipelineId, pipelineNow.userId, ciOwner, ciRepo, branch).catch((err) =>
          logger.warn({ err, pipelineId }, '[Pipeline] T3 CI polling failed')
        );
      }
    }
  }

  /**
   * T3: trigger workflow_dispatch on the pushed branch, poll the run, and
   * persist the result. Best-effort: any failure leaves the pipeline at the
   * completion stage Trace would have produced — the CI panel just stays
   * empty. Runs detached from `runConfirmedPush` so the user's API call
   * returns immediately.
   */
  private async runCiPolling(
    pipelineId: string,
    userId: string,
    owner: string,
    repo: string,
    branch: string
  ): Promise<void> {
    const { triggerWorkflowDispatch, pollWorkflowRun } = await import(
      '../../services/CIService.js'
    );

    let token: string;
    try {
      const gh = await this.validateGitHubAccess(userId);
      token = gh.token;
    } catch (err) {
      logger.warn({ err, pipelineId }, '[Pipeline] T3 CI: GitHub token unresolved — skipping');
      await this.finishCiUnpolled(pipelineId);
      return;
    }

    try {
      await triggerWorkflowDispatch(token, owner, repo, branch);
    } catch (err) {
      logger.warn(
        { err, pipelineId, owner, repo, branch },
        '[Pipeline] T3 CI: workflow_dispatch failed — pipeline completes without CI result'
      );
      await this.finishCiUnpolled(pipelineId);
      return;
    }

    let result: import('../../services/CIService.js').CIResult;
    try {
      result = await pollWorkflowRun(token, owner, repo, branch, (status) =>
        logger.info({ pipelineId, status }, '[Pipeline] T3 CI poll tick')
      );
    } catch (err) {
      logger.warn(
        { err, pipelineId },
        '[Pipeline] T3 CI: pollWorkflowRun threw — pipeline completes without CI result'
      );
      await this.finishCiUnpolled(pipelineId);
      return;
    }

    const pipelineNow = await this.getPipeline(pipelineId);
    const nextIntermediate = {
      ...(pipelineNow.intermediateState ?? {}),
      ciResult: result,
    } as Record<string, unknown>;
    const ciOk = result.status === 'completed' && result.ok;
    const finalStage: PipelineStage = ciOk ? 'completed' : 'completed_partial';

    if (result.status === 'timed_out') {
      logger.warn(
        { pipelineId, runId: result.runId },
        '[Pipeline] T3 CI: poll timed out after 10min — marking completed_partial'
      );
    }

    await this.store.update(pipelineId, {
      stage: finalStage,
      intermediateState: nextIntermediate,
    });
    this.emitEvent(pipelineId, 'stage_change', finalStage, { ciResult: result });
    logger.info(
      { pipelineId, finalStage, runId: result.runId, conclusion: result.conclusion },
      '[Pipeline] T3 CI poll finished'
    );
  }

  private async finishCiUnpolled(pipelineId: string): Promise<void> {
    const pipelineNow = await this.getPipeline(pipelineId);
    const finalStage: PipelineStage = pipelineNow.traceOutput ? 'completed' : 'completed_partial';
    await this.store.update(pipelineId, { stage: finalStage });
    this.emitEvent(pipelineId, 'stage_change', finalStage);
  }

  /**
   * User declined the preview — pipeline ends without a GitHub push.
   *
   * Per spec § 8 Q2 (subagent decision): we re-use the existing
   * `completed_partial` terminal stage rather than minting a new
   * `cancelled_at_review`. Rationale: from a metrics standpoint
   * "user finished but skipped the push" is the same shape as
   * "trace was skipped" — partial completion. The cached
   * `protoOutput.files` stay on the pipeline so the user can still
   * inspect / copy them from the preview pane.
   */
  async cancelPush(pipelineId: string): Promise<PipelineState> {
    return this.withLock(pipelineId, () => this._cancelPush(pipelineId));
  }

  private async _cancelPush(pipelineId: string): Promise<PipelineState> {
    const pipeline = await this.getPipeline(pipelineId);

    // Idempotency: cancelling a pipeline that already settled into a
    // terminal state is a no-op.
    const terminal: readonly PipelineStage[] = [
      'completed',
      'completed_partial',
      'cancelled',
      'failed',
    ];
    if (terminal.includes(pipeline.stage)) {
      return pipeline;
    }

    this.assertStage(pipeline, 'awaiting_push_confirm');

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
    // Terminal state — prune leftover stage-start entries (chat narrator
    // durationMs tracker, code-review follow-up 2026-05-23).
    this.clearStageStarts(pipelineId);
    this.emitEvent(pipelineId, 'completed', 'completed_partial');
    logger.info(
      { pipelineId },
      '[Pipeline] B4 gate — user cancelled push, pipeline terminated as completed_partial'
    );
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

  // ─── B5 — Iterate Proto from feedback ─────────

  /**
   * Re-run Proto in dryRun mode with the user's correction request as
   * primary context. Only valid at `awaiting_push_confirm`. Spec stays the
   * same; only `protoOutput.files` are regenerated (overwrite — no version
   * history in this MVP). On success the pipeline transitions back to
   * `awaiting_push_confirm` with fresh files for the user to inspect again.
   *
   * Anchors: docs/product/wave3/b5-feedback-iteration.md
   */
  async iterateProtoFromFeedback(pipelineId: string, feedback: string): Promise<PipelineState> {
    return this.withLock(pipelineId, () => this._iterateProtoFromFeedback(pipelineId, feedback));
  }

  private async _iterateProtoFromFeedback(
    pipelineId: string,
    feedback: string
  ): Promise<PipelineState> {
    const pipeline = await this.getPipeline(pipelineId);
    // P8 — iterate is valid both at the push-confirm gate (B5 origin) and at
    // the new critic hard-block stage. The downstream Proto re-run cycles
    // through critic review again, so a sub-threshold result will simply
    // bounce back to `awaiting_critic_resolution`.
    if (
      pipeline.stage !== 'awaiting_push_confirm' &&
      pipeline.stage !== 'awaiting_critic_resolution'
    ) {
      throw new InvalidStageError(
        'awaiting_push_confirm | awaiting_critic_resolution',
        pipeline.stage
      );
    }

    if (!pipeline.approvedSpec) {
      throw new Error('Cannot iterate from feedback: pipeline has no approvedSpec on record');
    }
    if (!pipeline.protoConfig) {
      throw new Error('Cannot iterate from feedback: pipeline has no protoConfig on record');
    }

    // Append feedback to conversation so the audit trail captures intent.
    const conversation: ScribeMessageType[] = [
      ...pipeline.scribeConversation,
      { type: 'user_feedback', content: feedback },
    ];

    // Transition back to proto_building (orchestrator state machine
    // accepts this as a valid origin for runProtoAndTrace).
    const updated = await this.store.update(pipelineId, {
      stage: 'proto_building',
      scribeConversation: conversation,
      error: null,
    });
    this.emitEvent(pipelineId, 'stage_change', 'proto_building');

    // Resolve GitHub access (stub under DOGFOOD_MODE) — same path the
    // initial approveSpec → runProtoAndTrace took.
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

    // Fire-and-forget: re-run Proto + Critic + Trace pipeline. dryRun is
    // enforced by AUTO_PUSH_AFTER_PROTO=false (the default), so the new
    // files land in `protoOutput.files` and the pipeline returns to
    // `awaiting_push_confirm`. Feedback is plumbed through the new
    // `feedbackContext` parameter.
    this.runProtoAndTrace(
      pipelineId,
      pipeline.metrics,
      pipeline.approvedSpec,
      pipeline.protoConfig.repoName,
      pipeline.protoConfig.repoVisibility,
      owner,
      pipeline.model,
      undefined,
      feedback
    ).catch((err) => {
      logger.error(
        { err, pipelineId },
        '[Pipeline] iterateProtoFromFeedback runProtoAndTrace failed'
      );
    });

    return updated;
  }

  // ─── P8: Critic manual override ─────────────

  /**
   * User explicitly waved the Critic hard-block away. Transitions from
   * `awaiting_critic_resolution` → `awaiting_push_confirm` so the existing
   * push-confirm flow can take over (preview + GitHub'a gönder / İptal et).
   *
   * Audit trail: stamps `criticBlock.manuallyOverridden = true` and adds an
   * `overriddenAt` timestamp on the existing intermediateState block.
   * The criticCodeOutput itself is left untouched — the original score and
   * findings remain visible to the user post-override.
   */
  async criticOverride(pipelineId: string): Promise<PipelineState> {
    return this.withLock(pipelineId, () => this._criticOverride(pipelineId));
  }

  private async _criticOverride(pipelineId: string): Promise<PipelineState> {
    const pipeline = await this.getPipeline(pipelineId);

    // Idempotency: if the user double-clicks the button after the pipeline
    // already advanced past the gate, just return the current state.
    const alreadyAdvanced: readonly PipelineStage[] = [
      'awaiting_push_confirm',
      'proto_building',
      'trace_testing',
      'completed',
      'completed_partial',
    ];
    if (alreadyAdvanced.includes(pipeline.stage)) {
      logger.info(
        { pipelineId, stage: pipeline.stage },
        '[Pipeline] criticOverride idempotent hit — pipeline already past critic gate'
      );
      return pipeline;
    }

    this.assertStage(pipeline, 'awaiting_critic_resolution');

    if (!pipeline.protoOutput || !pipeline.protoOutput.files?.length) {
      throw new Error('Cannot override critic gate: no scaffold files cached on pipeline');
    }

    const existingIntermediate = (pipeline.intermediateState ?? {}) as Record<string, unknown>;
    const existingBlock = (existingIntermediate.criticBlock ?? {}) as Record<string, unknown>;

    // PR-fix (2026-05-21): Critic override skips Trace dryRun entirely —
    // pipeline jumps from awaiting_critic_resolution → awaiting_push_confirm
    // without ever entering trace_testing. Without a `traceDryRunStatus`
    // value the push gate defaults to 'pending' and shows
    // "Testler hazırlanıyor…" forever (Trace will never run for this
    // pipeline). Persist `traceDryRunStatus: 'failed'` so the gate surfaces
    // the truthful "tests not produced" banner and the push button remains
    // actionable.
    const updated = await this.store.update(
      pipelineId,
      {
        stage: 'awaiting_push_confirm',
        intermediateState: {
          ...existingIntermediate,
          criticBlock: {
            ...existingBlock,
            manuallyOverridden: true,
            overriddenAt: new Date().toISOString(),
          },
          traceDryRunStatus: 'failed',
          traceDryRunErrorCode: 'TRACE_SKIPPED_AFTER_CRITIC_OVERRIDE',
        },
      },
      { expectedStageVersion: pipeline.stageVersion }
    );
    this.emitEvent(pipelineId, 'stage_change', 'awaiting_push_confirm');
    logger.info(
      { pipelineId },
      '[Pipeline] P8 critic override — advanced to awaiting_push_confirm'
    );
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

      // PR-V5: explicit Scribe completion signal BEFORE the next stage
      // (critic_reviewing_spec / awaiting_approval) takes over the SSE
      // stream. Without this, the frontend "stage X is no longer latest"
      // heuristic would flip Scribe's checkmark on as soon as the first
      // critic/proto activity lands — i.e. before Scribe's real exit.
      this.emitStageCompleted(pipelineId, 'scribe');

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
          // Chat narrator (2026-05-23): emit scribe_completed event into the
          // same conversation snapshot. subSteps include Critic findings.
          // Iteration counter = prior scribe_completed events + 1.
          const scribeIterationAuto =
            this.countPriorEvents(conversation, 'scribe_completed') + 1;
          const scribeSubStepsAuto = this.buildSubStepsForStage(
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
            this.buildScribeCompletedEvent(
              pipelineId,
              scribeIterationAuto,
              result.data,
              scribeSubStepsAuto.length > 0 ? scribeSubStepsAuto : undefined
            )
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

      // Chat narrator (2026-05-23): emit scribe_completed into the same
      // conversation snapshot so the chat baloncuğu shows summary + plan
      // card + critic-derived sub-steps. Iteration counter = prior
      // scribe_completed events + 1.
      const scribePipelineForSubSteps = await this.store.getById(pipelineId);
      const scribeIteration = this.countPriorEvents(conversation, 'scribe_completed') + 1;
      const scribeSubSteps = this.buildSubStepsForStage(
        {
          ...(scribePipelineForSubSteps ?? {}),
          scribeOutput: result.data,
        } as PipelineState,
        'scribe'
      );
      conversation.push(
        this.buildScribeCompletedEvent(
          pipelineId,
          scribeIteration,
          result.data,
          scribeSubSteps.length > 0 ? scribeSubSteps : undefined
        )
      );

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
    model?: string,
    /**
     * PR-F2 (2026-05-19) — optional Trace execution overrides:
     *   - `dryRun`: forward to TraceAgent so it skips GitHub push (and, when
     *     combined with `inputFiles`, the codebase fetch).
     *   - `inputFiles`: local scaffold files (Proto dryRun output) to use
     *     instead of fetching from GitHub. Required for the pre-push-gate
     *     flow where the branch doesn't exist yet.
     *   - `postSuccess`: what stage to transition to after a fully successful
     *     Trace run (or after the iterate-loop terminates without firing).
     *     Default `'completed'` (legacy auto-push flow). When the orchestrator
     *     wants the user to confirm the push next, it sets this to
     *     `'awaiting_push_confirm'`.
     */
    options?: {
      dryRun?: boolean;
      inputFiles?: Array<{ filePath: string; content: string }>;
      postSuccess?: 'completed' | 'awaiting_push_confirm';
    }
  ): Promise<PipelineState> {
    pipelineCallContext.enterWith({ pipelineId });
    const traceDryRun = options?.dryRun === true;
    const traceInputFiles = options?.inputFiles;
    const postSuccessStage: 'completed' | 'awaiting_push_confirm' =
      options?.postSuccess ?? 'completed';
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
    // Chat event-log (Task 3): record start before the AI call.
    const traceIteration = await this.appendTraceStarted(pipelineId);
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
            // PR-F2: pre-push-gate dryRun mode. When dryRun=true + inputFiles
            // present, TraceAgent skips GitHub fetch (branch doesn't exist
            // yet) and skips push (we only need the plan + coverage matrix).
            dryRun: traceDryRun,
            inputFiles: traceInputFiles,
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
      // PR-V-github-401-graceful — auth failure surfaced from the adapter.
      // Clear the stale token row (best-effort) and skip FixLoop entirely;
      // retrying with the same dead credential will just 401 again.
      const isGitHubAuthError = traceResult.error.code === 'GITHUB_TOKEN_INVALID';
      await this.maybeInvalidateGitHubTokenOnAuthError(pipelineId, traceResult.error.code);
      // Chat event-log (Task 3): persist failure before any stage transition.
      await this.appendTraceFailed(
        pipelineId,
        traceIteration,
        traceResult.error.code,
        traceResult.error.message,
        'retry'
      );
      traceEmit(
        'error',
        isAiTimeout
          ? 'AI servisi yanıt vermedi — test üretimi atlandı'
          : isGitHubAuthError
            ? 'GitHub bağlantınız geçersiz — lütfen yeniden bağlanın'
            : `Test üretimi başarısız: ${traceResult.error.message}`,
        0
      );

      // PR-F2: pre-push-gate dryRun mode — skip FixLoop (which would push to
      // GitHub before the user has confirmed). Hand off to push gate so the
      // user can still inspect/push the un-tested scaffold or cancel.
      if (traceDryRun && postSuccessStage === 'awaiting_push_confirm') {
        // PR-U3 M3: previously the push gate showed nothing distinct on a
        // dryRun failure — the button was enabled, the user could push
        // "tested" code that never had tests. Persist a flag in
        // intermediateState so the frontend can render a warning + force
        // an explicit override checkbox before the push button enables.
        const pipelineNow = await this.store.getById(pipelineId);
        const intermediate = (pipelineNow?.intermediateState ?? {}) as Record<string, unknown>;
        // PR-V (2026-05-20) Bug 1 — TraceAgent embeds a head+tail snippet of
        // the raw AI response in `technicalDetail` when all parse attempts
        // fail. Persist it on `intermediateState.lastFailedTraceResponse`
        // for post-mortem debugging without bloating pino logs.
        const rawSnippet = traceResult.error.technicalDetail ?? null;
        const updated = await this.store.update(pipelineId, {
          stage: 'awaiting_push_confirm',
          metrics: {
            ...metrics,
            protoCompletedAt: metrics.protoCompletedAt ?? new Date(),
          },
          intermediateState: {
            ...intermediate,
            traceDryRunStatus: 'failed',
            traceDryRunErrorCode: traceResult.error.code,
            traceDryRunErrorAt: new Date().toISOString(),
            ...(rawSnippet ? { lastFailedTraceResponse: rawSnippet } : {}),
          },
          // We intentionally do NOT persist the error onto the pipeline — it's
          // a soft failure for the dryRun pass. The flag above tells the UI.
        });
        this.emitEvent(pipelineId, 'stage_change', 'awaiting_push_confirm');
        // PR-V (2026-05-20) Bug 2 — UI stale state on Trace fallback. Before
        // emitting the gate_open activity, emit an explicit
        // `step: 'stage_completed'` with `status: 'completed'` for the Trace
        // stage so the cinema:
        //   - marks Trace as "complete" via the explicit-completion Set
        //   - the retry badge / "Playwright testleri oluşturuluyor (deneme 3)"
        //     shimmer is cleared (retry-trigger meta superseded)
        //   - the column shows the final neutral message
        // The cinema utility (PR-V) also clears retry meta when a
        // `stage_completed` activity arrives for trace.
        emitActivity({
          pipelineId,
          stage: 'trace',
          step: 'stage_completed',
          status: 'completed',
          message: 'Test üretilemedi (devam ediliyor)',
          progress: 100,
          timestamp: new Date().toISOString(),
        });
        // PR-T3 S1 + PR-U3: explicit gate_open activity so SSE-driven
        // refresh on the frontend catches the transition.
        emitActivity({
          pipelineId,
          stage: 'trace',
          step: 'gate_open',
          message:
            'Gönderim onayı bekleniyor — Trace üretimi başarısız oldu, yine de göndermek için onay verin',
          progress: 100,
          timestamp: new Date().toISOString(),
        });
        logger.warn(
          { pipelineId, errorCode: traceResult.error.code },
          '[Pipeline] PR-F2 Trace dryRun failed — handing off to push gate without tests'
        );
        return updated;
      }

      // ─── Level 3: FixLoop auto-trigger on Trace failure ───
      const currentPipelineForFix = await this.store.getById(pipelineId);
      const protoOutput = currentPipelineForFix?.protoOutput;
      // PR-V-github-401-graceful — auth failures cannot be fixed by
      // regenerating code. Skip FixLoop and go straight to completed_partial
      // so the user sees the actionable reconnect-github banner.
      if (protoOutput && spec && !isAiTimeout && !isGitHubAuthError) {
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

    // ─── PR-F: Trace iterate-loop ──────────────────
    // Mimari refactor (2026-05-19): Trace başarılı dönse bile uncovered AC
    // veya test failure varsa Proto'yu otomatik re-iterate eder. Max retry
    // sayısı TRACE_MAX_ITERATE_RETRIES env var ile parametrik (default 3).
    // Retry tükenince pipeline awaiting_push_confirm'e geçer (preview gate
    // varsa) ya da completed'a düşer; kullanıcı kararı verebilir.
    // ATDD/TDD literatürüyle uyumlu: Scribe→Proto→Trace→Proto→Trace döngüsü.
    const iterateLoopDecision = await this.evaluateTraceIterateLoop(
      pipelineId,
      traceResult.data,
      spec
    );
    if (iterateLoopDecision.shouldIterate) {
      logger.info(
        {
          pipelineId,
          retry: iterateLoopDecision.nextRetry,
          maxRetries: iterateLoopDecision.maxRetries,
          uncoveredCount: iterateLoopDecision.uncoveredCount,
        },
        '[Pipeline] PR-F Trace iterate-loop — re-iterating Proto'
      );
      // Persist intermediate state + activity emit; the actual Proto+Trace
      // re-run is dispatched (fire-and-forget) so the orchestrator's
      // current `runTrace` call returns cleanly.
      const traceEmit = createActivityEmitter(pipelineId, 'trace');
      traceEmit(
        'retry-trigger',
        `Test eksik kaldı (${iterateLoopDecision.uncoveredCount}/${iterateLoopDecision.totalCount} kabul kriteri) — Proto yeniden çalışıyor (${iterateLoopDecision.nextRetry}/${iterateLoopDecision.maxRetries})`,
        80,
        iterateLoopDecision.feedback,
        iterateLoopDecision.nextRetry,
        'pipeline.trace.iterate.retry'
      );
      // Persist coverage + reasoning before re-running so the UI shows the
      // failing snapshot until the next retry overwrites it.
      this.recordTraceReasoning(pipelineId, traceResult.data);
      {
        const pipelineAfterTrace = await this.store.getById(pipelineId);
        if (pipelineAfterTrace?.protoOutput) {
          await this.persistAcCoverage(
            pipelineId,
            pipelineAfterTrace.protoOutput,
            pipelineAfterTrace.scribeOutput,
            traceResult.data
          );
        }
      }
      // Dispatch re-iterate and return — async re-run will land on
      // awaiting_push_confirm / completed when the loop terminates.
      void this.dispatchTraceIterate(pipelineId, iterateLoopDecision.feedback).catch((err) => {
        logger.error({ err, pipelineId }, '[Pipeline] PR-F Trace iterate-loop dispatch failed');
      });
      // We return the current pipeline state; the user-facing transition
      // (proto_building) lands inside dispatchTraceIterate.
      return (await this.store.getById(pipelineId)) as PipelineState;
    }

    // PR-F2: post-Trace handoff target. Default flow → `completed`; preview
    // gate flow (Trace dryRun before push) → `awaiting_push_confirm` so the
    // user reviews scaffold + coverage matrix before pushing to GitHub.
    // PR-U3 M3: mirror the failure-path flag in the success branch so the
    // frontend can render the gate in `success` mode without inferring from
    // the absence of `traceDryRunStatus`.
    const pipelineForFlag = traceDryRun ? await this.store.getById(pipelineId) : undefined;
    const intermediateForFlag = traceDryRun
      ? ((pipelineForFlag?.intermediateState ?? {}) as Record<string, unknown>)
      : undefined;
    // PR-V5: explicit Trace completion signal — emit BEFORE the pipeline
    // moves to its terminal/gate stage so SSE consumers receive the close
    // event on the same Trace stream they have been listening to. Both
    // `awaiting_push_confirm` and `completed` are valid terminals here.
    this.emitStageCompleted(pipelineId, 'trace');
    const updated = await this.store.update(pipelineId, {
      stage: postSuccessStage,
      traceOutput: traceResult.data,
      metrics: {
        ...metrics,
        protoCompletedAt: metrics.protoCompletedAt ?? new Date(),
        // Trace completion timestamp only when this is the terminal Trace pass
        // (post-push). On a pre-push dryRun we'll re-stamp once Trace re-runs
        // post-push — but currently confirmPush doesn't re-run Trace, so we
        // stamp here regardless; coverage data is already final.
        traceCompletedAt: new Date(),
        totalDurationMs:
          postSuccessStage === 'completed'
            ? Date.now() - toEpoch(metrics.startedAt)
            : metrics.totalDurationMs,
      },
      ...(traceDryRun
        ? {
            intermediateState: {
              ...(intermediateForFlag ?? {}),
              traceDryRunStatus: 'success' as const,
              traceDryRunCompletedAt: new Date().toISOString(),
            },
          }
        : {}),
    });
    // Chat event-log (Task 3): append after traceOutput is persisted (data-consistency).
    // Chat narrator (2026-05-23): build trace sub-steps from the persisted
    // traceOutput so the chat baloncuğu shows test/coverage counts.
    const tracePipelineForSubSteps = await this.getPipeline(pipelineId);
    const traceSubSteps = this.buildSubStepsForStage(
      { ...tracePipelineForSubSteps, traceOutput: traceResult.data } as PipelineState,
      'trace'
    );
    await this.appendTraceCompleted(
      pipelineId,
      traceIteration,
      traceResult.data,
      traceSubSteps.length > 0 ? traceSubSteps : undefined
    );
    if (postSuccessStage === 'awaiting_push_confirm') {
      this.emitEvent(pipelineId, 'stage_change', 'awaiting_push_confirm');
      // PR-T3 S1: state desync fix — `emitEvent` yalnızca dahili event-bus'a
      // gider, SSE stream'e gitmez. SSE yalnızca `pipelineBus` üzerindeki
      // PipelineActivity event'lerini iletiyor. Push gate geçişinde
      // frontend'in açık SSE bağlantısı varken bir activity görmesi
      // gerekiyor — yoksa uiState `critic_running`/`trace_running` placeholder
      // metninde kilitleniyor (manuel testte gözlemlenen bug). Net bir
      // `gate_open` activity'i yayınlayarak ChatPage'in
      // `stageChanged`/`isTerminal` detection'ı kesin tetiklensin.
      emitActivity({
        pipelineId,
        stage: 'trace',
        step: 'gate_open',
        message: 'Gönderim onayı bekleniyor — inceleyin ve onaylayın',
        progress: 100,
        timestamp: new Date().toISOString(),
      });
      logger.info(
        {
          pipelineId,
          fileCount: traceResult.data.testFiles?.length ?? 0,
          coverage: traceResult.data.testSummary?.coveragePercentage,
        },
        '[Pipeline] PR-F2 Trace dryRun completed — handing off to push gate'
      );
    } else {
      this.emitEvent(pipelineId, 'completed', 'completed');
    }

    // Log Trace activity for integrity metrics
    const ts = traceResult.data.testSummary;
    this.logActivity(pipelineId, 'trace', 'tests_generated', {
      testsPassed: ts?.totalTests ?? 0,
      specCompliance: ts?.coveragePercentage ? ts.coveragePercentage / 100 : 0,
      confidence: ts?.coveragePercentage ? ts.coveragePercentage / 100 : 0,
    });

    // Level 4: Explainability — record Trace reasoning
    this.recordTraceReasoning(pipelineId, traceResult.data);
    // PR-D: Trace ran successfully — recompute AC coverage with the dynamic
    // (test ↔ AC) layer filled in. Static layer stays the same (from Proto).
    {
      const pipelineAfterTrace = await this.store.getById(pipelineId);
      if (pipelineAfterTrace?.protoOutput) {
        await this.persistAcCoverage(
          pipelineId,
          pipelineAfterTrace.protoOutput,
          pipelineAfterTrace.scribeOutput,
          traceResult.data
        );
      }
    }

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

    // Akış tamamlanma sinyali (PR-U5: "Pipeline" → "Akış" user-visible)
    emitActivity({
      pipelineId,
      stage: 'trace',
      step: 'pipeline_complete',
      message: 'Akış başarıyla tamamlandı',
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
    // DOGFOOD_MODE: token-free + GitHub-free local exercise. Skip every real
    // GitHub touch — token decrypt, /user pre-validation, owner resolution —
    // and return deterministic stubs so the pipeline can advance to the
    // push-confirm gate without an OAuth setup. The `ghp_mock` prefix is
    // load-bearing: the pre-validation block below short-circuits on it.
    //
    // Two layers of safety:
    //   1. env.ts superRefine rejects DOGFOOD_MODE=true when
    //      NODE_ENV=production at boot — the server will not start.
    //   2. This runtime guard belt-and-braces the same check at the call
    //      site so a misconfigured deploy still cannot disable GitHub
    //      validation. Reads `process.env` directly so this hot path is
    //      not bottlenecked by the env-schema cache.
    if (process.env.DOGFOOD_MODE === 'true' && process.env.NODE_ENV !== 'production') {
      return { token: 'ghp_mock_dogfood', owner: 'dogfood-owner' };
    }
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

  // ─── Chat-event helpers (Task 2: proto events) ───────────────────

  private countPriorEvents(
    conv: ScribeMessageType[],
    type: 'proto_completed' | 'trace_completed' | 'scribe_completed'
  ): number {
    return conv.filter((m) => m.type === type).length;
  }

  // ─── Stage start/duration tracking (chat narrator, 2026-05-23) ──

  private markStageStarted(pipelineId: string, stage: 'scribe' | 'proto' | 'trace'): number {
    const now = Date.now();
    this.stageStartedAt.set(`${pipelineId}:${stage}`, now);
    return now;
  }

  /**
   * Compute and clear `durationMs` for the given stage. One-shot — the
   * tracker entry is deleted after read so a stale value cannot leak into
   * a later completion. Returns `undefined` when no start was recorded
   * (e.g. legacy pipelines that started before this code shipped).
   */
  private getStageDurationMs(
    pipelineId: string,
    stage: 'scribe' | 'proto' | 'trace'
  ): number | undefined {
    const startedAt = this.stageStartedAt.get(`${pipelineId}:${stage}`);
    if (!startedAt) return undefined;
    const duration = Date.now() - startedAt;
    this.stageStartedAt.delete(`${pipelineId}:${stage}`);
    return duration >= 0 ? duration : undefined;
  }

  /**
   * Remove all stage-start entries for a pipeline. Called on terminal
   * transitions (failure, cancellation) so the in-memory `stageStartedAt`
   * map doesn't accumulate dead keys in long-running backends. Per-stage
   * success entries are already pruned by `getStageDurationMs`; this is
   * the cleanup path for the "no successful read" cases (failure mid-stage,
   * user cancel before completion, etc.). Code-review follow-up
   * 2026-05-23.
   */
  private clearStageStarts(pipelineId: string): void {
    const prefix = `${pipelineId}:`;
    for (const key of this.stageStartedAt.keys()) {
      if (key.startsWith(prefix)) {
        this.stageStartedAt.delete(key);
      }
    }
  }

  private async appendProtoStarted(pipelineId: string): Promise<number> {
    const pipeline = await this.getPipeline(pipelineId);
    const iteration = this.countPriorEvents(pipeline.scribeConversation, 'proto_completed') + 1;
    this.markStageStarted(pipelineId, 'proto');
    await this.store.update(pipelineId, {
      scribeConversation: [
        ...pipeline.scribeConversation,
        { type: 'proto_started', content: { iteration }, timestamp: new Date().toISOString() },
      ],
    });
    return iteration;
  }

  /**
   * Emit the `proto_completed` chat event for the current Proto iteration.
   * Reads the freshly-persisted `intermediateState` (validator +
   * criticCodeOutput) so the sub-step rows reflect THIS iteration's
   * findings. Caller is responsible for sequencing — must run AFTER both
   * the deterministic Validator step and the Critic-code review have
   * written their results to `intermediateState`. AC-2 (spec
   * 2026-05-23-chat-agent-narrator-pattern-a-design.md §5).
   */
  private async emitProtoCompletedForIteration(
    pipelineId: string,
    iteration: number,
    output: ProtoOutput
  ): Promise<void> {
    const pipelineSnapshot = await this.getPipeline(pipelineId);
    const subSteps = this.buildSubStepsForStage(
      { ...pipelineSnapshot, protoOutput: output } as PipelineState,
      'proto'
    );
    await this.appendProtoCompleted(
      pipelineId,
      iteration,
      output,
      subSteps.length > 0 ? subSteps : undefined
    );
  }

  private async appendProtoCompleted(
    pipelineId: string,
    iteration: number,
    output: ProtoOutput,
    subSteps?: SubStep[]
  ): Promise<void> {
    const pipeline = await this.getPipeline(pipelineId);
    const durationMs = this.getStageDurationMs(pipelineId, 'proto');
    await this.store.update(pipelineId, {
      scribeConversation: [
        ...pipeline.scribeConversation,
        {
          type: 'proto_completed',
          content: {
            iteration,
            summary: output.summary ?? 'Proje dosyaları hazır.',
            filesCreated: output.metadata.filesCreated,
            totalLines: output.metadata.totalLinesOfCode,
            branch: output.branch,
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(subSteps && subSteps.length > 0 ? { subSteps } : {}),
          },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  // ─── Chat-event helpers (Task 3: trace events) ───────────────────

  private async appendTraceStarted(pipelineId: string): Promise<number> {
    const pipeline = await this.getPipeline(pipelineId);
    const iteration = this.countPriorEvents(pipeline.scribeConversation, 'trace_completed') + 1;
    this.markStageStarted(pipelineId, 'trace');
    await this.store.update(pipelineId, {
      scribeConversation: [
        ...pipeline.scribeConversation,
        {
          type: 'trace_started',
          content: { iteration },
          timestamp: new Date().toISOString(),
        },
      ],
    });
    return iteration;
  }

  private async appendTraceCompleted(
    pipelineId: string,
    iteration: number,
    output: {
      testSummary: { totalTests: number; coveragePercentage: number };
      summary?: string;
    },
    subSteps?: SubStep[]
  ): Promise<void> {
    const pipeline = await this.getPipeline(pipelineId);
    const durationMs = this.getStageDurationMs(pipelineId, 'trace');
    await this.store.update(pipelineId, {
      scribeConversation: [
        ...pipeline.scribeConversation,
        {
          type: 'trace_completed',
          content: {
            iteration,
            totalTests: output.testSummary.totalTests,
            coverage: output.testSummary.coveragePercentage,
            passed: true,
            ...(output.summary ? { summary: output.summary } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(subSteps && subSteps.length > 0 ? { subSteps } : {}),
          },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  /**
   * Build SubStep list for a completion event. Reads `scribeOutput` /
   * `protoOutput` / `traceOutput` plus `intermediateState.criticSpecOutput`,
   * `criticCodeOutput`, and `validationResult` from the pipeline state and
   * translates them into human-language sub-step rows. Critic ve Validator
   * yansımaları burada `source` field'i ile etiketlenir — chat'te ayrı
   * bubble açmaz, sub-step satırı olarak görünür (spec DL-2/DL-3).
   *
   * Returns an empty array when the stage has no inputs yet — caller is
   * responsible for falling back to `undefined` (we keep the contract:
   * `subSteps` is `undefined` on the event when there's nothing to show).
   */
  private buildSubStepsForStage(
    pipeline: PipelineState,
    stage: 'scribe' | 'proto' | 'trace'
  ): SubStep[] {
    const steps: SubStep[] = [];

    if (stage === 'scribe') {
      if (pipeline.scribeOutput) {
        const storyCount = pipeline.scribeOutput.spec.userStories?.length ?? 0;
        const acCount = pipeline.scribeOutput.spec.acceptanceCriteria?.length ?? 0;
        steps.push({
          label: `${storyCount} user story çıkarıldı`,
          status: 'done',
          source: 'agent',
        });
        steps.push({
          label: `${acCount} kabul kriteri yazıldı`,
          status: 'done',
          source: 'agent',
        });
      }
      // Critic spec review yansıması — pipeline.intermediateState.criticSpecOutput
      const criticSpecOutput = pipeline.intermediateState?.criticSpecOutput as
        | CriticReviewOutput
        | undefined;
      if (criticSpecOutput && (criticSpecOutput.findings?.length ?? 0) > 0) {
        steps.push({
          label: `Değerlendirme: ${criticSpecOutput.findings.length} eksik nokta tespit edildi`,
          status: 'done',
          source: 'critic',
        });
      }
    }

    if (stage === 'proto') {
      if (pipeline.protoOutput) {
        steps.push({
          label: 'Proje iskeleti üretildi',
          status: 'done',
          source: 'agent',
        });
        steps.push({
          label: `${pipeline.protoOutput.files.length} dosya yazıldı`,
          status: 'done',
          source: 'agent',
        });
      }
      // Validator (statik kontrol) — pipeline.intermediateState.validationResult
      // (confirmed field name; shape: { passed, score, summary: { errors, warnings, ... } }).
      const validatorResult = pipeline.intermediateState?.validationResult as
        | { passed?: boolean; summary?: { errors?: number; warnings?: number } }
        | undefined;
      if (validatorResult) {
        const errorCount = validatorResult.summary?.errors ?? 0;
        steps.push({
          label:
            errorCount === 0
              ? 'Statik kontrol: temiz'
              : `Statik kontrol: ${errorCount} hata raporlandı`,
          status: 'done',
          source: 'validator',
        });
      }
      // Critic code review yansıması — pipeline.intermediateState.criticCodeOutput
      const criticCodeOutput = pipeline.intermediateState?.criticCodeOutput as
        | CriticReviewOutput
        | undefined;
      if (criticCodeOutput && (criticCodeOutput.findings?.length ?? 0) > 0) {
        steps.push({
          label: `Değerlendirme: ${criticCodeOutput.findings.length} öneri uygulandı`,
          status: 'done',
          source: 'critic',
        });
      }
    }

    if (stage === 'trace') {
      if (pipeline.traceOutput) {
        steps.push({
          label: `${pipeline.traceOutput.testSummary?.totalTests ?? 0} test senaryosu yazıldı`,
          status: 'done',
          source: 'agent',
        });
        if (pipeline.traceOutput.testSummary?.coveragePercentage !== undefined) {
          steps.push({
            label: `%${pipeline.traceOutput.testSummary.coveragePercentage} kapsam doğrulandı`,
            status: 'done',
            source: 'agent',
          });
        }
      }
    }

    return steps;
  }

  /**
   * Builds a `scribe_completed` event in memory without persisting. The
   * caller appends it to the same `conversation` array that is being
   * written by a follow-up `store.update`, avoiding a redundant DB round
   * trip. Mirrors `appendScribeCompleted` semantics: consumes the
   * `markStageStarted('scribe')` snapshot so duration accounting matches.
   */
  private buildScribeCompletedEvent(
    pipelineId: string,
    iteration: number,
    output: ScribeOutput,
    subSteps?: SubStep[]
  ): Extract<ScribeMessageType, { type: 'scribe_completed' }> {
    const durationMs = this.getStageDurationMs(pipelineId, 'scribe');
    return {
      type: 'scribe_completed',
      content: {
        iteration,
        summary: output.summary ?? 'Plan hazırlandı.',
        storyCount: output.spec.userStories?.length ?? 0,
        acCount: output.spec.acceptanceCriteria?.length ?? 0,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(subSteps && subSteps.length > 0 ? { subSteps } : {}),
      },
      timestamp: new Date().toISOString(),
    };
  }

  private async appendTraceFailed(
    pipelineId: string,
    iteration: number,
    errorCode: string,
    errorMessage: string,
    recoveryAction?: 'retry' | 'skip'
  ): Promise<void> {
    const pipeline = await this.getPipeline(pipelineId);
    await this.store.update(pipelineId, {
      scribeConversation: [
        ...pipeline.scribeConversation,
        {
          type: 'trace_failed',
          content: { iteration, errorCode, errorMessage, recoveryAction },
          timestamp: new Date().toISOString(),
        },
      ],
    });
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
    // Terminal state — prune any stage-start entries left behind by a
    // failure that interrupted the success path.
    this.clearStageStarts(pipelineId);
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

    try {
      await commentJiraWithFailure(jira, epicKey, {
        stage: label,
        errorCode: error.code,
        errorMessage: error.message,
        retryable: error.retryable,
        pipelineId,
      });
    } finally {
      await jira.close();
    }
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
    const jira = await JiraMCPService.fromOAuth(userId);
    if (!jira) return;
    try {
      const epicKey = await createJiraEpicFromSpec(jira, projectKey, spec);
      if (epicKey) {
        // T2: stamp siteUrl alongside the epicKey so the UI can render a
        // clickable link without an extra round-trip. With MCP authv2,
        // siteUrl is already cached on the JiraMCPService instance; fall
        // back to the OAuth row only if instance lacks it.
        let siteUrl = jira.siteUrl;
        if (!siteUrl) {
          try {
            const status = await getAtlassianStatus(userId);
            siteUrl = status.siteUrl;
          } catch (err) {
            logger.warn(
              { err, userId },
              '[Pipeline] Jira siteUrl resolve failed (Epic still linked, link will be missing)'
            );
          }
        }
        await this.store.update(pipelineId, {
          jiraConfig: { projectKey, enabled: true, epicKey, siteUrl },
        });
        logger.info(`[Pipeline] Jira Epic ${epicKey} linked to pipeline ${pipelineId}`);
      }
    } catch (err) {
      logger.warn({ err }, '[Pipeline] Jira Epic creation failed (non-fatal)');
    } finally {
      await jira.close();
    }
  }

  private async runJiraProtoComment(
    userId: string,
    epicKey: string,
    result: { branch: string; repo: string; prUrl?: string; filesCreated: number }
  ): Promise<void> {
    const jira = await JiraMCPService.fromOAuth(userId);
    if (!jira) return;
    try {
      await commentJiraWithProtoResult(jira, epicKey, result);
    } catch (err) {
      logger.warn({ err }, '[Pipeline] Jira Proto comment failed (non-fatal)');
    } finally {
      await jira.close();
    }
  }

  private async runJiraTraceComment(
    userId: string,
    epicKey: string,
    result: { totalTests: number; coveragePercentage: number; passed: boolean }
  ): Promise<void> {
    const jira = await JiraMCPService.fromOAuth(userId);
    if (!jira) return;
    try {
      await commentJiraWithTraceResult(jira, epicKey, result);
    } catch (err) {
      logger.warn({ err }, '[Pipeline] Jira Trace comment failed (non-fatal)');
    } finally {
      await jira.close();
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

  // ─── PR-F: Trace iterate-loop helpers ─────────

  /**
   * PR-F (2026-05-19) — Trace başarılı dönse bile uncovered AC veya test
   * failure (`traceOutput.ok === false`) durumunda Proto'yu re-iterate
   * edip etmememeyi karar verir.
   *
   * Kurallar:
   *   - `traceEnabled === false` ise iterate loop devre dışı.
   *   - `uncoveredCriteria.length === 0` ve `ok !== false` ise hiçbir şey
   *     yapma (iterate yok).
   *   - `intermediateState.traceIterateRetryCount` `TRACE_MAX_ITERATE_RETRIES`'a
   *     ulaştıysa iterate'i durdur, push gate'e bırak.
   *   - Aksi halde feedback metnini üret, retry counter'ı increment et,
   *     `shouldIterate=true` ile dön.
   */
  private async evaluateTraceIterateLoop(
    pipelineId: string,
    traceOutput: TraceOutput,
    spec?: StructuredSpec
  ): Promise<{
    shouldIterate: boolean;
    nextRetry: number;
    maxRetries: number;
    uncoveredCount: number;
    totalCount: number;
    feedback: string;
  }> {
    // Read env directly (same rationale as previewGateEnabled — orchestrator
    // is wired into unit tests that don't boot full zod schema validation).
    const maxRetriesRaw = parseInt(process.env.TRACE_MAX_ITERATE_RETRIES ?? '3', 10);
    const maxRetries = Number.isFinite(maxRetriesRaw)
      ? Math.max(0, Math.min(10, maxRetriesRaw))
      : 3;

    const pipeline = await this.store.getById(pipelineId);
    const noopResult = {
      shouldIterate: false,
      nextRetry: 0,
      maxRetries,
      uncoveredCount: 0,
      totalCount: 0,
      feedback: '',
    };
    if (!pipeline) return noopResult;
    // Trace disabled — iterate loop yok.
    if (pipeline.traceEnabled === false) return noopResult;

    const uncovered = traceOutput.testSummary?.uncoveredCriteria ?? [];
    const covered = traceOutput.testSummary?.coveredCriteria ?? [];
    const uncoveredCount = uncovered.length;
    const traceOk = traceOutput.ok !== false;
    if (uncoveredCount === 0 && traceOk) return noopResult;
    // Max retry kontrolü — bu noktada retry hakkı bitmiş olabilir.
    const intermediate = (pipeline.intermediateState ?? {}) as Record<string, unknown>;
    const currentRetry =
      typeof intermediate.traceIterateRetryCount === 'number'
        ? (intermediate.traceIterateRetryCount as number)
        : 0;
    const totalCount = uncovered.length + covered.length;
    if (currentRetry >= maxRetries) {
      logger.info(
        { pipelineId, currentRetry, maxRetries, uncoveredCount },
        '[Pipeline] PR-F Trace iterate-loop max retries reached — handing off to push gate'
      );
      return { ...noopResult, uncoveredCount, totalCount };
    }

    const nextRetry = currentRetry + 1;
    // Feedback metni: hangi AC'ler için test eksik veya başarısız?
    const acDetails =
      spec?.acceptanceCriteria
        ?.filter((ac) => uncovered.includes(ac.id))
        .map((ac) => `- ${ac.id}: ${ac.given} → ${ac.when} → ${ac.then}`) ?? [];
    const feedbackLines = [
      'Trace tamamlandı ama bazı kabul kriterleri test edilmedi.',
      '',
      `Eksik kabul kriterleri (${uncoveredCount}/${totalCount}):`,
      ...(acDetails.length > 0 ? acDetails : uncovered.map((id) => `- ${id}`)),
      '',
      'Bu kabul kriterlerini karşılayan ek kod üretmeni veya mevcut kodu güncellemeni istiyorum.',
    ];
    if (!traceOk) {
      feedbackLines.splice(1, 0, 'Bazı testler başarısız oldu, davranışı düzeltmeni istiyorum.');
    }
    const feedback = feedbackLines.join('\n');
    return {
      shouldIterate: true,
      nextRetry,
      maxRetries,
      uncoveredCount,
      totalCount,
      feedback,
    };
  }

  /**
   * PR-F (2026-05-19) — Trace iterate-loop'unda re-iterate dispatch'i.
   * `iterateProtoFromFeedback`'in stage guard'ları (awaiting_push_confirm
   * / awaiting_critic_resolution) bu otomatik trigger için uygun değil,
   * çünkü Trace iterate-loop trace_testing içinden çağrılıyor. Bu yüzden
   * runProtoAndTrace'i doğrudan yeniden başlatıyoruz; `feedbackContext`
   * Proto'ya plumb edilir, intermediateState'teki `traceIterateRetryCount`
   * artırılır.
   */
  /**
   * PR-U1 (C4 + H1): fire-and-forget dispatchers (`dispatchTraceIterate`,
   * `dispatchCriticIterate`) run after `runProtoAndTrace` returns to its
   * caller — meanwhile the user can click "İptal" and the orchestrator
   * transitions the pipeline to `cancelled`. Without a re-check, the
   * dispatcher's `store.update(stage: 'proto_building', …)` overwrites the
   * terminal `cancelled` state and "resurrects" the pipeline. Guard: read
   * fresh state right before the update; bail out if terminal.
   */
  private isTerminalStage(stage: PipelineStage): boolean {
    return stage === 'cancelled' || stage === 'failed' || stage === 'completed' || stage === 'completed_partial';
  }

  private async dispatchTraceIterate(pipelineId: string, feedback: string): Promise<void> {
    pipelineCallContext.enterWith({ pipelineId });
    const pipeline = await this.store.getById(pipelineId);
    if (!pipeline) return;
    if (!pipeline.approvedSpec || !pipeline.protoConfig) {
      logger.warn(
        { pipelineId },
        '[Pipeline] PR-F Trace iterate-loop: missing approvedSpec/protoConfig'
      );
      return;
    }
    // Owner re-resolve (DOGFOOD_MODE'ta stub döner).
    let owner: string;
    try {
      const gh = await this.validateGitHubAccess(pipeline.userId);
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
    // PR-U1 C4: cancel race guard — re-read state right before the update.
    // Between the top-of-fn `getById` and here, the user may have clicked
    // "İptal" and the pipeline transitioned to `cancelled`. We must NOT
    // overwrite a terminal state and resurrect the pipeline.
    const fresh = await this.store.getById(pipelineId);
    if (!fresh || this.isTerminalStage(fresh.stage)) {
      logger.info(
        { pipelineId, terminalStage: fresh?.stage },
        '[Pipeline] PR-U1 Trace iterate-loop: pipeline reached terminal state mid-flight, skipping re-iterate'
      );
      return;
    }
    // proto_building'a geç + retry counter'ı kaydet.
    await this.store.update(pipelineId, {
      stage: 'proto_building',
      intermediateState: {
        ...intermediate,
        traceIterateRetryCount: currentRetry + 1,
        traceIterateLastFeedback: feedback,
        traceIterateLastAt: new Date().toISOString(),
      },
    });
    this.emitEvent(pipelineId, 'stage_change', 'proto_building');
    // Fire-and-forget. Trace fail'de fix-loop yine kendi içinde sarmalanır.
    this.runProtoAndTrace(
      pipelineId,
      pipeline.metrics,
      pipeline.approvedSpec,
      pipeline.protoConfig.repoName,
      pipeline.protoConfig.repoVisibility,
      owner,
      pipeline.model,
      undefined,
      feedback
    ).catch((err) => {
      logger.error(
        { err, pipelineId },
        '[Pipeline] PR-F Trace iterate-loop runProtoAndTrace failed'
      );
    });
  }

  // ─── PR-F3: Critic critical-finding iterate-loop helpers ────────

  /**
   * PR-F3 (2026-05-19) — Critic kod review'unda severity=critical bulgu
   * varsa kullanıcıyı `awaiting_critic_resolution` ile hard-block etmeden
   * önce Proto'yu otomatik re-iterate eder. Trace iterate-loop pattern'inin
   * birebir kopyası.
   *
   * Kurallar:
   *   - findings içinde severity=critical bulgu yoksa hiçbir şey yapma.
   *   - `intermediateState.criticIterateRetryCount` `CRITIC_CRITICAL_MAX_ITERATE_RETRIES`
   *     'a ulaştıysa iterate'i durdur, fallback olarak mevcut hard-block
   *     davranışı devreye girer (awaiting_critic_resolution).
   *   - Aksi halde kritik bulguların `suggestion` alanlarından feedback
   *     metni üret, `shouldIterate=true` ile dön.
   *
   * Feedback formatı `iterateProtoFromFeedback` ile uyumlu — Proto'nun
   * `feedbackContext` parametresi olarak plumb edilir.
   */
  private async evaluateCriticIterateLoop(
    pipelineId: string,
    criticResult: CriticReviewOutput
  ): Promise<{
    shouldIterate: boolean;
    nextRetry: number;
    maxRetries: number;
    criticalCount: number;
    feedback: string;
  }> {
    // Read env directly (same rationale as Trace iterate-loop / preview gate).
    const maxRetriesRaw = parseInt(process.env.CRITIC_CRITICAL_MAX_ITERATE_RETRIES ?? '3', 10);
    const maxRetries = Number.isFinite(maxRetriesRaw)
      ? Math.max(0, Math.min(10, maxRetriesRaw))
      : 3;

    const pipeline = await this.store.getById(pipelineId);
    const noopResult = {
      shouldIterate: false,
      nextRetry: 0,
      maxRetries,
      criticalCount: 0,
      feedback: '',
    };
    if (!pipeline) return noopResult;

    const criticalFindings = (criticResult.findings ?? []).filter((f) => f.severity === 'critical');
    if (criticalFindings.length === 0) return noopResult;

    const intermediate = (pipeline.intermediateState ?? {}) as Record<string, unknown>;
    const currentRetry =
      typeof intermediate.criticIterateRetryCount === 'number'
        ? (intermediate.criticIterateRetryCount as number)
        : 0;

    if (currentRetry >= maxRetries) {
      logger.info(
        {
          pipelineId,
          currentRetry,
          maxRetries,
          criticalCount: criticalFindings.length,
        },
        '[Pipeline] PR-F3 Critic iterate-loop max retries reached — handing off to awaiting_critic_resolution'
      );
      return { ...noopResult, criticalCount: criticalFindings.length };
    }

    const nextRetry = currentRetry + 1;
    // Feedback metni — Proto'ya kritik bulguların `suggestion` (öneri)
    // alanlarını gönderiyoruz. `description` da bağlam olarak ekleniyor.
    const feedbackLines = [
      'Aşağıdaki kritik bulgular önceki Proto çıktısında tespit edildi. Kodu bu doğrultuda düzelt:',
      '',
      ...criticalFindings.map(
        (f, idx) =>
          `${idx + 1}. ${f.description}\n   Öneri: ${f.suggestion}${f.location ? `\n   Konum: ${f.location}` : ''}`
      ),
      '',
      'Lütfen bu bulguları çözen güncellenmiş kodu üret.',
    ];
    const feedback = feedbackLines.join('\n');
    return {
      shouldIterate: true,
      nextRetry,
      maxRetries,
      criticalCount: criticalFindings.length,
      feedback,
    };
  }

  /**
   * PR-F3 (2026-05-19) — Critic iterate-loop dispatch. `iterateProtoFromFeedback`
   * stage guard'ları (awaiting_push_confirm / awaiting_critic_resolution)
   * bu otomatik trigger için uygun değil; iterate dispatch Critic review'dan
   * sonra `critic_reviewing_code` stage'inde tetikleniyor. Bu yüzden
   * runProtoAndTrace'i doğrudan yeniden başlatıyoruz. Pattern Trace iterate-
   * loop ile birebir aynı.
   */
  private async dispatchCriticIterate(pipelineId: string, feedback: string): Promise<void> {
    pipelineCallContext.enterWith({ pipelineId });
    const pipeline = await this.store.getById(pipelineId);
    if (!pipeline) return;
    if (!pipeline.approvedSpec || !pipeline.protoConfig) {
      logger.warn(
        { pipelineId },
        '[Pipeline] PR-F3 Critic iterate-loop: missing approvedSpec/protoConfig'
      );
      return;
    }
    // Owner re-resolve (DOGFOOD_MODE'ta stub döner).
    let owner: string;
    try {
      const gh = await this.validateGitHubAccess(pipeline.userId);
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
    // PR-U1 C4: cancel race guard — aynı dispatchTraceIterate'deki pattern.
    // User Critic-iterate'in mid-flight'ında "İptal"e basarsa burada yakala.
    const fresh = await this.store.getById(pipelineId);
    if (!fresh || this.isTerminalStage(fresh.stage)) {
      logger.info(
        { pipelineId, terminalStage: fresh?.stage },
        '[Pipeline] PR-U1 Critic iterate-loop: pipeline reached terminal state mid-flight, skipping re-iterate'
      );
      return;
    }
    // proto_building'a geç + retry counter'ı kaydet.
    await this.store.update(pipelineId, {
      stage: 'proto_building',
      intermediateState: {
        ...intermediate,
        criticIterateRetryCount: currentRetry + 1,
        criticIterateLastFeedback: feedback,
        criticIterateLastAt: new Date().toISOString(),
      },
    });
    this.emitEvent(pipelineId, 'stage_change', 'proto_building');
    // Fire-and-forget. Critic review yine kendi içinde sarmalanır; sonraki
    // run da yine kritik bulgu raporlarsa loop devam eder (maxRetries'a kadar).
    this.runProtoAndTrace(
      pipelineId,
      pipeline.metrics,
      pipeline.approvedSpec,
      pipeline.protoConfig.repoName,
      pipeline.protoConfig.repoVisibility,
      owner,
      pipeline.model,
      undefined,
      feedback
    ).catch((err) => {
      logger.error(
        { err, pipelineId },
        '[Pipeline] PR-F3 Critic iterate-loop runProtoAndTrace failed'
      );
    });
  }
}
