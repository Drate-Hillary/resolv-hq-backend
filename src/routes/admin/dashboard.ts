import type { Request, Response } from "express";
import { Router } from "express";
import { requireRole } from "../../lib/auth.js";
import { prisma } from "../../lib/prisma.js";
import { asyncRoute } from "../../middleware/error-handler.js";

const router = Router();
router.use(requireRole("staff"));

router.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [recentRuns, ragCount, toolsCount, memoryCount, failedCount, pendingApprovalsCount, tasksTodayCount] =
      await Promise.all([
        prisma.agent_runs.findMany({ orderBy: { started_at: "desc" }, take: 4 }),
        prisma.knowledge_documents.count(),
        prisma.agent_tools.count({ where: { is_active: true } }),
        prisma.customer_memory.count(),
        prisma.agent_runs.count({ where: { status: "failed", started_at: { gte: sevenDaysAgo } } }),
        prisma.agent_approvals.count({ where: { status: "pending" } }),
        prisma.agent_runs.count({ where: { started_at: { gte: startOfToday } } }),
      ]);

    res.json({
      recentRuns,
      stats: {
        tasksToday: tasksTodayCount,
        ragDocuments: ragCount,
        activeTools: toolsCount,
        memoryRecords: memoryCount,
        failedRuns: failedCount,
        pendingApprovals: pendingApprovalsCount,
      },
    });
  }),
);

export default router;
