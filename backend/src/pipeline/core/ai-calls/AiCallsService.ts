// P5b: AI request log viewer service.
//
// Looks up `job_ai_calls` rows for a pipeline so the AI Logs tab can render
// "what we asked the model and what it answered" for every AI call the
// pipeline made.
//
// Correlation model
// -----------------
// Two write paths land in the same table:
//   1. Pipeline orchestrator (T1, modern): writes one row per AI call with
//      `pipeline_id` set directly.
//   2. Legacy single-agent endpoints (`/api/agents/*`): write rows with
//      `job_id` set, where `jobs.payload->>'pipelineId'` may carry a
//      pipeline reference for the older flow.
//
// `getCalls(pipelineId)` returns the union of both, ordered by timestamp →
// callIndex. Pre-existing pipelines that wrote nothing yield an empty list.
//
// Auth is enforced at the route layer (pipeline ownership). The service is
// trusting and stateless.

import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';

import { db as defaultDb } from '../../../db/client.js';
import { jobAiCalls, jobs } from '../../../db/schema.js';
import type { AiCallEntry } from './AiCallsTypes.js';

/**
 * Minimal Drizzle-shape interface so tests can inject a fake without
 * pulling the NodePgDatabase generic. Mirrors the slice used by
 * `ExplainabilityService`.
 */
export interface AiCallsDb {
  select: (typeof defaultDb)['select'];
}

export interface AiCallsServiceOptions {
  /** Override the default Drizzle client. Pass `null` to disable DB lookups (always returns []). */
  db?: AiCallsDb | null;
}

/**
 * Convert a raw `job_ai_calls` row (drizzle select) into the wire-format
 * `AiCallEntry`. Pulled out for testability + so the JSON columns can be
 * type-narrowed in one place.
 */
export function mapRowToAiCallEntry(row: {
  id: string;
  callIndex: number;
  provider: string;
  model: string;
  purpose: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
  success: boolean;
  errorCode: string | null;
  timestamp: Date;
  systemPrompt: string | null;
  userPrompt: string | null;
  responseText: string | null;
  thinkingBlocks: unknown;
  toolCalls: unknown;
}): AiCallEntry {
  return {
    id: row.id,
    callIndex: row.callIndex,
    provider: row.provider,
    model: row.model,
    purpose: row.purpose,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    durationMs: row.durationMs,
    success: row.success,
    errorCode: row.errorCode,
    timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : String(row.timestamp),
    systemPrompt: row.systemPrompt,
    userPrompt: row.userPrompt,
    responseText: row.responseText,
    thinkingBlocks: Array.isArray(row.thinkingBlocks) ? row.thinkingBlocks : null,
    toolCalls: Array.isArray(row.toolCalls) ? row.toolCalls : null,
  };
}

export class AiCallsService {
  private readonly db: AiCallsDb | null;

  constructor(options: AiCallsServiceOptions = {}) {
    this.db = options.db === undefined ? defaultDb : options.db;
  }

  /**
   * Return the AI calls for a pipeline, ordered by `callIndex` ascending.
   *
   * Ownership is the route layer's job — by the time we get here the caller
   * has been verified as the pipeline owner.
   */
  async getCalls(pipelineId: string): Promise<AiCallEntry[]> {
    if (!this.db) return [];
    if (!pipelineId) return [];

    // T1: prefer the direct `pipeline_id` column (modern pipeline path).
    // Fall back to legacy rows where the `jobs.payload->>'pipelineId'`
    // shape carried the correlation, so single-agent endpoints that pre-date
    // the column keep working. Drizzle's leftJoin returns the join as
    // nullable; we filter via OR on the two possible matches.
    const rows = await this.db
      .select({
        id: jobAiCalls.id,
        callIndex: jobAiCalls.callIndex,
        provider: jobAiCalls.provider,
        model: jobAiCalls.model,
        purpose: jobAiCalls.purpose,
        inputTokens: jobAiCalls.inputTokens,
        outputTokens: jobAiCalls.outputTokens,
        totalTokens: jobAiCalls.totalTokens,
        durationMs: jobAiCalls.durationMs,
        success: jobAiCalls.success,
        errorCode: jobAiCalls.errorCode,
        timestamp: jobAiCalls.timestamp,
        systemPrompt: jobAiCalls.systemPrompt,
        userPrompt: jobAiCalls.userPrompt,
        responseText: jobAiCalls.responseText,
        thinkingBlocks: jobAiCalls.thinkingBlocks,
        toolCalls: jobAiCalls.toolCalls,
      })
      .from(jobAiCalls)
      .leftJoin(jobs, eq(jobs.id, jobAiCalls.jobId))
      .where(
        or(
          eq(jobAiCalls.pipelineId, pipelineId),
          and(
            isNull(jobAiCalls.pipelineId),
            sql`(${jobs.payload}->>'pipelineId')::text = ${pipelineId}`
          )
        )
      )
      .orderBy(asc(jobAiCalls.timestamp), asc(jobAiCalls.callIndex));

    return rows.map(mapRowToAiCallEntry);
  }
}
