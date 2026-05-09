-- PDP-2 Wave 2 — F-03 + F-11 / NFR-1
--
-- Adds DB-backed counterparts of two in-memory structures:
--   * ExplainabilityService's per-pipeline AgentReasoning map → pipeline_reasonings
--   * activityEmitter's per-pipeline ring buffer            → pipeline_activities
--
-- Why: Backend restart was wiping reasoning + activity state (F-03), and the
-- persistence layer simply did not exist (F-11 / yokluk-gap). NFR-1 mandates
-- "kullanıcı tekrar oturum açtığında tüm reasoning + activity geri gelir".
--
-- See: docs/product/03-architecture.md § 4.1, § 4.2 + ADR-1 + ADR-2.
--
-- Hand-written rather than `drizzle-kit generate` because the existing schema
-- uses ESM `.js` re-exports that drizzle-kit 0.22 cannot resolve from its
-- CommonJS bundle (same pattern as 0044_add_agent_activities.sql).

-- UP -------------------------------------------------------------------------

-- pipeline_reasonings -------------------------------------------------------
-- One row per (pipeline, stage). Stage key examples: 'scribe', 'critic-spec',
-- 'proto', 'critic-code', 'trace'. Used by /pipelines/:id/explanation.
CREATE TABLE IF NOT EXISTS "pipeline_reasonings" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pipeline_id"      uuid NOT NULL REFERENCES "pipelines"("id") ON DELETE CASCADE,
  "stage"            text NOT NULL,
  "agent_reasoning"  jsonb NOT NULL,
  "recorded_at"      timestamptz NOT NULL DEFAULT now(),
  -- Soft-delete column (NFR-1.3). Default visibility filters to NULL.
  "archived_at"      timestamptz
);

-- One latest reasoning per (pipeline, stage). Newer adds overwrite via UPSERT.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_pipeline_stage"
  ON "pipeline_reasonings" ("pipeline_id", "stage");

-- Lookup-by-pipeline (the dominant read pattern for getExplanation()).
CREATE INDEX IF NOT EXISTS "idx_reasonings_pipeline"
  ON "pipeline_reasonings" ("pipeline_id");


-- pipeline_activities -------------------------------------------------------
-- Append-only audit log of activity events; durable equivalent of the in-memory
-- ring buffer. Cascades on pipeline delete.
CREATE TABLE IF NOT EXISTS "pipeline_activities" (
  "id"                 bigserial PRIMARY KEY NOT NULL,
  "pipeline_id"        uuid NOT NULL REFERENCES "pipelines"("id") ON DELETE CASCADE,
  "stage"              text NOT NULL,
  "step"               text NOT NULL,
  "message"            text,
  "progress"           integer,
  "retry_count"        integer DEFAULT 0,
  "reasoning_snippet"  jsonb,
  "emitted_at"         timestamptz NOT NULL DEFAULT now()
);

-- Replay queries are always (pipeline, time-ordered) — composite index covers them.
CREATE INDEX IF NOT EXISTS "idx_activities_pipeline_time"
  ON "pipeline_activities" ("pipeline_id", "emitted_at");


-- DOWN -----------------------------------------------------------------------
-- DROP INDEX IF EXISTS idx_activities_pipeline_time;
-- DROP TABLE IF EXISTS pipeline_activities;
-- DROP INDEX IF EXISTS idx_reasonings_pipeline;
-- DROP INDEX IF EXISTS uniq_pipeline_stage;
-- DROP TABLE IF EXISTS pipeline_reasonings;
