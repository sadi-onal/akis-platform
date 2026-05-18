-- P5a: persist AI call content (prompt, response, thinking, tool_calls) on
-- the `job_ai_calls` table.
--
-- Background: `job_ai_calls` already tracks per-call metrics (provider,
-- model, tokens, duration, success, cost). It does NOT capture the actual
-- prompt or response payload, so the admin/debug viewer (P5b, next PR) has
-- nothing to show beyond aggregate numbers. To debug "why did Proto emit
-- this scaffold?" or "what exactly did Critic see?" we need the text that
-- went into and came out of the model.
--
-- This migration adds five nullable columns:
--   - system_prompt      TEXT  — system role content sent to the provider
--   - user_prompt        TEXT  — user role content sent to the provider
--   - response_text      TEXT  — model's flat text response
--   - thinking_blocks    JSONB — Anthropic extended-thinking blocks (when
--                                provider emits them)
--   - tool_calls         JSONB — tool_use blocks in the model response
--
-- Truncation: the application layer (TraceRecorder + truncatePromptContent
-- helper) caps each text column to AI_LOG_CONTENT_MAX_BYTES (default 100KB)
-- before insert, and the JSONB columns get the same byte budget via a
-- structured-truncation sentinel. The DB itself stores TEXT/JSONB without
-- bound — production retention/scrubbing is intentionally out of scope for
-- this PR and is tracked separately.
--
-- All new columns are nullable so the migration is non-breaking for the
-- existing pipeline-run history; old rows simply read back NULL for these
-- fields. New writes from TraceRecorder.recordAiCall() will populate them
-- when the caller (AIService observer) passes the values through.
--
-- Safe to re-run: ALTER TABLE ADD COLUMN IF NOT EXISTS is idempotent.

ALTER TABLE "job_ai_calls" ADD COLUMN IF NOT EXISTS "system_prompt" TEXT;
ALTER TABLE "job_ai_calls" ADD COLUMN IF NOT EXISTS "user_prompt" TEXT;
ALTER TABLE "job_ai_calls" ADD COLUMN IF NOT EXISTS "response_text" TEXT;
ALTER TABLE "job_ai_calls" ADD COLUMN IF NOT EXISTS "thinking_blocks" JSONB;
ALTER TABLE "job_ai_calls" ADD COLUMN IF NOT EXISTS "tool_calls" JSONB;
