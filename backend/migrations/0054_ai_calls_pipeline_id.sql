-- T1: Pipeline AI call logging — add `pipeline_id` to `job_ai_calls` and
-- make `job_id` nullable so the modern PipelineOrchestrator can persist its
-- AI calls without a synthetic `jobs` row.
--
-- Why: legacy single-agent endpoints (/api/agents/*) own a `jobs` row per
-- invocation, but the pipeline orchestrator (Scribe → Critic → Proto →
-- Validator → Trace) doesn't — its AI calls had nowhere to land. The "AI
-- Logları" tab was empty for every modern pipeline. After this migration,
-- the new PipelineAiCallRecorder writes one row per AI call with
-- `pipeline_id` set (and `job_id = NULL`); the reader service can query the
-- column directly. Legacy jobs-correlated rows continue to work via the
-- jobs.payload->>'pipelineId' fallback in AiCallsService.getCalls.
--
-- Safe to re-run: column add, constraint drop, FK add (via DO/EXCEPTION),
-- and index create are all idempotent.

ALTER TABLE "job_ai_calls" ADD COLUMN IF NOT EXISTS "pipeline_id" uuid;
ALTER TABLE "job_ai_calls" ALTER COLUMN "job_id" DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE "job_ai_calls"
    ADD CONSTRAINT "job_ai_calls_pipeline_id_fkey"
    FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_job_ai_calls_pipeline_id" ON "job_ai_calls" ("pipeline_id");
