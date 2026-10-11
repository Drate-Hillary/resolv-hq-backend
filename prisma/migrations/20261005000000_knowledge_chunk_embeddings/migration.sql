-- Fixes the embedding column to 1536 dimensions (OpenAI text-embedding-3-small)
-- so it can be indexed, and adds an HNSW cosine index for semantic retrieval.
-- The column was never populated before, so existing values are discarded.
UPDATE "knowledge_chunks" SET "embedding" = NULL;
ALTER TABLE "knowledge_chunks" ALTER COLUMN "embedding" TYPE vector(1536);
CREATE INDEX IF NOT EXISTS "knowledge_chunks_embedding_idx"
  ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);
