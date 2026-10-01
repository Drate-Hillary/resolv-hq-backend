// CRUD for boundary_rules — the data backing lib/ai-boundary.ts's structural
// backstop. This is what makes "no hardcoded values" real: every category,
// detection pattern, and fallback message lives here, editable without a
// code change or redeploy. invalidateBoundaryRulesCache() is called after
// every mutation so a change is picked up on the very next chat message.
import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { Router } from "express";
import { invalidateBoundaryRulesCache } from "../../lib/ai-boundary.js";
import { requireRole } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { isNotFound } from "../../lib/prisma-errors.js";
import { prisma } from "../../lib/prisma.js";
import { asyncRoute } from "../../middleware/error-handler.js";

const router = Router();
router.use(requireRole("staff"));

/** Rejects an invalid regex up front rather than letting it fail silently
 * (and get skipped) every time lib/ai-boundary.ts loads the rule set. */
function assertValidPattern(pattern: string) {
  try {
    new RegExp(pattern, "i");
  } catch {
    throw badRequest(`"${pattern}" is not a valid regular expression`);
  }
}

router.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const data = await prisma.boundary_rules.findMany({ orderBy: { created_at: "asc" } });
    res.json(data);
  }),
);

router.post(
  "/",
  asyncRoute(async (req: Request, res: Response) => {
    const { category, pattern, fallback_message, is_active } = req.body as {
      category?: string;
      pattern?: string;
      fallback_message?: string;
      is_active?: boolean;
    };
    if (!category?.trim()) throw badRequest("category is required");
    if (!pattern?.trim()) throw badRequest("pattern is required");
    if (!fallback_message?.trim()) throw badRequest("fallback_message is required");
    assertValidPattern(pattern);

    const insert: Prisma.boundary_rulesCreateInput = {
      category: category.trim(),
      pattern: pattern.trim(),
      fallback_message: fallback_message.trim(),
      is_active: is_active ?? true,
    };

    const data = await prisma.boundary_rules.create({ data: insert });

    invalidateBoundaryRulesCache();
    res.status(201).json(data);
  }),
);

router.patch(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    const { category, pattern, fallback_message, is_active } = req.body as {
      category?: string;
      pattern?: string;
      fallback_message?: string;
      is_active?: boolean;
    };

    const update: Prisma.boundary_rulesUpdateInput = {};
    if (category !== undefined) {
      if (!category.trim()) throw badRequest("category cannot be empty");
      update.category = category.trim();
    }
    if (pattern !== undefined) {
      if (!pattern.trim()) throw badRequest("pattern cannot be empty");
      assertValidPattern(pattern);
      update.pattern = pattern.trim();
    }
    if (fallback_message !== undefined) {
      if (!fallback_message.trim()) throw badRequest("fallback_message cannot be empty");
      update.fallback_message = fallback_message.trim();
    }
    if (is_active !== undefined) update.is_active = is_active;
    if (Object.keys(update).length === 0) throw badRequest("Nothing to update");
    update.updated_at = new Date();

    let data;
    try {
      data = await prisma.boundary_rules.update({ where: { id: req.params.id }, data: update });
    } catch (err) {
      if (isNotFound(err)) throw notFound("Rule not found");
      throw err;
    }

    invalidateBoundaryRulesCache();
    res.json(data);
  }),
);

router.delete(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    await prisma.boundary_rules.deleteMany({ where: { id: req.params.id } });

    invalidateBoundaryRulesCache();
    res.status(204).end();
  }),
);

export default router;
