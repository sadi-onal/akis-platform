/**
 * Proto + Trace stage runner extracted from PipelineOrchestrator.
 *
 * Kademe 2 refactor — zero behavior change, mechanical extraction.
 * Every `this.X` dependency becomes an explicit `deps.X` parameter.
 */
import type {
  PipelineState,
  PipelineStage,
  PipelineMetrics,
  ScribeOutput,
  StructuredSpec,
  ProtoOutput,
} from '../../contracts/PipelineTypes.js';
import {
  createPipelineError,
  PipelineErrorCode,
  RETRY_CONFIG,
} from '../../contracts/PipelineErrors.js';
import { createActivityEmitter } from '../../activityEmitter.js';
import { withRetry } from '../../retryWrapper.js';
import { scoreProtoEffort } from '../../effortScorer.js';
import { logger } from '../../../../lib/logger.js';
import { buildUnifiedAgentKnowledgeContext } from '../../unifiedPipelineContext.js';
import { pipelineCallContext } from '../../ai-calls/pipelineCallContext.js';
import { buildCriticReasoning } from '../../explainability/reasoningFactory.js';
import type { CriticReviewOutput } from '../../../agents/critic/CriticTypes.js';
import type { PipelineStore, AgentSet } from '../PipelineOrchestrator.js';
import type { ProtoTraceOutcome, HandleProtoTraceOutcomeDeps } from '../outcomes/ProtoTraceOutcome.js';
import { handleProtoTraceOutcome } from '../outcomes/ProtoTraceOutcome.js';
import type { DeterministicValidator } from '../../validator/DeterministicValidator.js';
import type { PipelineMetricsService } from '../../metrics/PipelineMetricsService.js';
import type { AgentReasoning } from '../../explainability/ExplainabilityTypes.js';

const STAGE_TIMEOUT = RETRY_CONFIG.stageTimeoutMs;

/** Timeout guard — duplicated from orchestrator (module-private there). */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} stage timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

/**
 * Pull persisted image blocks out of a pipeline's intermediateState.
 * Duplicated from orchestrator module scope for locality.
 */
function readPipelineImageBlocks(
  intermediateState: Record<string, unknown> | undefined | null
): readonly import('../../../../services/ai/multimodalClient.js').AnthropicImageBlock[] | undefined {
  if (!intermediateState) return undefined;
  const raw = (intermediateState as Record<string, unknown>).imageBlocks;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw as readonly import('../../../../services/ai/multimodalClient.js').AnthropicImageBlock[];
}

/** Safely get epoch ms from a Date or ISO string (JSONB stores dates as strings). */
function toEpoch(d: Date | string | undefined): number {
  if (!d) return Date.now();
  return typeof d === 'string' ? new Date(d).getTime() : d.getTime();
}

// ── Deps interface ──────────────────────────────

export interface RunProtoAndTraceDeps {
  store: PipelineStore;
  getPipeline: (id: string) => Promise<PipelineState>;
  isCancelled: (pipelineId: string) => Promise<boolean>;
  emitEvent: (
    pipelineId: string,
    type: 'stage_change' | 'scribe_message' | 'error' | 'completed',
    stage?: PipelineStage,
    data?: unknown
  ) => void;
  getAgents: (model?: string, pipelineId?: string) => AgentSet;
  createTokenCallback: (pipelineId: string) => import('../../pipeline-factory.js').TokenUsageCallback;
  createAgentsForModel?: (
    model: string,
    githubService?: import('../../pipeline-factory.js').GitHubServiceLike,
    onTokenUsage?: import('../../pipeline-factory.js').TokenUsageCallback
  ) => AgentSet;
  applyChatMemory: (
    pipeline: {
      id: string;
      scribeConversation?: readonly import('../../contracts/PipelineTypes.js').ScribeMessageType[];
      intermediateState?: Record<string, unknown> | null;
    },
    existingKnowledgeContext: string | undefined,
    query: string,
    opts?: { messageIndex?: number }
  ) => Promise<string | undefined>;
  writeCheckpoint: (pipelineId: string, agentName: string, input: unknown) => Promise<void>;
  appendProtoStarted: (pipelineId: string) => Promise<number>;
  logActivity: (
    pipelineId: string,
    agent: 'scribe' | 'proto' | 'trace',
    action: string,
    data?: Record<string, unknown>
  ) => void;
  applyArtifactInjection: (
    protoOutput: ProtoOutput,
    scribeOutput?: ScribeOutput
  ) => ProtoOutput;
  persistReasoning: (pipelineId: string, reasoning: AgentReasoning) => void;
  hasCritic: boolean;
  runCriticCodeReview: (
    pipelineId: string,
    protoOutput: ProtoOutput,
    spec: StructuredSpec,
    originalIdea: string
  ) => Promise<CriticReviewOutput | null>;
  evaluateCriticIterateLoop: (
    pipelineId: string,
    criticResult: CriticReviewOutput,
    spec?: StructuredSpec
  ) => Promise<{
    shouldIterate: boolean;
    nextRetry: number;
    maxRetries: number;
    criticalCount: number;
    feedback: string;
  }>;
  metricsService: Pick<PipelineMetricsService, 'startStage' | 'endStage'>;
  validator: Pick<DeterministicValidator, 'validate'>;
  buildProtoTraceOutcomeDeps: () => HandleProtoTraceOutcomeDeps;
  maybeInvalidateGitHubTokenOnAuthError: (
    pipelineId: string,
    errorCode: string
  ) => Promise<void>;
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

export interface RunIterationProtoAndTraceDeps {
  store: PipelineStore;
  getPipeline: (id: string) => Promise<PipelineState>;
  isCancelled: (pipelineId: string) => Promise<boolean>;
  emitEvent: (
    pipelineId: string,
    type: 'stage_change' | 'scribe_message' | 'error' | 'completed',
    stage?: PipelineStage,
    data?: unknown
  ) => void;
  getAgents: (model?: string, pipelineId?: string) => AgentSet;
  createTokenCallback: (pipelineId: string) => import('../../pipeline-factory.js').TokenUsageCallback;
  createAgentsForModel?: (
    model: string,
    githubService?: import('../../pipeline-factory.js').GitHubServiceLike,
    onTokenUsage?: import('../../pipeline-factory.js').TokenUsageCallback
  ) => AgentSet;
  createGitHubService: (token: string) => import('../../pipeline-factory.js').GitHubServiceLike;
  validateGitHubAccess: (userId: string) => Promise<{ token: string; owner: string }>;
  applyChatMemory: RunProtoAndTraceDeps['applyChatMemory'];
  writeCheckpoint: (pipelineId: string, agentName: string, input: unknown) => Promise<void>;
  logActivity: RunProtoAndTraceDeps['logActivity'];
  applyArtifactInjection: RunProtoAndTraceDeps['applyArtifactInjection'];
  maybeInvalidateGitHubTokenOnAuthError: RunProtoAndTraceDeps['maybeInvalidateGitHubTokenOnAuthError'];
  readRepoFiles: (
    githubService: import('../../pipeline-factory.js').GitHubServiceLike,
    owner: string,
    repo: string,
    branch: string
  ) => Promise<Array<{ path: string; content: string }>>;
}

// ── Exported functions ──────────────────────────

export async function runProtoAndTraceStage(
  pipelineId: string,
  metrics: PipelineMetrics,
  spec: StructuredSpec,
  repoName: string,
  repoVisibility: 'public' | 'private',
  owner: string,
  deps: RunProtoAndTraceDeps,
  model?: string,
  userGithubService?: import('../../pipeline-factory.js').GitHubServiceLike,
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
  const tokenCbProto = deps.createTokenCallback(pipelineId);
  const agents = userGithubService
    ? (deps.createAgentsForModel?.(protoModel, userGithubService, tokenCbProto) ??
      deps.getAgents(protoModel, pipelineId))
    : deps.getAgents(protoModel, pipelineId);
  // Unified pipeline chat + GitHub/repo signals
  const pipelineData = await deps.getPipeline(pipelineId);
  const protoKnowledgeRaw = buildUnifiedAgentKnowledgeContext(pipelineData, { role: 'proto' });
  const protoKnowledgeBase = protoKnowledgeRaw.trim() ? protoKnowledgeRaw : undefined;
  let protoKnowledge = await deps.applyChatMemory(pipelineData, protoKnowledgeBase, spec.title, {
    messageIndex: (pipelineData.scribeConversation?.length ?? 0) + 1,
  });
  if (feedbackContext && feedbackContext.trim().length > 0) {
    const isCriticFeedback = feedbackContext.trimStart().startsWith(
      'Aşağıdaki kritik bulgular önceki Proto çıktısında tespit edildi'
    );
    const header = isCriticFeedback
      ? '## KRİTİK BULGU DÜZELTMESİ (Otomatik Değerlendirme)'
      : '## KULLANICI DÜZELTME İSTEĞİ';
    const feedbackBlock = [
      header,
      'Aşağıdaki düzeltme isteğini kodu üretirken **birinci öncelik** olarak dikkate al:',
      '',
      feedbackContext.trim(),
      '',
    ].join('\n');
    protoKnowledge = protoKnowledge ? `${feedbackBlock}\n\n${protoKnowledge}` : feedbackBlock;
  }
  const pipelineImageBlocks = readPipelineImageBlocks(pipelineData.intermediateState);

  const previewGateEnabled = process.env.AUTO_PUSH_AFTER_PROTO !== 'true';

  await deps.writeCheckpoint(pipelineId, 'proto', spec.title);
  const protoIteration = await deps.appendProtoStarted(pipelineId);
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

  // ─── Kademe 3: Outcome determination phase ────────────────────

  // 1. Cancelled during Proto execution
  if (await deps.isCancelled(pipelineId)) {
    const outcome: ProtoTraceOutcome = { type: 'cancelled' };
    await handleProtoTraceOutcome(pipelineId, outcome, deps.buildProtoTraceOutcomeDeps());
    return;
  }

  // 2. Proto error
  if (protoResult.type === 'error') {
    logger.warn(
      { pipelineId, errorCode: protoResult.error.code },
      '[Pipeline] Proto returned error'
    );
    const outcome: ProtoTraceOutcome = {
      type: 'proto_error',
      error: protoResult.error,
      errorCode: protoResult.error.code,
    };
    await handleProtoTraceOutcome(pipelineId, outcome, deps.buildProtoTraceOutcomeDeps());
    return;
  }

  const protoCompletedMetrics = {
    ...metrics,
    approvedAt: metrics.approvedAt ?? new Date(),
    protoCompletedAt: new Date(),
  };

  deps.logActivity(pipelineId, 'proto', 'scaffold_generated', {
    filesGenerated: protoResult.data.files?.length ?? 0,
    specCompliance: 0.85,
  });

  const pipeline = await deps.getPipeline(pipelineId);

  protoResult.data = deps.applyArtifactInjection(protoResult.data, pipeline.scribeOutput);

  // 3. Trace disabled
  if (!pipeline.traceEnabled) {
    const outcome: ProtoTraceOutcome = {
      type: 'trace_disabled',
      protoOutput: protoResult.data,
      metrics: protoCompletedMetrics,
      protoIteration,
    };
    await handleProtoTraceOutcome(pipelineId, outcome, deps.buildProtoTraceOutcomeDeps());
    return;
  }

  if (pipeline.scribeOutput?.plan?.requiresTests === false) {
    deps.logActivity(pipelineId, 'trace', 'proceeding_without_plan', {
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

    const validationResult = deps.validator.validate(validationInput);
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

    const currentStateForValidation = await deps.store.getById(pipelineId);
    await deps.store.update(pipelineId, {
      intermediateState: {
        ...(currentStateForValidation?.intermediateState ?? {}),
        validationResult: {
          passed: validationResult.passed,
          score: validationResult.score,
          summary: validationResult.summary,
        },
      },
    });

    deps.persistReasoning(pipelineId, {
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

    // 4. Validation failed → fail early
    if (!validationResult.passed && validationResult.summary.errors > 0) {
      logger.warn(
        { pipelineId, score: validationResult.score },
        '[Pipeline] Validator caught errors — failing before Critic'
      );
      const outcome: ProtoTraceOutcome = {
        type: 'validation_failed',
        protoOutput: protoResult.data,
        validationReasoning: {
          agentName: 'validator',
          timestamp: new Date(),
          decision: 'Kod doğrulama başarısız',
          reasoning: [
            `Skor: ${validationResult.score}/100`,
            `${validationResult.summary.errors} hata, ${validationResult.summary.warnings} uyarı`,
          ],
          assumptions: ['Deterministic kontroller yeterli'],
          confidence: {
            score: validationResult.score,
            factors: validationResult.summary.checksRun,
          },
        },
        validationErrorMessage: `${validationResult.summary.errors} error(s) found (score: ${validationResult.score}/100)`,
        protoIteration,
      };
      await handleProtoTraceOutcome(pipelineId, outcome, deps.buildProtoTraceOutcomeDeps());
      return;
    }
  }

  // ─── Level 3: CriticAgent code review (if available) ───
  if (deps.hasCritic) {
    deps.metricsService.startStage(pipelineId, 'critic_code');
    await deps.store.update(pipelineId, {
      protoOutput: protoResult.data,
      stage: 'critic_reviewing_code',
      metrics: protoCompletedMetrics,
    });
    deps.emitEvent(pipelineId, 'stage_change', 'critic_reviewing_code');

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
    const criticResult = await deps.runCriticCodeReview(
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
          decision: criticResult.approved ? 'Kod uygun bulundu' : 'Kod düzeltme gerekli',
          snippet: criticResult.summary,
          confidence: criticResult.overallScore ?? 0,
        }
      );
    }

    deps.metricsService.endStage(pipelineId, 'critic_code', criticResult?.approved ?? true, {
      overallScore: criticResult?.overallScore ?? 0,
      findingsCount: criticResult?.findings?.length ?? 0,
      approved: criticResult?.approved ?? true,
    });

    if (criticResult) {
      const currentState = await deps.store.getById(pipelineId);
      const existingIntermediate = (currentState?.intermediateState ?? {}) as Record<
        string,
        unknown
      >;

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

      await deps.store.update(pipelineId, {
        intermediateState: {
          ...existingIntermediate,
          criticCodeOutput: criticResult,
          iterationHistory: nextHistory,
        },
      });

      deps.persistReasoning(
        pipelineId,
        buildCriticReasoning(criticResult, { reviewType: 'code' })
      );
    }
    logger.info(
      { pipelineId, approved: criticResult?.approved, score: criticResult?.overallScore },
      '[Pipeline] Critic code review completed'
    );

    const hasCritical = criticResult?.hasCriticalFinding === true;
    if (criticResult && hasCritical) {
      const criticIterateDecision = await deps.evaluateCriticIterateLoop(
        pipelineId,
        criticResult,
        spec
      );

      // 5. Critic iterate — re-iterate Proto with critical findings
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
        const outcome: ProtoTraceOutcome = {
          type: 'critic_iterate',
          protoOutput: protoResult.data,
          scribeOutput: pipeline.scribeOutput,
          metrics: protoCompletedMetrics,
          protoIteration,
          criticResult,
          iterateDecision: {
            nextRetry: criticIterateDecision.nextRetry,
            maxRetries: criticIterateDecision.maxRetries,
            feedback: criticIterateDecision.feedback,
          },
        };
        await handleProtoTraceOutcome(pipelineId, outcome, deps.buildProtoTraceOutcomeDeps());
        return;
      }

      // 6. Critic hard-block — max iterate retries exhausted
      logger.info(
        {
          pipelineId,
          score: criticResult.overallScore,
          findings: criticResult.findings?.length ?? 0,
          maxSeverity: criticResult.maxSeverity,
        },
        '[Pipeline] PR-F critic hard-block — severity=critical, pipeline halted at awaiting_critic_resolution'
      );
      const outcome: ProtoTraceOutcome = {
        type: 'critic_hard_block',
        protoOutput: protoResult.data,
        scribeOutput: pipeline.scribeOutput,
        metrics: protoCompletedMetrics,
        protoIteration,
        criticResult,
      };
      await handleProtoTraceOutcome(pipelineId, outcome, deps.buildProtoTraceOutcomeDeps());
      return;
    }
  }

  // 7+8. Ready for trace
  const outcome: ProtoTraceOutcome = {
    type: 'ready_for_trace',
    protoOutput: protoResult.data,
    scribeOutput: pipeline.scribeOutput,
    metrics: protoCompletedMetrics,
    protoIteration,
    previewGateEnabled,
    jiraContext: pipeline.jiraConfig?.epicKey
      ? { userId: pipeline.userId, epicKey: pipeline.jiraConfig.epicKey }
      : undefined,
  };
  await handleProtoTraceOutcome(pipelineId, outcome, deps.buildProtoTraceOutcomeDeps());

  // ─── Post-handler: Trace execution ───────────────────────────
  if (await deps.isCancelled(pipelineId)) return;

  if (previewGateEnabled) {
    logger.info(
      { pipelineId, fileCount: protoResult.data.files.length },
      '[Pipeline] PR-F2 Trace dryRun starting before push gate'
    );
    await deps.runTrace(
      pipelineId,
      metrics,
      owner,
      repoName,
      protoResult.data.branch,
      spec,
      model,
      {
        dryRun: true,
        inputFiles: protoResult.data.files.map((f) => ({
          filePath: f.filePath,
          content: f.content,
        })),
        postSuccess: 'awaiting_push_confirm',
      }
    );
  } else {
    const resolvedRepoName = protoResult.data.repo.split('/').pop() ?? repoName;
    if (resolvedRepoName !== repoName) {
      const pipelineForConfig = await deps.getPipeline(pipelineId);
      if (pipelineForConfig.protoConfig) {
        await deps.store.update(pipelineId, {
          protoConfig: { ...pipelineForConfig.protoConfig, repoName: resolvedRepoName },
        });
      }
    }
    await deps.runTrace(
      pipelineId,
      metrics,
      owner,
      resolvedRepoName,
      protoResult.data.branch,
      spec,
      model
    );
  }
}

// ── Iteration Mode ──────────────────────────────

export async function runIterationProtoAndTraceStage(
  pipelineId: string,
  metrics: PipelineMetrics,
  originalSpec: StructuredSpec,
  existingRepo: { owner: string; repo: string; branch: string },
  iterationRequest: string,
  deps: RunIterationProtoAndTraceDeps,
  model?: string,
  imageBlocks?: readonly import('../../../../services/ai/multimodalClient.js').AnthropicImageBlock[]
): Promise<void> {
  pipelineCallContext.enterWith({ pipelineId });
  const protoEmit = createActivityEmitter(pipelineId, 'proto');
  protoEmit('start', 'Mevcut kod okunuyor...', 5);
  logger.info(
    { pipelineId, imageCount: imageBlocks?.length ?? 0 },
    '[Pipeline] Iteration Proto dispatch'
  );

  const pipeline = await deps.getPipeline(pipelineId);
  let userGitHubToken: string;
  try {
    const gh = await deps.validateGitHubAccess(pipeline.userId);
    userGitHubToken = gh.token;
  } catch (err) {
    const error = createPipelineError(
      PipelineErrorCode.GITHUB_NOT_CONNECTED,
      `GitHub bağlantısı bulunamadı: ${err instanceof Error ? err.message : String(err)}`
    );
    await deps.store.update(pipelineId, { stage: 'failed', error });
    deps.emitEvent(pipelineId, 'error', 'failed', error);
    return;
  }

  const userGithubService = deps.createGitHubService(userGitHubToken);
  let existingFiles: Array<{ path: string; content: string }> = [];
  try {
    protoEmit(
      'progress',
      `${existingRepo.owner}/${existingRepo.repo} deposundan dosyalar okunuyor...`,
      15
    );
    existingFiles = await deps.readRepoFiles(
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

  const protoModel = model ?? 'claude-sonnet-4-6';
  const tokenCb = deps.createTokenCallback(pipelineId);
  const agents = userGithubService
    ? (deps.createAgentsForModel?.(protoModel, userGithubService, tokenCb) ??
      deps.getAgents(protoModel, pipelineId))
    : deps.getAgents(protoModel, pipelineId);

  await deps.writeCheckpoint(pipelineId, 'proto', `İterasyon: ${iterationRequest.slice(0, 80)}`);
  const iterationKnowledgeRaw = buildUnifiedAgentKnowledgeContext(pipeline, { role: 'proto' });
  const iterationKnowledgeBase = iterationKnowledgeRaw.trim() ? iterationKnowledgeRaw : undefined;
  const iterationKnowledge = await deps.applyChatMemory(
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

  if (await deps.isCancelled(pipelineId)) return;

  if (protoResult.type === 'error') {
    await deps.maybeInvalidateGitHubTokenOnAuthError(pipelineId, protoResult.error.code);
    await deps.store.update(pipelineId, { stage: 'failed', error: protoResult.error });
    deps.emitEvent(pipelineId, 'error', 'failed', protoResult.error);
    return;
  }

  protoResult.data = deps.applyArtifactInjection(protoResult.data, pipeline.scribeOutput);

  const protoCompletedMetrics = { ...metrics, protoCompletedAt: new Date() };
  deps.logActivity(pipelineId, 'proto', 'iteration_applied', {
    filesGenerated: protoResult.data.files?.length ?? 0,
    iterationRequest: iterationRequest.slice(0, 200),
  });

  await deps.store.update(pipelineId, {
    protoOutput: protoResult.data,
    stage: 'completed',
    metrics: {
      ...protoCompletedMetrics,
      traceCompletedAt: new Date(),
      totalDurationMs: Date.now() - toEpoch(protoCompletedMetrics.startedAt),
    },
  });
  deps.emitEvent(pipelineId, 'stage_change', 'completed');
}
