import { Router, type Request, type Response } from "express";
import { notFound } from "../lib/errors.js";
import { getKnowledgeFileSignedUrl } from "../lib/knowledge-storage.js";
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

/**
 * Short-lived signed URL for the file behind a published article (e.g. a PDF
 * guide), so the app can open it. Draft/archived documents are not exposed.
 */
router.get(
  "/:id/file",
  asyncRoute(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const doc = await prisma.knowledge_documents.findFirst({
      where: { id, status: "published" },
      select: { title: true, file_url: true, file_type: true },
    });
    if (!doc?.file_url) throw notFound("This article has no attached file");

    const url = await getKnowledgeFileSignedUrl(doc.file_url);
    const ext = doc.file_url.includes(".") ? doc.file_url.split(".").pop() : null;
    res.json({
      url,
      fileName: ext && !doc.title.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? `${doc.title}.${ext}` : doc.title,
      fileType: doc.file_type,
    });
  }),
);

export default router;
