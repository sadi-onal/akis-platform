-- pipelines core: table was never created in earlier SQL migrations (schema drift vs push-only DBs).
-- Must run before 0036/0037 ALTERs on pipelines.

DO $$ BEGIN
  CREATE TYPE "public"."pipeline_stage" AS ENUM (
    'scribe_clarifying',
    'scribe_generating',
    'critic_reviewing_spec',
    'awaiting_approval',
    'proto_building',
    'critic_reviewing_code',
    'trace_testing',
    'fix_loop_iteration',
    'ci_running',
    'completed',
    'completed_partial',
    'failed',
    'cancelled'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "pipelines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "stage" "pipeline_stage" NOT NULL DEFAULT 'scribe_clarifying',
  "title" text,
  "scribe_conversation" jsonb DEFAULT '[]'::jsonb,
  "scribe_output" jsonb,
  "approved_spec" jsonb,
  "proto_output" jsonb,
  "trace_output" jsonb,
  "trace_enabled" boolean DEFAULT false NOT NULL,
  "repo_context" jsonb,
  "proto_config" jsonb,
  "jira_config" jsonb,
  "metrics" jsonb DEFAULT '{}'::jsonb,
  "error" jsonb,
  "intermediate_state" jsonb,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "stage_version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_pipelines_user_id" ON "pipelines" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_pipelines_stage" ON "pipelines" ("stage");
CREATE INDEX IF NOT EXISTS "idx_pipelines_user_created" ON "pipelines" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_pipelines_stage_updated" ON "pipelines" ("stage", "updated_at");
