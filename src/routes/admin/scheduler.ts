// Feeds the console's Scheduler board with what is really in the system:
// tickets customers filed and tasks the agent ran for them. Nothing here is
// made up. Each task's column and moves come from its agent_runs row (status,
// stored flow path), and the broker status says whether live events are
// flowing through RabbitMQ.
import type { Request, Response } from "express";
import { Router } from "express";
import { busStatus } from "../../lib/bus.js";
import { requireRole } from "../../lib/auth.js";
import { prisma } from "../../lib/prisma.js";
import { loadStatuses } from "../../lib/statuses.js";
import { asyncRoute } from "../../middleware/error-handler.js";
import type { AgentFlowRecord, FlowStage } from "../../lib/llm/flow-log.js";

const router = Router();
router.use(requireRole("staff"));

/**
 * Finished tasks drop off the board this many hours after they ended (48 by default;
 * 0 keeps everything). Only the board's view is trimmed: the agent_runs rows stay, since
 * they are the audit trail (see lib/retention.ts).
 */
function taskTtlHours(): number {
  const value = Number(process.env.SCHEDULER_TASK_TTL_HOURS ?? 48);
  return Number.isFinite(value) && value >= 0 ? value : 48;
}

type Column = "intake" | "planner" | "tools" | "guard" | "approval" | "done";

interface Move {
  column: Column;
  text: string;
}

const stageColumn: Record<FlowStage["phase"], Column> = {
  plan: "planner",
  act: "tools",
  observe: "planner",
  respond: "guard",
};

/** The path a stored run took, as board moves. */
function movesFor(run: { status: string; error_message: string | null }, flow: AgentFlowRecord | null): Move[] {
  const moves: Move[] = [{ column: "intake", text: "Request received" }];
  for (const stage of flow?.stages ?? []) {
    const last = moves.at(-1);
    const column = stageColumn[stage.phase];
    if (last?.column === column && stage.phase !== "act") continue;
    moves.push({ column, text: stage.label });
  }
  if (run.status === "awaiting_approval") moves.push({ column: "approval", text: "Waiting for staff approval" });
  else if (run.status === "running") return moves;
  else moves.push({ column: "done", text: run.status === "failed" ? (run.error_message ?? "The run failed") : "Answer delivered" });
  return moves;
}

function fullName(p?: { first_name: string | null; last_name: string | null } | null): string | null {
  return p ? ([p.first_name, p.last_name].filter(Boolean).join(" ") || null) : null;
}

router.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const ttl = taskTtlHours();
    const cutoff = new Date(Date.now() - ttl * 60 * 60 * 1000);
    const [statuses, requests, runs] = await Promise.all([
      loadStatuses(),
      prisma.requests.findMany({
        orderBy: { created_at: "desc" },
        take: 50,
        include: { profiles_requests_customer_idToprofiles: { select: { first_name: true, last_name: true } }, request_categories: { select: { name: true } } },
      }),
      prisma.agent_runs.findMany({
        // Unfinished runs (no completed_at) always stay; finished ones expire.
        where: ttl > 0 ? { OR: [{ completed_at: null }, { completed_at: { gte: cutoff } }] } : undefined,
        orderBy: { started_at: "desc" },
        take: 40,
        include: {
          profiles: { select: { first_name: true, last_name: true } },
          agent_approvals: { orderBy: { requested_at: "desc" }, take: 1 },
          ai_conversations: { select: { title: true } },
        },
      }),
    ]);

    // The question behind each run: the customer's last message before it started.
    const conversationIds = [...new Set(runs.map((r) => r.conversation_id).filter((id): id is string => Boolean(id)))];
    const messages = conversationIds.length
      ? await prisma.ai_messages.findMany({
          where: { conversation_id: { in: conversationIds }, sender_type: "user" },
          orderBy: { created_at: "desc" },
          select: { conversation_id: true, content: true, created_at: true },
        })
      : [];
    const questionFor = (conversationId: string | null, startedAt: Date | null) =>
      messages.find((m) => m.conversation_id === conversationId && (!startedAt || !m.created_at || m.created_at <= startedAt))?.content ?? null;

    const statusById = new Map(statuses.map((s) => [s.id, s]));

    res.json({
      queue: { status: busStatus(), broker: "RabbitMQ" },
      tickets: requests.map((r) => {
        const status = r.status_id ? statusById.get(r.status_id) : undefined;
        return {
          id: r.id,
          ticketNumber: String(r.ticket_number),
          title: r.title,
          description: r.description,
          category: r.request_categories?.name ?? null,
          priority: r.priority,
          status: status?.name ?? "unknown",
          isFinal: Boolean(status?.is_final),
          source: r.source,
          aiHandled: r.ai_handled,
          customerName: fullName(r.profiles_requests_customer_idToprofiles),
          createdAt: r.created_at,
        };
      }),
      tasks: runs.map((r) => {
        const flow = (r.tool_input as unknown as AgentFlowRecord | null)?.stages ? (r.tool_input as unknown as AgentFlowRecord) : null;
        const approval = r.agent_approvals[0] ?? null;
        const moves = movesFor({ status: r.status, error_message: r.error_message }, flow);
        return {
          id: r.id,
          request: questionFor(r.conversation_id, r.started_at) ?? r.ai_conversations?.title ?? "Customer chat",
          conversationId: r.conversation_id,
          requestId: r.request_id,
          customerName: fullName(r.profiles),
          status: r.status,
          column: moves.at(-1)!.column,
          moves,
          model: r.model,
          error: r.error_message,
          approval: approval ? { id: approval.id, status: approval.status, action: approval.requested_action } : null,
          startedAt: r.started_at,
          completedAt: r.completed_at,
        };
      }),
    });
  }),
);

export default router;
