/**
 * Trace stage runner extracted from PipelineOrchestrator.
 *
 * Kademe 2 refactor — zero behavior change, mechanical extraction.
 * Every `this.X` dependency becomes an explicit `deps.X` parameter.
 */
import type {
  PipelineState,
  PipelineStage,
  PipelineMetrics,
  StructuredSpec,
} from '../../contracts/PipelineTypes.js';
import { RETRY_CONFIG } from '../../contracts/PipelineErrors.js';
import { createActivityEmitter } from '../../activityEmitter.js';
import { withRetry } from '../../retryWrapper.js';
import { scoreTraceEffort } from '../../effortScorer.js';
import { logger } from '../../../../lib/logger.js';
import { buildUnifiedAgentKnowledgeContext } from '../../unifiedPipelineContext.js';
import { pipelineCallContext } from '../../ai-calls/pipelineCallContext.js';
import type { AgentSet, PipelineStore } from '../PipelineOrchestrator.js';
import type { TraceOutcome, HandleTraceOutcomeDeps } from '../outcomes/TraceOutcome.js';
import { handleTraceOutcome } from '../outcomes/TraceOutcome.js';
import type { FixLoopService } from '../../fix-loop/FixLoopService.js';
import type { SecurityGate } from '../../security-gate/SecurityGate.js';
import type { SecurityScanResult } from '../../security-gate/SecurityGateTypes.js';
import type { PipelineMetricsService } from '../../metrics/PipelineMetricsService.js';

const TRACE_TIMEOUT = RETRY_CONFIG.traceStageTimeoutMs;

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

// ── Deps interface ──────────────────────────────

export interface RunTraceDeps {
  store: PipelineStore;
  getPipeline: (id: string) => Promise<PipelineState>;
  emitEvent: (
    pipelineId: string,
    type: 'stage_change' | 'scribe_message' | 'error' | 'completed',
    stage?: PipelineStage,
    data?: unknown
  ) => void;
  getAgents: (model?: string, pipelineId?: string) => AgentSet;
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
  appendTraceStarted: (pipelineId: string) => Promise<number>;
  appendTraceFailed: (
    pipelineId: string,
    iteration: number,
    errorCode: string,
    errorMessage: string,
    recoveryAction?: 'retry' | 'skip'
  ) => Promise<void>;
  maybeInvalidateGitHubTokenOnAuthError: (
    pipelineId: string,
    errorCode: string
  ) => Promise<void>;
  evaluateTraceIterateLoop: (
    pipelineId: string,
    traceOutput: import('../../contracts/PipelineTypes.js').TraceOutput,
    spec?: StructuredSpec
  ) => Promise<{
    shouldIterate: boolean;
    nextRetry: number;
    maxRetries: number;
    uncoveredCount: number;
    totalCount: number;
    feedback: string;
  }>;
  buildTraceOutcomeDeps: () => HandleTraceOutcomeDeps;
  fixLoopService: FixLoopService;
  securityGate: SecurityGate;
  metricsService: Pick<PipelineMetricsService, 'startStage' | 'endStage'>;
}

// ── Exported function ───────────────────────────

export async function runTraceStage(
  pipelineId: string,
  metrics: PipelineMetrics,
  owner: string,
  repo: string,
  branch: string,
  deps: RunTraceDeps,
  spec?: StructuredSpec,
  model?: string,
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

  // Effort-based model routing for Trace
  const traceEffort = scoreTraceEffort({ fileCount: spec?.acceptanceCriteria?.length ?? 5 });
  const traceModel = model ?? traceEffort.model;
  logger.info(
    `[Trace] Effort: ${traceEffort.score}/10 → Model: ${traceModel} (${traceEffort.reasoning})`
  );

  const agents = deps.getAgents(traceModel, pipelineId);
  await deps.writeCheckpoint(pipelineId, 'trace', `${owner}/${repo}@${branch}`);
  const pipelineForCucumber = await deps.getPipeline(pipelineId);
  const cucumberEnabled =
    (pipelineForCucumber.intermediateState as Record<string, unknown> | undefined)
      ?.cucumberEnabled === true;
  const traceKnowledgeRaw = buildUnifiedAgentKnowledgeContext(pipelineForCucumber, {
    role: 'trace',
  });
  const traceKnowledgeBase = traceKnowledgeRaw.trim() ? traceKnowledgeRaw : undefined;
  const traceQuery = spec?.title ?? `${owner}/${repo}@${branch}`;
  const traceKnowledge = await deps.applyChatMemory(
    pipelineForCucumber,
    traceKnowledgeBase,
    traceQuery,
    { messageIndex: (pipelineForCucumber.scribeConversation?.length ?? 0) + 2 }
  );
  const traceImageBlocks = readPipelineImageBlocks(pipelineForCucumber.intermediateState);
  const traceIteration = await deps.appendTraceStarted(pipelineId);
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

  // ── Kademe 3: Determine outcome, then delegate side-effects to
  // handleTraceOutcome (declarative, testable, exhaustive). ──

  if (traceResult.type === 'error') {
    const isAiTimeout = traceResult.error.code === 'TRACE_AI_CALL_TIMEOUT';
    const isGitHubAuthError = traceResult.error.code === 'GITHUB_TOKEN_INVALID';
    await deps.maybeInvalidateGitHubTokenOnAuthError(pipelineId, traceResult.error.code);
    await deps.appendTraceFailed(
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

    // ── Return path 1: dryRun failure → push-gate handoff ──
    if (traceDryRun && postSuccessStage === 'awaiting_push_confirm') {
      const pipelineNow = await deps.store.getById(pipelineId);
      const intermediate = (pipelineNow?.intermediateState ?? {}) as Record<string, unknown>;
      const rawSnippet = traceResult.error.technicalDetail ?? null;
      await deps.store.update(pipelineId, {
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
      });
      logger.warn(
        { pipelineId, errorCode: traceResult.error.code },
        '[Pipeline] PR-F2 Trace dryRun failed — handing off to push gate without tests'
      );
      const outcome: TraceOutcome = { type: 'dry_run_failure' };
      await handleTraceOutcome(pipelineId, outcome, deps.buildTraceOutcomeDeps());
      return (await deps.store.getById(pipelineId)) as PipelineState;
    }

    // ─── Level 3: FixLoop auto-trigger on Trace failure ───
    const currentPipelineForFix = await deps.store.getById(pipelineId);
    const protoOutput = currentPipelineForFix?.protoOutput;
    if (protoOutput && spec && !isAiTimeout && !isGitHubAuthError) {
      logger.info({ pipelineId }, '[Pipeline] Trace failed — triggering FixLoop');
      await deps.store.update(pipelineId, { stage: 'fix_loop_iteration' });
      deps.emitEvent(pipelineId, 'stage_change', 'fix_loop_iteration');
      deps.metricsService.startStage(pipelineId, 'fix_loop');

      const fixResult = await deps.fixLoopService.runFixLoop(
        spec,
        async (_s, feedback) => {
          const fixAgents = deps.getAgents(model, pipelineId);
          const pl = await deps.getPipeline(pipelineId);
          const baseCtx = buildUnifiedAgentKnowledgeContext(pl, { role: 'proto' });
          const fb = feedback
            ? `\n--- FIX LOOP FEEDBACK ---\n${feedback}\n--- END FEEDBACK ---\n`
            : '';
          const merged = [baseCtx, fb].filter(Boolean).join('\n');
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
          const secScan = deps.securityGate.scan(
            protoOut.files.map((f) => ({ path: f.filePath, content: f.content }))
          );
          const prevScan = (
            currentPipelineForFix?.intermediateState as Record<string, unknown> | undefined
          )?.lastSecurityScan as SecurityScanResult | undefined;
          const gateDecision = deps.securityGate.evaluate(secScan, prevScan);
          if (!gateDecision.allowed) {
            logger.warn(
              { pipelineId, reason: gateDecision.reason },
              '[Pipeline] SecurityGate blocked fix iteration'
            );
            throw new Error(`SecurityGate: ${gateDecision.reason}`);
          }

          const fixAgents = deps.getAgents(model, pipelineId);
          const plTrace = await deps.getPipeline(pipelineId);
          const traceKb = buildUnifiedAgentKnowledgeContext(plTrace, { role: 'trace' });
          const fixCucumberEnabled =
            (plTrace.intermediateState as Record<string, unknown> | undefined)
              ?.cucumberEnabled === true;
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

      deps.metricsService.endStage(pipelineId, 'fix_loop', fixResult.success, {
        iterationCount: fixResult.totalIterations,
        terminationReason: fixResult.terminationReason,
      });

      // ── Return path 2: FixLoop success ──
      if (fixResult.success && fixResult.finalTraceOutput) {
        const outcome: TraceOutcome = {
          type: 'fix_loop_success',
          protoOutput: fixResult.finalProtoOutput ?? protoOutput,
          traceOutput: fixResult.finalTraceOutput,
          metrics,
        };
        await handleTraceOutcome(pipelineId, outcome, deps.buildTraceOutcomeDeps());
        return (await deps.store.getById(pipelineId)) as PipelineState;
      }
      logger.info(
        { pipelineId, reason: fixResult.terminationReason },
        '[Pipeline] FixLoop failed — falling through to completed_partial'
      );
    }

    // ── Return path 3: Trace error / FixLoop failure → completed_partial ──
    const outcome: TraceOutcome = {
      type: 'trace_error',
      error: traceResult.error,
      metrics,
    };
    await handleTraceOutcome(pipelineId, outcome, deps.buildTraceOutcomeDeps());
    return (await deps.store.getById(pipelineId)) as PipelineState;
  }

  // ─── PR-F: Trace iterate-loop ──
  const iterateLoopDecision = await deps.evaluateTraceIterateLoop(
    pipelineId,
    traceResult.data,
    spec
  );

  // ── Return path 4: Iterate retry ──
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
    const pipelineAfterTrace = (await deps.store.getById(pipelineId)) as PipelineState;
    const outcome: TraceOutcome = {
      type: 'iterate_retry',
      traceOutput: traceResult.data,
      iterateDecision: iterateLoopDecision,
      pipelineAfterTrace,
    };
    await handleTraceOutcome(pipelineId, outcome, deps.buildTraceOutcomeDeps());
    return (await deps.store.getById(pipelineId)) as PipelineState;
  }

  // ── Return path 5: Success ──
  const pipelineForFlag = traceDryRun ? await deps.store.getById(pipelineId) : undefined;
  const intermediateForFlag = traceDryRun
    ? ((pipelineForFlag?.intermediateState ?? {}) as Record<string, unknown>)
    : undefined;
  const outcome: TraceOutcome = {
    type: 'success',
    traceOutput: traceResult.data,
    metrics,
    postSuccessStage,
    traceDryRun,
    intermediateForFlag,
    traceIteration,
  };
  await handleTraceOutcome(pipelineId, outcome, deps.buildTraceOutcomeDeps());
  return (await deps.store.getById(pipelineId)) as PipelineState;
}
