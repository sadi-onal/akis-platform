-- Issue #439: chat-level RAG — retrieval anchors per chat.
--
-- `chat_retrieval_anchors` records which knowledge chunks have already been
-- surfaced to a particular chat (= root pipeline id + its iteration children).
-- `KnowledgeRetrievalService.retrieveWithAnchors` reads this table before
-- retrieval so subsequent chat messages don't re-surface chunks the user has
-- already seen, and it writes fresh hits back so the next message's retrieval
-- can dedupe.
--
-- The anchor set is bounded per chat by a runtime "window size" (default 10
-- messages); old entries are intentionally NOT hard-deleted here — the
-- service trims on read so we keep the history for analytics / citation
-- transparency (#439 follow-up: UI chip per message).

CREATE TABLE IF NOT EXISTS chat_retrieval_anchors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL,
  chunk_id uuid NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  message_index integer NOT NULL,
  score real NOT NULL,
  retrieval_method varchar(20) NOT NULL,
  surfaced_content_hash varchar(64),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_retrieval_anchors_chat
  ON chat_retrieval_anchors(chat_id, message_index DESC);

CREATE INDEX IF NOT EXISTS idx_chat_retrieval_anchors_chunk
  ON chat_retrieval_anchors(chunk_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_retrieval_anchors_unique
  ON chat_retrieval_anchors(chat_id, chunk_id);
