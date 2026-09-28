import { Router, type Request, type Response } from "express";
import { mapKnowledgeDocumentToHelpArticle } from "../lib/mappers.js";
import { prisma } from "../lib/prisma.js";
import { asyncRoute } from "../middleware/error-handler.js";
import type { KnowledgeDocumentRow } from "../types/database.types.js";

const router = Router();

/**
 * Customer-facing Help Centre — every published knowledge_documents row,
 * shaped for resolv-hq-customer's HelpArticle (see lib/mappers.ts). Draft
 * and archived documents are admin-only (see routes/admin/knowledge.ts).
 */
router.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const data = (await prisma.knowledge_documents.findMany({
      where: { status: "published" },
      orderBy: { created_at: "desc" },
    })) as unknown as KnowledgeDocumentRow[];

    const categoryIds = Array.from(
      new Set(data.map((d) => d.category_id).filter((id): id is string => Boolean(id))),
    );
    const categoryNameById = new Map<string, string>();
    if (categoryIds.length > 0) {
      const categories = await prisma.knowledge_categories.findMany({
        where: { id: { in: categoryIds } },
        select: { id: true, name: true },
      });
      for (const c of categories) categoryNameById.set(c.id, c.name);
    }

    res.json(
      data.map((row) =>
        mapKnowledgeDocumentToHelpArticle(row, row.category_id ? categoryNameById.get(row.category_id) ?? null : null),
      ),
    );
  }),
);

export default router;
