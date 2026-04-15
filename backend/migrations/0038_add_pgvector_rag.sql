-- RAG System: pgvector extension + embedding column migration
-- Enables vector similarity search for knowledge retrieval

-- Step 1: Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Step 2: Add project_id column to knowledge_documents (if not exists)
DO $$ BEGIN
  ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS project_id UUID;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_project ON knowledge_documents (project_id);

-- Step 3: Convert embedding column from TEXT to VECTOR(1536)
-- Drop old text column and add vector column
DO $$ BEGIN
  -- Only alter if column exists and is text type
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'knowledge_chunks'
    AND column_name = 'embedding'
    AND data_type = 'text'
  ) THEN
    ALTER TABLE knowledge_chunks DROP COLUMN embedding;
    ALTER TABLE knowledge_chunks ADD COLUMN embedding vector(384);
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'knowledge_chunks'
    AND column_name = 'embedding'
  ) THEN
    ALTER TABLE knowledge_chunks ADD COLUMN embedding vector(384);
  END IF;
END $$;

-- Step 4: Create HNSW index for cosine similarity search
-- m=16, ef_construction=64 — good balance of speed and recall
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding
ON knowledge_chunks
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
