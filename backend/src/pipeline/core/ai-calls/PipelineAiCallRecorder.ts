import { db as defaultDb } from '../../../db/client.js';
import { jobAiCalls, type NewJobAiCall } from '../../../db/schema.js';
import {
  truncateForLog,
  truncateStructuredForLog,
} from '../../../services/ai/truncatePromptContent.js';
import type { AICallMetrics, AIServiceObserver } from '../../../services/ai/AIService.js';
import { logger } from '../../../lib/logger.js';
import { getCurrentPipelineId } from './pipelineCallContext.js';

/**
 * Reuses the same byte budget the legacy TraceRecorder uses so the two write
 * paths stay symmetrical — see `backend/src/core/tracing/TraceRecorder.ts`.
 */
function getAiLogContentMaxBytes(): number {
  const raw = process.env.AI_LOG_CONTENT_MAX_BYTES;
  if (!raw) return 100_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100_000;
  return parsed;
}

interface RecorderDb {
  insert: (typeof defaultDb)['insert'];
}

export interface PipelineAiCallRecorderOptions {
  /** Override the Drizzle client. Tests pass a fake; `null` disables persistence. */
  db?: RecorderDb | null;
}

/**
 * T1: AIService observer that writes every pipeline AI call to
 * `job_ai_calls` with `pipeline_id` set.
 *
 * Activation is gated on the AsyncLocalStorage context: if no pipelineId is
 * in scope when `onAiCall` fires, the recorder silently no-ops so the legacy
 * single-agent path (which has its own TraceRecorder-driven writer) keeps
 * sole ownership of the table for jobs.
 *
 * `callIndex` is computed per pipeline via an in-memory counter; first call
 * for a pipeline is 0, second is 1, etc. The counter Map is bounded by the
 * pipeline lifecycle — entries get GC'd whenever the ALS scope unwinds,
 * but we also expose `forgetPipeline` so the orchestrator can release the
 * counter explicitly once a pipeline is complete.
 */
export class PipelineAiCallRecorder implements AIServiceObserver {
  private readonly db: RecorderDb | null;
  private readonly callIndexByPipeline = new Map<string, number>();

  constructor(options: PipelineAiCallRecorderOptions = {}) {
    this.db = options.db === undefined ? defaultDb : options.db;
  }

  onAiCall(metrics: AICallMetrics): void {
    if (!this.db) return;
    const pipelineId = getCurrentPipelineId();
    if (!pipelineId) return;

    const callIndex = this.callIndexByPipeline.get(pipelineId) ?? 0;
    this.callIndexByPipeline.set(pipelineId, callIndex + 1);

    const maxBytes = getAiLogContentMaxBytes();
    const row: NewJobAiCall = {
      jobId: null,
      pipelineId,
      callIndex,
      provider: metrics.provider,
      model: metrics.model,
      purpose: metrics.purpose.substring(0, 255),
      inputTokens: metrics.usage?.inputTokens ?? null,
      outputTokens: metrics.usage?.outputTokens ?? null,
      totalTokens: metrics.usage?.totalTokens ?? null,
      durationMs: metrics.durationMs ?? null,
      estimatedCostUsd:
        metrics.estimatedCostUsd !== undefined && metrics.estimatedCostUsd !== null
          ? String(metrics.estimatedCostUsd)
          : null,
      success: metrics.success,
      errorCode: metrics.errorCode ?? null,
      systemPrompt: truncateForLog(metrics.content?.systemPrompt, maxBytes) ?? null,
      userPrompt: truncateForLog(metrics.content?.userPrompt, maxBytes) ?? null,
      responseText: truncateForLog(metrics.content?.responseText, maxBytes) ?? null,
      thinkingBlocks:
        metrics.content?.thinkingBlocks !== undefined
          ? (truncateStructuredForLog(metrics.content.thinkingBlocks, maxBytes) as unknown as
              | Record<string, unknown>
              | unknown[]
              | null)
          : null,
      toolCalls:
        metrics.content?.toolCalls !== undefined
          ? (truncateStructuredForLog(metrics.content.toolCalls, maxBytes) as unknown as
              | Record<string, unknown>
              | unknown[]
              | null)
          : null,
    };

    // Fire-and-forget — AI call sites shouldn't block on logging, and the
    // observer interface is synchronous. We log but never throw: a logging
    // failure must never abort a pipeline.
    void this.db
      .insert(jobAiCalls)
      .values(row)
      .catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { pipelineId, purpose: metrics.purpose, err: errMsg },
          '[PipelineAiCallRecorder] insert failed'
        );
      });
  }

  /** Release the in-memory call-index counter for a finished pipeline. */
  forgetPipeline(pipelineId: string): void {
    this.callIndexByPipeline.delete(pipelineId);
  }
}
