import type { Request, Response } from "express";
import { Router } from "express";
import { requireRole } from "../../lib/auth.js";
import { prisma } from "../../lib/prisma.js";
import { asyncRoute } from "../../middleware/error-handler.js";

const router = Router();
router.use(requireRole("staff"));

/** Match score at which retrieval counts as fully confident (scores are keyword/semantic points, not 0-1). */
const CONFIDENCE_FULL_SCORE = 5;
const BUCKETS = ["0-20%", "20-40%", "40-60%", "60-80%", "80-100%"];

/**
 * The temperature a provider row is configured with. Only the LangChain
 * clients pin one (0, see lib/llm/providers/langchain.ts); the direct
 * OpenAI/Anthropic/Google clients never set it, so the vendor default applies
 * and there is no number to report.
 */
function configuredTemperature(provider: string): number | null {
  return provider === "langchain" ? 0 : null;
}

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 100));

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

    // Answer-quality signals per run, from the stored trace. Neither value is measured by the
    // model: confidence is how strongly the best retrieved passage matched (capped at 100%),
    // and a run is flagged when the boundary matrix blocked its answer, or it answered with
    // no retrieved source and no tool result to rely on.
    const traced = await prisma.agent_runs.findMany({
      where: { started_at: { gte: windowStart }, agent_trace_logs: { some: { kind: "model_call", error: null } } },
      select: {
        started_at: true,
        agent_trace_logs: { select: { kind: true, detail: true, provider: true, error: true } },
      },
      orderBy: { started_at: "desc" },
      take: 1000,
    });
    const analysed = traced.flatMap((run) => {
      if (!run.started_at) return [];
      const retrieval = run.agent_trace_logs.find((t) => t.kind === "retrieval");
      let top = 0;
      let sources = 0;
      try {
        const hits = JSON.parse(retrieval?.detail ?? "[]") as { score?: number }[];
        sources = hits.length;
        top = hits.reduce((m, h) => Math.max(m, h.score ?? 0), 0);
      } catch {
        // an unreadable retrieval row counts as no sources
      }
      const confidence = Math.min(top / CONFIDENCE_FULL_SCORE, 1);
      const blocked = run.agent_trace_logs.some((t) => t.kind === "guardrail");
      const usedTool = run.agent_trace_logs.some((t) => t.kind === "tool_call" && !t.error);
      const flagged = blocked || (sources === 0 && !usedTool);
      const provider = run.agent_trace_logs.find((t) => t.kind === "model_call" && t.provider)?.provider ?? null;
      return [{ at: run.started_at, confidence, flagged, provider }];
    });

    const byConfidence = BUCKETS.map((bucket, i) => {
      const inBucket = analysed.filter((r) => Math.min(Math.floor(r.confidence * 5), 4) === i);
      const flagged = inBucket.filter((r) => r.flagged).length;
      return { bucket, runs: inBucket.length, flagged, flaggedRate: pct(flagged, inBucket.length) };
    });
    const byProvider = (await prisma.agent_providers.findMany({
      select: { name: true, provider: true, model: true },
      orderBy: { created_at: "asc" },
    })).map((p) => {
      const mine = analysed.filter((r) => r.provider === p.name);
      return {
        name: p.name,
        model: p.model,
        temperature: configuredTemperature(p.provider),
        runs: mine.length,
        avgConfidence: pct(mine.reduce((n, r) => n + r.confidence, 0), mine.length),
        flaggedRate: pct(mine.filter((r) => r.flagged).length, mine.length),
      };
    });

    res.json({
      reliability: {
        runsAnalysed: analysed.length,
        avgConfidence: pct(analysed.reduce((n, r) => n + r.confidence, 0), analysed.length),
        flaggedRate: pct(analysed.filter((r) => r.flagged).length, analysed.length),
        byConfidence,
        byProvider,
      },
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
