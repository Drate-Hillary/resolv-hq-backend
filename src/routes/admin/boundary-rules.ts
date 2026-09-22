// CRUD for boundary_rules — the data backing lib/ai-boundary.ts's structural
// backstop. This is what makes "no hardcoded values" real: every category,
// detection pattern, and fallback message lives here, editable without a
// code change or redeploy. invalidateBoundaryRulesCache() is called after
// every mutation so a change is picked up on the very next chat message.
import type { Request, Response } from "express";
import { Router } from "express";
import { invalidateBoundaryRulesCache } from "../../lib/ai-boundary.js";
import { requireRole } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { db } from "../../lib/supabase.js";
import { asyncRoute } from "../../middleware/error-handler.js";
import type { Database } from "../../types/database.types.js";

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
    const { data, error } = await db.from("boundary_rules").select("*").order("created_at", { ascending: true });
    if (error) throw error;
    res.json(data ?? []);
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

    const insert: Database["public"]["Tables"]["boundary_rules"]["Insert"] = {
      category: category.trim(),
      pattern: pattern.trim(),
      fallback_message: fallback_message.trim(),
      is_active: is_active ?? true,
    };

    const { data, error } = await db.from("boundary_rules").insert(insert).select("*").single();
    if (error || !data) throw error ?? new Error("Failed to create rule");

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

    const update: Database["public"]["Tables"]["boundary_rules"]["Update"] = {};
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
    update.updated_at = new Date().toISOString();

    const { data, error } = await db.from("boundary_rules").update(update).eq("id", req.params.id).select("*").single();
    if (error || !data) throw notFound("Rule not found");

    invalidateBoundaryRulesCache();
    res.json(data);
  }),
);

router.delete(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    const { error } = await db.from("boundary_rules").delete().eq("id", req.params.id);
    if (error) throw error;

    invalidateBoundaryRulesCache();
    res.status(204).end();
  }),
);

export default router;
