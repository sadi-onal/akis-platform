-- Issue #437: per-chat model picker.
--
-- The TypeScript `PipelineState.model?: string` field and the orchestrator's
-- `updateData.model = model` path have been in place since early pipeline
-- work, but `DrizzlePipelineStore.update/rowToState` never mapped the field
-- to a column — because the column did not exist. Every read returned
-- `undefined` and downstream stages fell back to `claude-sonnet-4-6`.
--
-- This migration adds the missing column so the per-chat model dropdown can
-- actually persist the user's choice and the iteration child / Scribe
-- continuation / Proto retry all use the chosen model instead of silently
-- resetting to sonnet.
--
-- Column is nullable by design — existing rows get `NULL` which keeps the
-- current `?? 'claude-sonnet-4-6'` fallback behaviour byte-for-byte
-- identical for legacy pipelines.

ALTER TABLE pipelines
  ADD COLUMN IF NOT EXISTS model varchar(255);

-- No index: model is only ever read together with the pipeline row.
