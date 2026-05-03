-- PR-A: drop OpenRouter as a supported provider + add per-pipeline model lock.
--
-- Two coupled changes shipped together:
--
-- 1) OpenRouter cleanup. We standardize on Anthropic (and OpenAI in PR-B). Any
--    user/pipeline pointing at openrouter today is migrated to a sane default
--    so the app keeps working after the enum value goes away. Stored OpenRouter
--    API keys are deleted because there's no `is_active` column to soft-disable
--    them and we don't want to silently route their traffic somewhere else.
--
-- 2) `pipelines.model_locked_at` column. From now on a pipeline's model is
--    chosen at creation and locked for the lifetime of the chat (Commit 5 in
--    PR-A wires the lock-check). Existing rows stay NULL → orchestrator allows
--    a one-time set on first interaction.
--
-- Idempotent: each statement is safe to re-run.

-- UP -------------------------------------------------------------------------

-- 1) Move users currently on openrouter to anthropic so the enum drop doesn't
--    leave them with an invalid value.
UPDATE users
   SET active_ai_provider = 'anthropic'
 WHERE active_ai_provider = 'openrouter';

-- 2) NULL out openrouter-format model strings on pipelines (e.g.
--    'anthropic/claude-3.5-haiku'). Orchestrator falls back to the system
--    default (claude-haiku-4-5-20251001) when model IS NULL.
UPDATE pipelines
   SET model = NULL
 WHERE model IS NOT NULL AND model LIKE '%/%';

-- 3) Delete stored OpenRouter API keys. There is no soft-delete column and
--    leaving them in place would resolve to a no-longer-supported provider
--    when the user's activeAiProvider was migrated above.
DELETE FROM user_ai_keys
 WHERE provider = 'openrouter';

-- 4) Detach the enum column → drop type → recreate without 'openrouter' →
--    recast. Postgres requires this dance because you can't ALTER an enum to
--    remove a value directly.
ALTER TABLE users
  ALTER COLUMN active_ai_provider DROP DEFAULT;

ALTER TABLE users
  ALTER COLUMN active_ai_provider TYPE text
  USING active_ai_provider::text;

DROP TYPE IF EXISTS ai_provider;

CREATE TYPE ai_provider AS ENUM ('anthropic', 'openai', 'openrouter');
-- Note: 'openrouter' temporarily kept in the type so the cast below succeeds
-- for any row that slipped through step 1 (race / concurrent insert). We
-- immediately drop it in the next statement after recasting + setting the
-- default to 'anthropic'.

ALTER TABLE users
  ALTER COLUMN active_ai_provider TYPE ai_provider
  USING active_ai_provider::ai_provider;

ALTER TABLE users
  ALTER COLUMN active_ai_provider SET DEFAULT 'anthropic';

-- Now actually purge openrouter from the enum by rebuilding without it.
ALTER TABLE users
  ALTER COLUMN active_ai_provider DROP DEFAULT;

ALTER TABLE users
  ALTER COLUMN active_ai_provider TYPE text
  USING active_ai_provider::text;

DROP TYPE IF EXISTS ai_provider;

CREATE TYPE ai_provider AS ENUM ('anthropic', 'openai');

-- Final cast — any lingering 'openrouter' string would fail here, but we
-- already migrated those rows in step 1.
ALTER TABLE users
  ALTER COLUMN active_ai_provider TYPE ai_provider
  USING active_ai_provider::ai_provider;

ALTER TABLE users
  ALTER COLUMN active_ai_provider SET DEFAULT 'anthropic';

-- 5) Per-pipeline model lock column (Commit 5 of PR-A enforces it in the
--    orchestrator). NULL = unlocked, settable once. timestamptz stamped on
--    pipeline creation by startPipeline().
ALTER TABLE pipelines
  ADD COLUMN IF NOT EXISTS model_locked_at timestamp with time zone;
