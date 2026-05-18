-- P8: add `awaiting_critic_resolution` to pipeline_stage enum.
--
-- New pipeline stage that hard-blocks the flow when CriticAgent's code review
-- comes back below CRITIC_APPROVAL_THRESHOLD (default 75). The orchestrator
-- stops before Trace + GitHub push; the user picks between:
--   1. Düzelt (chat input → POST /:id/iterate-with-feedback) — re-runs Proto
--      with the user's correction prepended to the prompt.
--   2. Yine de devam et (POST /:id/critic-override) — accepts the findings
--      and advances to `awaiting_push_confirm` so the existing push flow
--      can finish the commit.
--
-- Backward compat: completed pipelines stay completed; this migration only
-- extends the enum, no rows are touched. In-flight pipelines that have not
-- yet reached the critic-code stage continue using their current path.
--
-- ALTER TYPE ADD VALUE cannot run inside a transaction block, so we use the
-- DO block / EXCEPTION pattern from 0049_pipeline_awaiting_push_confirm_stage.sql.

DO $$ BEGIN
  ALTER TYPE pipeline_stage ADD VALUE IF NOT EXISTS 'awaiting_critic_resolution';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
