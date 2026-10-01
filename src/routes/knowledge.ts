import type { Request, Response } from "express";
import { Router } from "express";
import { badRequest, notFound } from "../lib/errors.js";
import { getKnowledgeFileSignedUrl } from "../lib/knowledge-storage.js";
import { prisma } from "../lib/prisma.js";
import { asyncRoute } from "../middleware/error-handler.js";

const router = Router();

/**
 * A short-lived signed URL to view a knowledge document's original file
 * (PDF etc.). Customers can open anything that's published — the same set
 * the Help Centre and the assistant's answers draw from — while staff can
 * open drafts and archived documents too. The bucket itself stays private;
 * only this route hands out links, and they expire.
 */
router.get(
  "/:id/file",
  asyncRoute(async (req: Request, res: Response) => {
    const staff = req.user!.role === "admin" || req.user!.role === "agent";
    const doc = await prisma.knowledge_documents.findUnique({
      where: { id: req.params.id },
      select: { title: true, file_url: true, file_type: true, status: true },
    });
    if (!doc || (!staff && doc.status !== "published")) throw notFound("Document not found");
    if (!doc.file_url) throw badRequest("This document has no file to view");

    res.json({
      url: await getKnowledgeFileSignedUrl(doc.file_url, 3600),
      title: doc.title,
      fileType: doc.file_type,
    });
  }),
);

export default router;
