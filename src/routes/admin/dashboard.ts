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

    // Runs per day for the last 7 calendar days (today included), oldest first.
    const windowStart = new Date(startOfToday);
    windowStart.setDate(windowStart.getDate() - 6);
    const windowRuns = await prisma.agent_runs.findMany({
      where: { started_at: { gte: windowStart } },
      select: { started_at: true, status: true },
    });
    const runsByDay = Array.from({ length: 7 }, (_, i) => {
      const day = new Date(windowStart);
      day.setDate(windowStart.getDate() + i);
      const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      return { date, runs: 0, failed: 0, day };
    });
    for (const run of windowRuns) {
      if (!run.started_at) continue;
      const bucket = runsByDay.find((d) => run.started_at! >= d.day && run.started_at! < new Date(d.day.getTime() + 24 * 60 * 60 * 1000));
      if (!bucket) continue;
      bucket.runs++;
      if (run.status === "failed") bucket.failed++;
    }

    // Responses given per agent provider (e.g. anthropic, openai). Assistant messages
    // record the model that wrote them, so a response is attributed to the provider
    // that has that model registered. Keyword-fallback answers have no model and
    // aren't attributed to anyone.
    const [providers, responsesByModel] = await Promise.all([
      prisma.agent_providers.findMany({ select: { provider: true, model: true }, orderBy: { created_at: "asc" } }),
      prisma.ai_messages.groupBy({ by: ["model"], where: { sender_type: "assistant" }, _count: { _all: true } }),
    ]);
    const modelsByProvider = new Map<string, Set<string>>();
    for (const p of providers) {
      const models = modelsByProvider.get(p.provider) ?? new Set<string>();
      if (p.model) models.add(p.model);
      modelsByProvider.set(p.provider, models);
    }
    const agentPerformance = [...modelsByProvider].map(([provider, models]) => ({
      id: provider,
      name: provider,
      model: [...models].join(", ") || null,
      responses: responsesByModel
        .filter((r) => r.model != null && models.has(r.model))
        .reduce((n, r) => n + r._count._all, 0),
    }));

    res.json({
      agentPerformance,
      runsByDay: runsByDay.map(({ date, runs, failed }) => ({ date, runs, failed })),
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
