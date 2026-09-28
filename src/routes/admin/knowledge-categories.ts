import type { Request, Response } from "express";
import { Router } from "express";
import { requireRole } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { isNotFound, isUniqueViolation } from "../../lib/prisma-errors.js";
import { prisma } from "../../lib/prisma.js";
import { asyncRoute } from "../../middleware/error-handler.js";

const router = Router();
router.use(requireRole("staff"));

router.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const data = await prisma.knowledge_categories.findMany({ orderBy: { name: "asc" } });
    res.json(data);
  }),
);

router.post(
  "/",
  asyncRoute(async (req: Request, res: Response) => {
    const { name, description = null } = req.body as { name?: string; description?: string | null };
    if (!name?.trim()) throw badRequest("name is required");

    let data;
    try {
      data = await prisma.knowledge_categories.create({ data: { name: name.trim(), description } });
    } catch (err) {
      if (isUniqueViolation(err)) throw badRequest("A category with that name already exists");
      throw err;
    }

    res.json(data);
  }),
);

router.patch(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    const { name, description } = req.body as { name?: string; description?: string | null };
    if (name === undefined && description === undefined) throw badRequest("Nothing to update");
    if (name !== undefined && !name.trim()) throw badRequest("name cannot be empty");

    const update: { name?: string; description?: string | null } = {};
    if (name !== undefined) update.name = name.trim();
    if (description !== undefined) update.description = description;

    let data;
    try {
      data = await prisma.knowledge_categories.update({ where: { id: req.params.id }, data: update });
    } catch (err) {
      if (isNotFound(err)) throw notFound("Category not found");
      throw err;
    }

    res.json(data);
  }),
);

// knowledge_documents.category_id is ON DELETE SET NULL, so documents in
// this category are simply uncategorized afterward, not deleted.
router.delete(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    const { count } = await prisma.knowledge_categories.deleteMany({ where: { id: req.params.id } });
    if (!count) throw notFound("Category not found");

    res.status(204).end();
  }),
);

export default router;
