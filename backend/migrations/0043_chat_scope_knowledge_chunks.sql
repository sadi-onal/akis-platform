-- Issue #463: chat-scoped knowledge ingestion.
--
-- Adds a nullable `chat_id` column to `knowledge_chunks` so uploaded documents
-- can be scoped to a single chat session. Existing rows have no chat affiliation
-- (workspace-scope or pipeline-scope) and keep NULL — their retrieval path is
-- unchanged. New rows inserted via POST /api/chats/:chatId/attach carry the chat
-- id and are **only** returned when retrieval explicitly filters by that chat id.
--
-- Idempotency: all statements use IF NOT EXISTS / IF EXISTS guards so re-running
-- the migration on a DB that already has the column is a no-op.

-- UP -------------------------------------------------------------------------

-- 1. knowledge_documents: add chat_id column
ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS chat_id uuid NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_chat
  ON knowledge_documents(chat_id)
  WHERE chat_id IS NOT NULL;

-- 2. knowledge_chunks: add chat_id column for direct filtering without JOIN
ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS chat_id uuid NULL;

-- Composite index for the chat-scoped retrieval query pattern:
--   WHERE chat_id = ? ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_chat_id
  ON knowledge_chunks(chat_id, created_at DESC)
  WHERE chat_id IS NOT NULL;

-- FK to pipelines (the "chat" in AKIS is the root pipeline).
-- DEFERRABLE INITIALLY DEFERRED so bulk inserts inside a transaction don't
-- require pipelines to be committed first.  ON DELETE CASCADE cleans up when
-- the pipeline is hard-deleted.
--
-- Using DO $$ ... $$ to skip gracefully if constraint already exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_knowledge_chunks_chat_id'
      AND conrelid = 'knowledge_chunks'::regclass
  ) THEN
    ALTER TABLE knowledge_chunks
      ADD CONSTRAINT fk_knowledge_chunks_chat_id
      FOREIGN KEY (chat_id) REFERENCES pipelines(id)
      ON DELETE CASCADE
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_knowledge_documents_chat_id'
      AND conrelid = 'knowledge_documents'::regclass
  ) THEN
    ALTER TABLE knowledge_documents
      ADD CONSTRAINT fk_knowledge_documents_chat_id
      FOREIGN KEY (chat_id) REFERENCES pipelines(id)
      ON DELETE CASCADE
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

-- DOWN -----------------------------------------------------------------------
-- To roll back: remove constraints, indexes, and columns.
--
-- ALTER TABLE knowledge_chunks DROP CONSTRAINT IF EXISTS fk_knowledge_chunks_chat_id;
-- DROP INDEX IF EXISTS idx_knowledge_chunks_chat_id;
-- ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS chat_id;
-- ALTER TABLE knowledge_documents DROP CONSTRAINT IF EXISTS fk_knowledge_documents_chat_id;
-- DROP INDEX IF EXISTS idx_knowledge_documents_chat;
-- ALTER TABLE knowledge_documents DROP COLUMN IF EXISTS chat_id;
