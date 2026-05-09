-- F-10 / FR-11: Intent classification audit log.
--
-- Every user message classified by IntentClassifier is appended here so we
-- have an audit trail (which intent was assigned + at what confidence), a
-- dataset for future fine-tuning, and a record of any disambiguation override
-- the user picked when confidence was below the 0.7 threshold.
--
-- Privacy posture (mirrors NFR-1.3 + 03-architecture § 4.3):
--   * `message_hash` is SHA-256 of the raw message (hex) — never the prose.
--   * `reasoning` is a short classifier-emitted sentence (NOT the message).
--   * Cascade-delete on user removal; on pipeline delete we set the FK NULL
--     so the user's audit history survives the pipeline being purged.
--
-- Idempotent so re-runs on a partially-applied DB are safe:
--   * CREATE TABLE IF NOT EXISTS
--   * CREATE INDEX IF NOT EXISTS
--   * Foreign keys added inside DO blocks that check pg_constraint first

-- UP -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "intent_classifications" (
  "id"               bigserial PRIMARY KEY,
  "user_id"          uuid NOT NULL,
  "pipeline_id"      uuid,
  "message_hash"     text NOT NULL,
  "intent"           text NOT NULL,
  "confidence"       numeric(4,3) NOT NULL,
  "alternates"       jsonb,
  "override_intent"  text,
  "classified_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_intent_user_time"
  ON "intent_classifications" ("user_id", "classified_at" DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_intent_classifications_user_id'
      AND conrelid = 'intent_classifications'::regclass
  ) THEN
    ALTER TABLE "intent_classifications"
      ADD CONSTRAINT "fk_intent_classifications_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users" ("id")
      ON DELETE CASCADE
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_intent_classifications_pipeline_id'
      AND conrelid = 'intent_classifications'::regclass
  ) THEN
    ALTER TABLE "intent_classifications"
      ADD CONSTRAINT "fk_intent_classifications_pipeline_id"
      FOREIGN KEY ("pipeline_id") REFERENCES "pipelines" ("id")
      ON DELETE SET NULL
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

-- DOWN -----------------------------------------------------------------------
-- ALTER TABLE intent_classifications DROP CONSTRAINT IF EXISTS fk_intent_classifications_pipeline_id;
-- ALTER TABLE intent_classifications DROP CONSTRAINT IF EXISTS fk_intent_classifications_user_id;
-- DROP INDEX IF EXISTS idx_intent_user_time;
-- DROP TABLE IF EXISTS intent_classifications;
