import { randomUUID } from "node:crypto";
import { db } from "./supabase.js";

/**
 * Private bucket (see migrations/0007_knowledge_documents_storage.sql) — only
 * the service-role client here ever touches it, so files are handed to the
 * admin UI as short-lived signed URLs, never a public one.
 */
export const KNOWLEDGE_BUCKET = process.env.KNOWLEDGE_STORAGE_BUCKET ?? "knowledge-documents";

/** Uploads a document's bytes and returns the storage path stored as `file_url`. */
export async function uploadKnowledgeFile(buffer: Buffer, originalName: string, mimeType: string): Promise<string> {
  const safeName = originalName.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  const path = `${randomUUID()}-${safeName}`;

  const { error } = await db.storage.from(KNOWLEDGE_BUCKET).upload(path, buffer, {
    contentType: mimeType,
    upsert: false,
  });
  if (error) throw error;

  return path;
}

/** Short-lived URL for viewing/downloading a previously uploaded file. */
export async function getKnowledgeFileSignedUrl(path: string, expiresInSeconds = 300): Promise<string> {
  const { data, error } = await db.storage.from(KNOWLEDGE_BUCKET).createSignedUrl(path, expiresInSeconds);
  if (error || !data) throw error ?? new Error("Could not create a signed URL");
  return data.signedUrl;
}

export async function deleteKnowledgeFile(path: string): Promise<void> {
  const { error } = await db.storage.from(KNOWLEDGE_BUCKET).remove([path]);
  if (error) throw error;
}
