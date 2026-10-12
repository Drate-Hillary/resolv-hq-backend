import type { Request, Response } from "express";
import { Router } from "express";
import { requireRole } from "../../lib/auth.js";
import { notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
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
    const data = await prisma.agent_runs.findMany({
      orderBy: { started_at: "desc" },
      take: 30,
    });
    res.json(data);
  }),
);

/** Step-by-step trace for one run: retrieval, each model/tool call with latency and error, outcome. */
router.get(
  "/:runId",
  asyncRoute(async (req: Request, res: Response) => {
    const run = await prisma.agent_runs.findUnique({ where: { id: req.params.runId } });
    if (!run) throw notFound("Run not found");
    const events = await prisma.agent_trace_logs.findMany({
      where: { agent_run_id: run.id },
      orderBy: { seq: "asc" },
    });
    res.json({ run, events });
  }),
);

export default router;
