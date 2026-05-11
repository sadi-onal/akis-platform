-- PDP-3 B4: add `awaiting_push_confirm` to pipeline_stage enum.
--
-- New pipeline stage that halts the flow between Proto's scaffold generation
-- and the GitHub push so the user can inspect the generated code via inline
-- Sandpack preview and explicitly confirm (or cancel) before any commit
-- lands on GitHub. The legacy "auto-push immediately after Proto" behaviour
-- is preserved behind the AUTO_PUSH_AFTER_PROTO=true env flag (default OFF).
--
-- Backward compat: completed pipelines stay completed; this migration only
-- extends the enum, no rows are touched. Existing in-flight pipelines that
-- have not yet reached Proto continue using their current path.
--
-- ALTER TYPE ADD VALUE cannot run inside a transaction block, so we use the
-- DO block / EXCEPTION pattern from 0021_add_atlassian_oauth.sql.

DO $$ BEGIN
  ALTER TYPE pipeline_stage ADD VALUE IF NOT EXISTS 'awaiting_push_confirm';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
