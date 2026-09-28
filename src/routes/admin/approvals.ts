// The ticket-queue escalation view, plus the shared approve/reject decision
// on agent_approvals. That shared update lives once, in
// lib/approval-decisions.ts; this file is its only caller.
//
// agent_approvals no longer has a request_id column directly — it only
// references agent_runs, which in turn has request_id — so every lookup
// from an approval back to its request now goes through agent_runs first.
import { Router } from "express";
import { requireRole } from "../../lib/auth.js";
import { decideApproval } from "../../lib/approval-decisions.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { isNotFound } from "../../lib/prisma-errors.js";
import { prisma } from "../../lib/prisma.js";
import { asyncRoute } from "../../middleware/error-handler.js";
import type { ApprovalStatus, RequestPriority } from "../../types/database.types.js";

const router = Router();

interface AdminTicket {
  approvalId: string;
  requestId: string | null;
  customerName: string;
  subject: string;
  priority: RequestPriority;
  waitingSince: string;
  status: ApprovalStatus;
  assignedAgentId: string | null;
}

interface TranscriptEntry {
  id: string;
  role: "user" | "agent";
  content: string;
  timestamp: string;
}

interface Escalation {
  approvalId: string;
  requestId: string | null;
  requestedAction: string;
  reason: string | null;
  status: ApprovalStatus;
  reviewComment: string | null;
  transcript: TranscriptEntry[];
}

function formatWaiting(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr`;
  return `${Math.round(hrs / 24)} d`;
}

/** The ticket-queue list: last 50 agent_approvals, newest first, joined
 * through agent_runs to requests, and to profiles for display names. */
router.get(
  "/",
  requireRole("staff"),
  asyncRoute(async (_req, res) => {
    const rows = await prisma.agent_approvals.findMany({
      select: { id: true, agent_run_id: true, requested_action: true, reason: true, status: true, requested_at: true },
      orderBy: { requested_at: "desc" },
      take: 50,
    });
    const runIds = Array.from(new Set(rows.map((r) => r.agent_run_id)));

    const requestByRunId = new Map<string, string | null>();
    const requestsById = new Map<
      string,
      { id: string; title: string; priority: RequestPriority; customer_id: string; assigned_agent_id: string | null }
    >();
    const namesById = new Map<string, string>();

    if (runIds.length > 0) {
      const runs = await prisma.agent_runs.findMany({
        where: { id: { in: runIds } },
        select: { id: true, request_id: true },
      });
      for (const r of runs) requestByRunId.set(r.id, r.request_id);

      const requestIds = Array.from(
        new Set(runs.map((r) => r.request_id).filter((id): id is string => Boolean(id))),
      );
      if (requestIds.length > 0) {
        const requests = (await prisma.requests.findMany({
          where: { id: { in: requestIds } },
          select: { id: true, title: true, priority: true, customer_id: true, assigned_agent_id: true },
        })) as { id: string; title: string; priority: RequestPriority; customer_id: string; assigned_agent_id: string | null }[];
        for (const r of requests) requestsById.set(r.id, r);

        const customerIds = Array.from(new Set(requests.map((r) => r.customer_id)));
        if (customerIds.length > 0) {
          const profiles = await prisma.profiles.findMany({
            where: { id: { in: customerIds } },
            select: { id: true, first_name: true, last_name: true },
          });
          for (const p of profiles) {
            namesById.set(p.id, [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unknown customer");
          }
        }
      }
    }

    const tickets: AdminTicket[] = rows.map((row) => {
      const requestId = requestByRunId.get(row.agent_run_id) ?? null;
      const request = requestId ? requestsById.get(requestId) : undefined;
      return {
        approvalId: row.id,
        requestId,
        customerName: request ? namesById.get(request.customer_id) ?? "Unknown customer" : "Unknown customer",
        subject: request?.title ?? row.requested_action,
        priority: request?.priority ?? "medium",
        waitingSince: formatWaiting(row.requested_at as unknown as string),
        status: row.status as ApprovalStatus,
        assignedAgentId: request?.assigned_agent_id ?? null,
      };
    });

    res.json(tickets);
  }),
);

/** Escalation detail for one approval: the proposed action and the request's
 * message transcript, resolved through its agent_run. */
router.get(
  "/:id",
  requireRole("staff"),
  asyncRoute(async (req, res) => {
    const approval = await prisma.agent_approvals.findUnique({
      where: { id: req.params.id },
      select: { id: true, agent_run_id: true, requested_action: true, reason: true, status: true, review_comment: true },
    });
    if (!approval) throw notFound("Approval not found");

    const run = await prisma.agent_runs.findUnique({
      where: { id: approval.agent_run_id },
      select: { request_id: true },
    });
    const requestId = run?.request_id ?? null;

    let transcript: TranscriptEntry[] = [];
    if (requestId) {
      const messages = await prisma.request_messages.findMany({
        where: { request_id: requestId },
        select: { id: true, sender_type: true, message: true, created_at: true },
        orderBy: { created_at: "asc" },
      });

      transcript = messages.map((m) => ({
        id: m.id,
        role: m.sender_type === "customer" ? "user" : "agent",
        content: m.message,
        timestamp: new Date(m.created_at ?? 0).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      }));
    }

    const escalation: Escalation = {
      approvalId: approval.id,
      requestId,
      requestedAction: approval.requested_action,
      reason: approval.reason,
      status: approval.status as ApprovalStatus,
      reviewComment: approval.review_comment,
      transcript,
    };

    res.json(escalation);
  }),
);

/** Decide an approval: approved. reviewed_by is always the caller, never client-supplied. */
router.patch(
  "/:id/approve",
  requireRole("staff"),
  asyncRoute(async (req, res) => {
    const { note } = req.body as { note?: string };
    res.json(await decideApproval(req.params.id, "approved", req.user!, note));
  }),
);

/** Decide an approval: rejected. reviewed_by is always the caller, never client-supplied. */
router.patch(
  "/:id/reject",
  requireRole("staff"),
  asyncRoute(async (req, res) => {
    const { note } = req.body as { note?: string };
    res.json(await decideApproval(req.params.id, "rejected", req.user!, note));
  }),
);

/** Available admins/agents for reassignment, joined to profiles for display names. */
router.get(
  "/available-admins",
  requireRole("staff"),
  asyncRoute(async (_req, res) => {
    const profiles = await prisma.profiles.findMany({
      where: { role: { in: ["admin", "agent"] }, status: "active" },
      select: { id: true, first_name: true, last_name: true },
    });
    res.json(
      profiles.map((p) => ({
        id: p.id,
        name: [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unnamed admin",
      })),
    );
  }),
);

/**
 * Reassign a request to a different admin/agent. Staff can assign to
 * anyone, not just themselves — deliberately different from requests.ts's
 * self-assign (`PATCH /requests/:id/assign`).
 */
router.patch(
  "/requests/:id/assign",
  requireRole("staff"),
  asyncRoute(async (req, res) => {
    const { adminId } = req.body as { adminId?: string | null };
    if (adminId === undefined) throw badRequest("adminId is required");

    let data;
    try {
      data = await prisma.requests.update({
        where: { id: req.params.id },
        data: { assigned_agent_id: adminId },
      });
    } catch (err) {
      if (isNotFound(err)) throw notFound("Request not found");
      throw err;
    }

    res.json(data);
  }),
);

export default router;
