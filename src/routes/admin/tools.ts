import type { Request, Response } from "express";
import { Router } from "express";
import { requireRole } from "../../lib/auth.js";
import { notFound } from "../../lib/errors.js";
import { isNotFound } from "../../lib/prisma-errors.js";
import { prisma } from "../../lib/prisma.js";
import { asyncRoute } from "../../middleware/error-handler.js";

const router = Router();
router.use(requireRole("staff"));

router.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const data = await prisma.agent_tools.findMany({ orderBy: { name: "asc" } });
    res.json(data);
  }),
);

/** Ported from tools-view's `toggleStatus` — flips active/disabled. */
router.patch(
  "/:id/status",
  asyncRoute(async (req: Request, res: Response) => {
    const { id } = req.params;
    const current = await prisma.agent_tools.findUnique({ where: { id }, select: { is_active: true } });
    if (!current) throw notFound("Tool not found");

    const nextActive = !current.is_active;
    try {
      const data = await prisma.agent_tools.update({ where: { id }, data: { is_active: nextActive } });
      res.json(data);
    } catch (err) {
      if (isNotFound(err)) throw notFound("Tool not found");
      throw err;
    }
  }),
);

export default router;
