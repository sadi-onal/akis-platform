/**
 * P5b: AI request log viewer types.
 *
 * `AiCallEntry` is the contract between the backend `AiCallsService` and the
 * frontend `AiCallsPanel`. Mirrors the relevant columns from `job_ai_calls`,
 * including the P5a content fields (`systemPrompt`, `userPrompt`,
 * `responseText`, `thinkingBlocks`, `toolCalls`).
 *
 * Content fields are nullable because:
 *   - Older rows pre-P5a have no content captured.
 *   - The TraceRecorder truncates over `AI_LOG_CONTENT_MAX_BYTES` (default
 *     100KB); when truncation kicks in the value ends with `... [truncated]`.
 */
export interface AiCallEntry {
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
  /** ISO 8601 string — serialized for stable transport. */
  timestamp: string;
  /** P5a content fields (truncated to AI_LOG_CONTENT_MAX_BYTES). */
  systemPrompt: string | null;
  userPrompt: string | null;
  responseText: string | null;
  /** JSON-typed; unknown[] to avoid lying about the model's tool-block shape. */
  thinkingBlocks: unknown[] | null;
  toolCalls: unknown[] | null;
}
