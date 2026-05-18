/**
 * Pipeline table Drizzle schema definition.
 * Standalone file — will be integrated into backend/src/db/schema.ts in Phase 7.
 *
 * For now, used as reference and imported by the orchestrator for type safety.
 */

export const PIPELINE_TABLE_SQL = `
CREATE TYPE pipeline_stage AS ENUM (
  'scribe_clarifying', 'scribe_generating', 'critic_reviewing_spec',
  'awaiting_approval', 'proto_building', 'critic_reviewing_code',
  'awaiting_critic_resolution', -- P8: critic hard-block
  'awaiting_push_confirm', -- PDP-3 B4
  'trace_testing', 'fix_loop_iteration', 'ci_running',
  'completed', 'completed_partial', 'failed', 'cancelled'
);

CREATE TABLE pipelines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  stage pipeline_stage NOT NULL DEFAULT 'scribe_generating',
  title TEXT,
  scribe_conversation JSONB DEFAULT '[]',
  scribe_output JSONB,
  approved_spec JSONB,
  proto_output JSONB,
  trace_output JSONB,
  trace_enabled BOOLEAN NOT NULL DEFAULT false,
  auto_approve_enabled BOOLEAN NOT NULL DEFAULT false,
  auto_approve_threshold INTEGER NOT NULL DEFAULT 85,
  repo_context JSONB,
  proto_config JSONB,
  jira_config JSONB,
  metrics JSONB DEFAULT '{}',
  error JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pipelines_user_id ON pipelines(user_id);
CREATE INDEX idx_pipelines_stage ON pipelines(stage);
`;
