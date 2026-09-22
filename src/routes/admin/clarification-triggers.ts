// CRUD for clarification_triggers — the data backing lib/clarification.ts's
// Clarification Prompting Logic. Every vague-phrase pattern and its
// targeted question lives here, editable without a code change or
// redeploy — same shape as routes/admin/boundary-rules.ts.
import type { Request, Response } from "express";
import { Router } from "express";
import { invalidateClarificationCache } from "../../lib/clarification.js";
import { requireRole } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { db } from "../../lib/supabase.js";
import { asyncRoute } from "../../middleware/error-handler.js";
import type { Database } from "../../types/database.types.js";

const router = Router();
router.use(requireRole("staff"));

/** Rejects an invalid regex up front rather than letting it fail silently
 * (and get skipped) every time lib/clarification.ts loads the trigger set. */
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
    const { data, error } = await db.from("clarification_triggers").select("*").order("created_at", { ascending: true });
    if (error) throw error;
    res.json(data ?? []);
  }),
);

router.post(
  "/",
  asyncRoute(async (req: Request, res: Response) => {
    const { pattern, question, is_fallback, is_active } = req.body as {
      pattern?: string | null;
      question?: string;
      is_fallback?: boolean;
      is_active?: boolean;
    };
    if (!question?.trim()) throw badRequest("question is required");
    if (!is_fallback && !pattern?.trim()) throw badRequest("pattern is required unless is_fallback is true");
    if (pattern?.trim()) assertValidPattern(pattern);

    const insert: Database["public"]["Tables"]["clarification_triggers"]["Insert"] = {
      pattern: pattern?.trim() || null,
      question: question.trim(),
      is_fallback: is_fallback ?? false,
      is_active: is_active ?? true,
    };

    const { data, error } = await db.from("clarification_triggers").insert(insert).select("*").single();
    if (error || !data) throw error ?? new Error("Failed to create trigger");

    invalidateClarificationCache();
    res.status(201).json(data);
  }),
);

router.patch(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    const { pattern, question, is_fallback, is_active } = req.body as {
      pattern?: string | null;
      question?: string;
      is_fallback?: boolean;
      is_active?: boolean;
    };

    const update: Database["public"]["Tables"]["clarification_triggers"]["Update"] = {};
    if (pattern !== undefined) {
      if (pattern?.trim()) assertValidPattern(pattern);
      update.pattern = pattern?.trim() || null;
    }
    if (question !== undefined) {
      if (!question.trim()) throw badRequest("question cannot be empty");
      update.question = question.trim();
    }
    if (is_fallback !== undefined) update.is_fallback = is_fallback;
    if (is_active !== undefined) update.is_active = is_active;
    if (Object.keys(update).length === 0) throw badRequest("Nothing to update");

    const { data, error } = await db
      .from("clarification_triggers")
      .update(update)
      .eq("id", req.params.id)
      .select("*")
      .single();
    if (error || !data) throw notFound("Trigger not found");

    invalidateClarificationCache();
    res.json(data);
  }),
);

router.delete(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    const { error } = await db.from("clarification_triggers").delete().eq("id", req.params.id);
    if (error) throw error;

    invalidateClarificationCache();
    res.status(204).end();
  }),
);

export default router;
