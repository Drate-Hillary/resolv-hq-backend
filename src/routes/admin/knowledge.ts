import path from "node:path";
import type { Request, Response } from "express";
import { Router } from "express";
import multer from "multer";
import { requireRole } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { deleteKnowledgeFile, getKnowledgeFileSignedUrl, uploadKnowledgeFile } from "../../lib/knowledge-storage.js";
import { db } from "../../lib/supabase.js";
import { asyncRoute } from "../../middleware/error-handler.js";
import type { KnowledgeStatus } from "../../types/database.types.js";

const router = Router();
router.use(requireRole("staff"));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const KNOWLEDGE_STATUSES: KnowledgeStatus[] = ["draft", "published", "archived"];

// Small text files are stored inline as `content` so the detail sheet has
// something to preview; anything larger (or non-text) is left to the file
// itself, fetched on demand via GET /:id/download.
const INLINE_TEXT_MAX_BYTES = 200_000;

router.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const { data, error } = await db.from("knowledge_documents").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data ?? []);
  }),
);

/**
 * Accepts a `file` upload (multipart/form-data) and creates the document as
 * "draft", then flips it to "published" shortly after, simulating an async
 * indexing step. That flip runs after the response is sent — there's no
 * request left to attach it to.
 */
router.post(
  "/",
  upload.single("file"),
  asyncRoute(async (req: Request, res: Response) => {
    const {
      title: titleInput,
      status = "draft",
      category_id: categoryIdInput,
    } = req.body as { title?: string; status?: KnowledgeStatus; category_id?: string };
    const file = req.file;

    if (!file && !titleInput) throw badRequest("A file or a title is required");

    const title = titleInput?.trim() || (file ? path.parse(file.originalname).name : "");
    if (!title) throw badRequest("title is required");

    // multipart fields arrive as strings, so an unset <select> shows up as "".
    const category_id = categoryIdInput?.trim() ? categoryIdInput.trim() : null;

    let file_url: string | null = null;
    let file_type: string | null = null;
    let content: string | null = null;

    if (file) {
      file_url = await uploadKnowledgeFile(file.buffer, file.originalname, file.mimetype);
      file_type = file.mimetype;
      if (file.mimetype.startsWith("text/") && file.size <= INLINE_TEXT_MAX_BYTES) {
        content = file.buffer.toString("utf-8");
      }
    }

    const { data, error } = await db
      .from("knowledge_documents")
      .insert({ title, content, file_url, file_type, status, category_id, uploaded_by: req.user!.id })
      .select("*")
      .single();
    if (error || !data) throw error ?? badRequest("Failed to create document");

    res.json(data);

    setTimeout(() => {
      db.from("knowledge_documents")
        .update({ status: "published" })
        .eq("id", data.id)
        .then(({ error: updateError }) => {
          if (updateError) console.error("knowledge indexing update failed:", updateError);
        });
    }, 1800);
  }),
);

/** Renames a document and/or moves it between draft/published/archived. */
router.patch(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    const { status, title, category_id } = req.body as {
      status?: KnowledgeStatus;
      title?: string;
      category_id?: string | null;
    };
    if (status === undefined && title === undefined && category_id === undefined) {
      throw badRequest("Nothing to update");
    }
    if (status !== undefined && !KNOWLEDGE_STATUSES.includes(status)) throw badRequest("Invalid status");

    const update: { status?: KnowledgeStatus; title?: string; category_id?: string | null } = {};
    if (status !== undefined) update.status = status;
    if (category_id !== undefined) update.category_id = category_id;
    if (title !== undefined) {
      if (!title.trim()) throw badRequest("title cannot be empty");
      update.title = title.trim();
    }

    const { data, error } = await db
      .from("knowledge_documents")
      .update(update)
      .eq("id", req.params.id)
      .select("*")
      .single();
    if (error || !data) throw notFound("Document not found");

    res.json(data);
  }),
);

/** A short-lived signed URL for viewing/downloading the document's file. */
router.get(
  "/:id/download",
  asyncRoute(async (req: Request, res: Response) => {
    const { data, error } = await db
      .from("knowledge_documents")
      .select("file_url")
      .eq("id", req.params.id)
      .single();
    if (error || !data) throw notFound("Document not found");
    if (!data.file_url) throw badRequest("This document has no uploaded file");

    const url = await getKnowledgeFileSignedUrl(data.file_url);
    res.json({ url });
  }),
);

router.delete(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    const { data, error } = await db
      .from("knowledge_documents")
      .select("file_url")
      .eq("id", req.params.id)
      .single();
    if (error || !data) throw notFound("Document not found");

    await db.from("knowledge_chunks").delete().eq("document_id", req.params.id);

    const { error: deleteError } = await db.from("knowledge_documents").delete().eq("id", req.params.id);
    if (deleteError) throw deleteError;

    if (data.file_url) {
      await deleteKnowledgeFile(data.file_url).catch((err) => console.error("knowledge file delete failed:", err));
    }

    res.status(204).end();
  }),
);

export default router;
