-- Issue #473: agent_activities table was defined in pipeline/db/agent-activity-schema.ts
-- and wired into AgentActivityService / orchestrator, but was never included in
-- drizzle.config.ts schema path → Drizzle generator never saw the table → no migration
-- was ever produced → table is missing in prod DB.
--
-- Impact: Settings /settings?tab=integrity shows all-zero agent compliance,
-- empty confidence trend, empty assumptions list. Pipeline Stats tab missing
-- model distribution and per-agent token data.
--
-- Fix: agent-activity-schema.ts is now re-exported from src/db/schema.ts.
-- This migration creates the missing table.
--
-- Idempotency: CREATE TABLE IF NOT EXISTS guard so re-running on a DB that
-- somehow already has the table is a no-op.

-- UP -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "agent_activities" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pipeline_id"      uuid NOT NULL,
  "agent"            varchar(10) NOT NULL,
  "action"           varchar(100) NOT NULL,
  "reasoning"        text,

  -- Token usage from Claude API
  "input_tokens"     integer DEFAULT 0,
  "output_tokens"    integer DEFAULT 0,

  -- Agent-specific metrics
  "confidence"       real,
  "files_generated"  integer,
  "tests_passed"     integer,
  "tests_failed"     integer,
  "spec_compliance"  real,
  "assumptions"      jsonb,

  -- Performance
  "response_time_ms" integer,
  "model"            varchar(50),

  "created_at"       timestamptz NOT NULL DEFAULT now()
);

-- Index for per-pipeline activity lookups (most common query pattern)
CREATE INDEX IF NOT EXISTS "idx_agent_activities_pipeline_id"
  ON "agent_activities" ("pipeline_id", "created_at" DESC);

-- Index for recent-activity queries across all pipelines
CREATE INDEX IF NOT EXISTS "idx_agent_activities_created_at"
  ON "agent_activities" ("created_at" DESC);

-- FK to pipelines: cascade-delete activities when a pipeline is removed.
-- Uses DO $$ block to be idempotent (skip if constraint already exists).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_agent_activities_pipeline_id'
      AND conrelid = 'agent_activities'::regclass
  ) THEN
    ALTER TABLE "agent_activities"
      ADD CONSTRAINT "fk_agent_activities_pipeline_id"
      FOREIGN KEY ("pipeline_id") REFERENCES "pipelines" ("id")
      ON DELETE CASCADE
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

-- DOWN -----------------------------------------------------------------------
-- ALTER TABLE agent_activities DROP CONSTRAINT IF EXISTS fk_agent_activities_pipeline_id;
-- DROP INDEX IF EXISTS idx_agent_activities_created_at;
-- DROP INDEX IF EXISTS idx_agent_activities_pipeline_id;
-- DROP TABLE IF EXISTS agent_activities;
