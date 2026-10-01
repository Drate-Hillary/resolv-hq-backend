// Turns an uploaded knowledge document into page-aware passages the agent
// can retrieve from. Before this existed, a PDF was stored as a file with no
// text (`content` is null), so the agent could never "read" it — only small
// plain-text uploads were searchable. Now every document is split page by
// page into short passages (knowledge_chunks), each remembering its page, so
// the agent can answer from the relevant passage and point at the page
// instead of dumping the whole document.
import { extractText, getDocumentProxy } from "unpdf";
import { prisma } from "./prisma.js";
import { downloadKnowledgeFile } from "./knowledge-storage.js";

const TARGET_CHUNK_CHARS = 700;
const MAX_CHUNK_CHARS = 1100;

export interface PageText {
  page: number;
  text: string;
}

export function isPdf(mimeType: string | null | undefined, name = ""): boolean {
  return mimeType === "application/pdf" || /\.pdf$/i.test(name);
}

function isPlainText(mimeType: string | null | undefined, name = ""): boolean {
  return Boolean(mimeType?.startsWith("text/")) || /\.(txt|md|markdown|csv)$/i.test(name);
}

/** Whether we can pull text out of this kind of file (PDFs and plain text). */
export function isIndexable(mimeType: string | null | undefined, name = ""): boolean {
  return isPdf(mimeType, name) || isPlainText(mimeType, name);
}

/** Per-page text for a PDF; plain text is paged on form feeds / ~3000-character blocks. */
export async function extractPages(buffer: Buffer, mimeType: string | null, name = ""): Promise<PageText[]> {
  if (isPdf(mimeType, name)) {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: false });
    return text.map((t, i) => ({ page: i + 1, text: t })).filter((p) => p.text.trim().length > 0);
  }

  if (isPlainText(mimeType, name)) {
    const raw = buffer.toString("utf-8");
    const blocks = raw.includes("\f") ? raw.split("\f") : splitEvery(raw, 3000);
    return blocks.map((t, i) => ({ page: i + 1, text: t })).filter((p) => p.text.trim().length > 0);
  }

  return [];
}

function splitEvery(text: string, size: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const para of text.split(/\n\s*\n/)) {
    if (current.length + para.length > size && current) {
      out.push(current);
      current = "";
    }
    current += `${para}\n\n`;
  }
  if (current.trim()) out.push(current);
  return out;
}

/** Collapses whitespace but keeps sentence boundaries so passages read naturally. */
function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Splits one page into ~700-character passages on sentence boundaries. */
export function chunkPage(text: string): string[] {
  const flat = normalise(text);
  if (flat.length <= MAX_CHUNK_CHARS) return flat ? [flat] : [];

  const sentences = flat.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [flat];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > TARGET_CHUNK_CHARS) {
      chunks.push(current.trim());
      current = "";
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** Replaces the document's passages. Returns how many were stored. */
export async function indexPages(documentId: string, pages: PageText[]): Promise<number> {
  const rows: { document_id: string; content: string; chunk_index: number; metadata: { page: number } }[] = [];
  for (const { page, text } of pages) {
    for (const content of chunkPage(text)) {
      rows.push({ document_id: documentId, content, chunk_index: rows.length, metadata: { page } });
    }
  }

  await prisma.$transaction([
    prisma.knowledge_chunks.deleteMany({ where: { document_id: documentId } }),
    prisma.knowledge_chunks.createMany({ data: rows }),
  ]);
  return rows.length;
}

/** Re-reads a document's stored file and rebuilds its passages (used for backfill and the staff "re-index" action). */
export async function reindexDocument(documentId: string): Promise<{ pages: number; chunks: number }> {
  const doc = await prisma.knowledge_documents.findUnique({
    where: { id: documentId },
    select: { file_url: true, file_type: true, title: true, content: true },
  });
  if (!doc) throw new Error("Document not found");

  let pages: PageText[] = [];
  if (doc.file_url) {
    const buffer = await downloadKnowledgeFile(doc.file_url);
    pages = await extractPages(buffer, doc.file_type, doc.file_url);
  } else if (doc.content) {
    pages = [{ page: 1, text: doc.content }];
  }

  const chunks = await indexPages(documentId, pages);
  return { pages: pages.length, chunks };
}

/** One page-tagged passage the agent can retrieve and quote from. */
export interface KnowledgePassage {
  id: string; // the owning document's id (what sources link back to)
  title: string;
  content: string;
  page?: number;
}

/**
 * Every published document as passages, ready for the agent's retrieval. A
 * document with no indexed passages but some inline text (older uploads)
 * falls back to being chunked on the fly, so nothing published is invisible.
 */
export async function loadPublishedPassages(): Promise<KnowledgePassage[]> {
  const docs = await prisma.knowledge_documents.findMany({
    where: { status: "published" },
    select: {
      id: true,
      title: true,
      content: true,
      knowledge_chunks: { select: { content: true, metadata: true }, orderBy: { chunk_index: "asc" } },
    },
  });

  const passages: KnowledgePassage[] = [];
  for (const doc of docs) {
    if (doc.knowledge_chunks.length > 0) {
      for (const chunk of doc.knowledge_chunks) {
        const page = (chunk.metadata as { page?: number } | null)?.page;
        passages.push({ id: doc.id, title: doc.title, content: chunk.content, page });
      }
    } else if (doc.content) {
      for (const content of chunkPage(doc.content)) passages.push({ id: doc.id, title: doc.title, content });
    }
  }
  return passages;
}
