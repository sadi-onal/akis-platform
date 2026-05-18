-- P9: align trace_enabled column default with schema + orchestrator.
--
-- Background: previously the API request schema (StartPipelineRequestSchema)
-- defaulted `traceEnabled` to `true`, but the underlying DB column defaulted
-- to `false` and the orchestrator fallback also resolved to `false`. When the
-- frontend forgot to send the flag or a non-API caller created a pipeline,
-- the row landed with `trace_enabled=false` and the Trace stage never ran.
-- The user-visible symptom was "Trace hiç çalışmadı" even though TraceAgent
-- is fully wired and active.
--
-- Fix: column default `false` → `true`. Existing rows are not touched (only
-- the column default changes). New pipelines inserted without an explicit
-- `trace_enabled` value will get `true`, matching the schema + orchestrator
-- post-P9.
--
-- Safe to re-run: ALTER COLUMN ... SET DEFAULT is idempotent.

ALTER TABLE "pipelines" ALTER COLUMN "trace_enabled" SET DEFAULT true;
