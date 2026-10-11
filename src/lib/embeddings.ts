// Semantic retrieval for the knowledge base. Passages (knowledge_chunks) get
// a vector embedding when they are indexed; at question time the query is
// embedded and the closest passages are found with pgvector. The result is
// attached to the keyword-ranked passages as `semanticScore` (see
// attachSemanticScores), so semantic and keyword search combine rather than
// one replacing the other — and with no OpenAI provider registered
// everything silently stays keyword-only.
import OpenAI from "openai";
import { prisma } from "./prisma.js";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
/** Below this cosine similarity a passage isn't treated as a semantic match. */
const MIN_SIMILARITY = 0.3;
const TOP_K = 8;
const BATCH_SIZE = 64;

/** An OpenAI client from the oldest active openai provider's key, or null if none is registered. */
async function embeddingClient(): Promise<OpenAI | null> {
  const row = await prisma.agent_providers.findFirst({
    where: { provider: "openai", status: "active" },
    select: { api_key: true },
    orderBy: { created_at: "asc" },
  });
  return row ? new OpenAI({ apiKey: row.api_key }) : null;
}

async function embedTexts(client: OpenAI, texts: string[]): Promise<number[][]> {
  const res = await client.embeddings.create({ model: EMBEDDING_MODEL, input: texts });
  return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

const toVectorLiteral = (v: number[]) => `[${v.join(",")}]`;

/**
 * Embeds every passage that has no embedding yet (of one document, or of all
 * documents when no id is given — the backfill). Returns how many were
 * embedded (0 when no OpenAI provider is available).
 */
export async function embedDocumentChunks(documentId?: string): Promise<number> {
  const client = await embeddingClient();
  if (!client) return 0;

  const pending = documentId
    ? await prisma.$queryRaw<{ id: string; content: string }[]>`
        SELECT id::text, content FROM knowledge_chunks WHERE embedding IS NULL AND document_id = ${documentId}::uuid`
    : await prisma.$queryRaw<{ id: string; content: string }[]>`
        SELECT id::text, content FROM knowledge_chunks WHERE embedding IS NULL`;

  let done = 0;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const vectors = await embedTexts(
      client,
      batch.map((c) => c.content),
    );
    for (let j = 0; j < batch.length; j++) {
      await prisma.$executeRaw`
        UPDATE knowledge_chunks SET embedding = ${toVectorLiteral(vectors[j])}::vector WHERE id = ${batch[j].id}::uuid`;
      done++;
    }
  }
  return done;
}

/** Closest published passages to the query by cosine similarity, or [] if semantic search is unavailable. */
export async function semanticSearch(query: string): Promise<{ chunkId: string; score: number }[]> {
  const client = await embeddingClient();
  if (!client) return [];

  const [vector] = await embedTexts(client, [query]);
  const literal = toVectorLiteral(vector);
  const rows = await prisma.$queryRaw<{ id: string; score: number }[]>`
    SELECT c.id::text AS id, 1 - (c.embedding <=> ${literal}::vector) AS score
    FROM knowledge_chunks c
    JOIN knowledge_documents d ON d.id = c.document_id
    WHERE c.embedding IS NOT NULL AND d.status = 'published'
    ORDER BY c.embedding <=> ${literal}::vector
    LIMIT ${TOP_K}`;
  return rows.filter((r) => r.score >= MIN_SIMILARITY).map((r) => ({ chunkId: r.id, score: Number(r.score) }));
}

/**
 * Tags the passages that semantically match the query with a `semanticScore`.
 * Never throws: any failure (no key, rate limit, column not migrated yet)
 * just returns the passages untouched, i.e. keyword-only retrieval.
 */
export async function attachSemanticScores<T extends { chunkId?: string; semanticScore?: number }>(
  query: string,
  passages: T[],
): Promise<T[]> {
  try {
    const hits = new Map((await semanticSearch(query)).map((h) => [h.chunkId, h.score]));
    if (hits.size === 0) return passages;
    return passages.map((p) => (p.chunkId && hits.has(p.chunkId) ? { ...p, semanticScore: hits.get(p.chunkId) } : p));
  } catch (err) {
    console.error("Semantic search failed, using keyword retrieval only:", err);
    return passages;
  }
}
