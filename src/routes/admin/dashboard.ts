import type { Request, Response } from "express";
import { Router } from "express";
import { requireRole } from "../../lib/auth.js";
import { db } from "../../lib/supabase.js";
import { asyncRoute } from "../../middleware/error-handler.js";

const router = Router();
router.use(requireRole("staff"));

router.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [
      recentRunsRes,
      ragCountRes,
      toolsCountRes,
      memoryCountRes,
      failedCountRes,
      pendingApprovalsRes,
      tasksTodayRes,
    ] = await Promise.all([
      db.from("agent_runs").select("*").order("started_at", { ascending: false }).limit(4),
      db.from("knowledge_documents").select("id", { count: "exact", head: true }),
      db.from("agent_tools").select("id", { count: "exact", head: true }).eq("is_active", true),
      db.from("customer_memory").select("id", { count: "exact", head: true }),
      db
        .from("agent_runs")
        .select("id", { count: "exact", head: true })
        .eq("status", "failed")
        .gte("started_at", sevenDaysAgo),
      db.from("agent_approvals").select("id", { count: "exact", head: true }).eq("status", "pending"),
      db
        .from("agent_runs")
        .select("id", { count: "exact", head: true })
        .gte("started_at", startOfToday.toISOString()),
    ]);

    for (const r of [recentRunsRes, ragCountRes, toolsCountRes, memoryCountRes, failedCountRes, pendingApprovalsRes, tasksTodayRes]) {
      if (r.error) throw r.error;
    }

    res.json({
      recentRuns: recentRunsRes.data ?? [],
      stats: {
        tasksToday: tasksTodayRes.count ?? 0,
        ragDocuments: ragCountRes.count ?? 0,
        activeTools: toolsCountRes.count ?? 0,
        memoryRecords: memoryCountRes.count ?? 0,
        failedRuns: failedCountRes.count ?? 0,
        pendingApprovals: pendingApprovalsRes.count ?? 0,
      },
    });
  }),
);

export default router;
