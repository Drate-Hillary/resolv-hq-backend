import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "./supabase.js";

/**
 * Private bucket for files customers/staff attach to requests. Like the
 * knowledge bucket, only this service touches it; clients get short-lived
 * signed URLs, never a public link.
 */
export const ATTACHMENTS_BUCKET = process.env.ATTACHMENTS_STORAGE_BUCKET ?? "request-attachments";

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/** Images, PDFs, plain text/CSV and common Office formats. Anything else is refused. */
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
};

/**
 * Clients (React Native, some browsers, Windows) often send PDFs and Word files as
 * application/octet-stream or with no type at all, so fall back to the file extension.
 */
export function resolveMimeType(mimeType: string | undefined, fileName: string): string {
  if (mimeType && mimeType !== "application/octet-stream") return mimeType;
  return MIME_BY_EXTENSION[fileName.split(".").pop()?.toLowerCase() ?? ""] ?? mimeType ?? "application/octet-stream";
}

export function isAllowedAttachmentType(mimeType: string): boolean {
  return mimeType.startsWith("image/") || ALLOWED_TYPES.has(mimeType);
}

let bucketReady: Promise<void> | null = null;

/** Creates the bucket on first use, so there's no manual Supabase setup step. */
function ensureBucket(): Promise<void> {
  bucketReady ??= (async () => {
    const { data } = await supabaseAdmin.storage.getBucket(ATTACHMENTS_BUCKET);
    if (data) return;
    const { error } = await supabaseAdmin.storage.createBucket(ATTACHMENTS_BUCKET, {
      public: false,
      fileSizeLimit: MAX_ATTACHMENT_BYTES,
    });
    // A concurrent first upload may have created it between the check and now.
    if (error && !/already exists/i.test(error.message)) throw error;
  })().catch((err) => {
    bucketReady = null; // retry on the next upload instead of caching the failure
    throw err;
  });
  return bucketReady;
}

/** Stores the bytes and returns the storage path kept in request_attachments.storage_path. */
export async function uploadAttachmentFile(
  requestId: string,
  buffer: Buffer,
  originalName: string,
  mimeType: string,
): Promise<string> {
  await ensureBucket();
  const safeName = originalName.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  const path = `${requestId}/${randomUUID()}-${safeName}`;

  const { error } = await supabaseAdmin.storage.from(ATTACHMENTS_BUCKET).upload(path, buffer, {
    contentType: mimeType,
    upsert: false,
  });
  if (error) throw error;
  return path;
}

/** Short-lived URL for previewing or downloading an attachment. */
export async function getAttachmentSignedUrl(path: string, expiresInSeconds = 3600): Promise<string> {
  const { data, error } = await supabaseAdmin.storage.from(ATTACHMENTS_BUCKET).createSignedUrl(path, expiresInSeconds);
  if (error || !data) throw error ?? new Error("Could not create a signed URL");
  return data.signedUrl;
}
