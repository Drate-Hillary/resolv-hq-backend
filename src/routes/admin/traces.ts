import type { Request, Response } from "express";
import { Router } from "express";
import { requireRole } from "../../lib/auth.js";
import { db } from "../../lib/supabase.js";
import { asyncRoute } from "../../middleware/error-handler.js";

const router = Router();
router.use(requireRole("staff"));

/**
 * trace_runs_view no longer exists — agent_runs now carries everything a
 * trace needs directly (status, current_step, tool_name/input/output,
 * iterations), so this reads straight from it.
 */
router.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const { data, error } = await db
      .from("agent_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(30);
    if (error) throw error;
    res.json(data ?? []);
  }),
);

export default router;
