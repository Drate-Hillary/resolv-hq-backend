import type { Request, Response } from "express";
import { Router } from "express";
import { requireRole } from "../../lib/auth.js";
import { badRequest } from "../../lib/errors.js";
import { db } from "../../lib/supabase.js";
import { asyncRoute } from "../../middleware/error-handler.js";
import type { KnowledgeStatus } from "../../types/database.types.js";

const router = Router();
router.use(requireRole("staff"));

router.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const { data, error } = await db.from("knowledge_documents").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data ?? []);
  }),
);

/**
 * Mirrors the source app's knowledge-view upload flow: insert the document
 * as "draft", then flip it to "published" shortly after, simulating an
 * async indexing step. That flip runs after the response is sent — there's
 * no request left to attach it to.
 */
router.post(
  "/",
  asyncRoute(async (req: Request, res: Response) => {
    const {
      title,
      content = null,
      file_url = null,
      file_type = null,
      status = "draft",
    } = req.body as {
      title?: string;
      content?: string | null;
      file_url?: string | null;
      file_type?: string | null;
      status?: KnowledgeStatus;
    };
    if (!title) throw badRequest("title is required");

    const { data, error } = await db
      .from("knowledge_documents")
      .insert({ title, content, file_url, file_type, status, uploaded_by: req.user!.id })
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

export default router;
