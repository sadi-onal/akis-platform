/**
 * Migration: Add Level 3 pipeline stages to the pipeline_stage enum.
 * Run this before deploying Level 3 features.
 */
export const LEVEL3_STAGES_MIGRATION = `
-- Add Level 3 pipeline stages
ALTER TYPE pipeline_stage ADD VALUE IF NOT EXISTS 'critic_reviewing_spec' AFTER 'scribe_generating';
ALTER TYPE pipeline_stage ADD VALUE IF NOT EXISTS 'critic_reviewing_code' AFTER 'proto_building';
ALTER TYPE pipeline_stage ADD VALUE IF NOT EXISTS 'fix_loop_iteration' AFTER 'trace_testing';
`;
