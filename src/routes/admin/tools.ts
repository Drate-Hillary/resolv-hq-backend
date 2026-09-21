import type { Request, Response } from "express";
import { Router } from "express";
import { requireRole } from "../../lib/auth.js";
import { notFound } from "../../lib/errors.js";
import { db } from "../../lib/supabase.js";
import { asyncRoute } from "../../middleware/error-handler.js";

const router = Router();
router.use(requireRole("staff"));

router.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const { data, error } = await db.from("agent_tools").select("*").order("name");
    if (error) throw error;
    res.json(data ?? []);
  }),
);

/** Ported from tools-view's `toggleStatus` — flips active/disabled. */
router.patch(
  "/:id/status",
  asyncRoute(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { data: current, error: fetchError } = await db.from("agent_tools").select("is_active").eq("id", id).single();
    if (fetchError || !current) throw notFound("Tool not found");

    const nextActive = !current.is_active;
    const { data, error } = await db.from("agent_tools").update({ is_active: nextActive }).eq("id", id).select("*").single();
    if (error || !data) throw error ?? notFound("Tool not found");

    res.json(data);
  }),
);

export default router;
