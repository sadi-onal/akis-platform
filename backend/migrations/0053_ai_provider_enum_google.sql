-- P12: add `google` to ai_provider enum.
--
-- Backend runtime (AIService, modelAllowlist) already supports Google Gemini
-- via P1c (#552), and AIKeyProvider/RuntimeAIProvider distinguish runtime
-- ("anthropic" | "openai" | "google") from the user-key column. With this
-- migration the DB enum catches up so users can persist 'google' in
-- `users.active_ai_provider` and `user_ai_keys.provider`.
--
-- Without this migration, the Settings UI cannot mark Gemini as the active
-- provider — the INSERT/UPDATE is rejected by the enum check.
--
-- ALTER TYPE ADD VALUE cannot run inside a transaction block, so we use the
-- DO block / EXCEPTION pattern from 0049/0052.

DO $$ BEGIN
  ALTER TYPE ai_provider ADD VALUE IF NOT EXISTS 'google';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
