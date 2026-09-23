import { Router, type Request, type Response } from "express";
import { mapKnowledgeDocumentToHelpArticle } from "../lib/mappers.js";
import { db } from "../lib/supabase.js";
import { asyncRoute } from "../middleware/error-handler.js";

const router = Router();

/**
 * Customer-facing Help Centre — every published knowledge_documents row,
 * shaped for resolv-hq-customer's HelpArticle (see lib/mappers.ts). Draft
 * and archived documents are admin-only (see routes/admin/knowledge.ts).
 */
router.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const { data, error } = await db
      .from("knowledge_documents")
      .select("*")
      .eq("status", "published")
      .order("created_at", { ascending: false });
    if (error) throw error;

    const categoryIds = Array.from(
      new Set((data ?? []).map((d) => d.category_id).filter((id): id is string => Boolean(id))),
    );
    const categoryNameById = new Map<string, string>();
    if (categoryIds.length > 0) {
      const { data: categories } = await db
        .from("knowledge_categories")
        .select("id, name")
        .in("id", categoryIds);
      for (const c of categories ?? []) categoryNameById.set(c.id, c.name);
    }

    res.json(
      (data ?? []).map((row) =>
        mapKnowledgeDocumentToHelpArticle(row, row.category_id ? categoryNameById.get(row.category_id) ?? null : null),
      ),
    );
  }),
);

export default router;
