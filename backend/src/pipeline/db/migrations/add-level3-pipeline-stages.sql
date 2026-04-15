-- Level 3 pipeline stages migration
-- Adds: critic_reviewing_spec, critic_reviewing_code, fix_loop_iteration

ALTER TYPE pipeline_stage ADD VALUE IF NOT EXISTS 'critic_reviewing_spec' AFTER 'scribe_generating';
ALTER TYPE pipeline_stage ADD VALUE IF NOT EXISTS 'critic_reviewing_code' AFTER 'proto_building';
ALTER TYPE pipeline_stage ADD VALUE IF NOT EXISTS 'fix_loop_iteration' AFTER 'trace_testing';
