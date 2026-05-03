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
-- IMPORTANT — production enum currently is ('openai', 'openrouter'). 'anthropic'
-- is NOT a valid value yet. So we cannot UPDATE users to 'anthropic' before the
-- type change. The openrouter→anthropic mapping happens INLINE in the cast's
-- USING clause when the column is retyped to the new enum.
--
-- The enum migration uses the create-new-name → cast-with-mapping → drop-old →
-- rename pattern so the rebuild works inside a single transaction (Postgres
-- can't drop+recreate a type with the same name in one transaction without
-- breaking column references).

-- UP -------------------------------------------------------------------------

-- 1) Non-enum cleanup first (independent of the type change).
--
--    NULL out openrouter-format model strings on pipelines (e.g.
--    'anthropic/claude-3.5-haiku'). Orchestrator falls back to the system
--    default (claude-haiku-4-5-20251001) when model IS NULL.
UPDATE pipelines
   SET model = NULL
 WHERE model IS NOT NULL AND model LIKE '%/%';

-- 2) Delete stored OpenRouter API keys. There is no soft-delete column and
--    leaving them in place would resolve to a no-longer-supported provider
--    when the user's activeAiProvider was migrated below.
DELETE FROM user_ai_keys
 WHERE provider = 'openrouter';

-- 3) Drop the column default before the type change. Current default is
--    'openrouter'::ai_provider which won't be valid against the new enum.
ALTER TABLE users
  ALTER COLUMN active_ai_provider DROP DEFAULT;

-- 4) Replace the enum without DROP+CREATE on the same name. Two reasons we
--    do the mapping inline rather than UPDATE-then-cast:
--
--    (a) Postgres allows DROP TYPE → CREATE TYPE x in a single transaction,
--        but the intermediate ALTER TABLE ... TYPE x USING ...::x cast picks
--        up the half-replaced type and crashes with "invalid input value for
--        enum x". The rename pattern (v2 → cast → drop v1 → rename v2)
--        sidesteps that.
--
--    (b) Production enum currently is ('openai', 'openrouter'). 'anthropic'
--        is not yet a valid value, so we CAN'T `UPDATE users SET active_ai_provider
--        = 'anthropic'` before the type change — the UPDATE itself would
--        fail. Instead we cast openrouter → anthropic inline.
CREATE TYPE ai_provider_v2 AS ENUM ('anthropic', 'openai');

ALTER TABLE users
  ALTER COLUMN active_ai_provider TYPE ai_provider_v2
  USING (
    CASE
      WHEN active_ai_provider IS NULL                 THEN NULL
      WHEN active_ai_provider::text = 'openrouter'    THEN 'anthropic'::ai_provider_v2
      WHEN active_ai_provider::text = 'openai'        THEN 'openai'::ai_provider_v2
      ELSE 'anthropic'::ai_provider_v2  -- defensive: anything unexpected → anthropic
    END
  );

DROP TYPE ai_provider;

ALTER TYPE ai_provider_v2 RENAME TO ai_provider;

-- 5) Set new default for future inserts.
ALTER TABLE users
  ALTER COLUMN active_ai_provider SET DEFAULT 'anthropic';

-- 6) Per-pipeline model lock column (Commit 5 of PR-A enforces it in the
--    orchestrator). NULL = unlocked, settable once. timestamptz stamped on
--    pipeline creation by startPipeline().
ALTER TABLE pipelines
  ADD COLUMN IF NOT EXISTS model_locked_at timestamp with time zone;
