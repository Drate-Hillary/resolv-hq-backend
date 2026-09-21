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
import { db } from "../../lib/supabase.js";
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
    const { data: approvals, error } = await db
      .from("agent_approvals")
      .select("id, agent_run_id, requested_action, reason, status, requested_at")
      .order("requested_at", { ascending: false })
      .limit(50);
    if (error) throw error;

    const rows = approvals ?? [];
    const runIds = Array.from(new Set(rows.map((r) => r.agent_run_id)));

    const requestByRunId = new Map<string, string | null>();
    const requestsById = new Map<
      string,
      { id: string; title: string; priority: RequestPriority; customer_id: string; assigned_agent_id: string | null }
    >();
    const namesById = new Map<string, string>();

    if (runIds.length > 0) {
      const { data: runs } = await db.from("agent_runs").select("id, request_id").in("id", runIds);
      for (const r of runs ?? []) requestByRunId.set(r.id, r.request_id);

      const requestIds = Array.from(
        new Set((runs ?? []).map((r) => r.request_id).filter((id): id is string => Boolean(id))),
      );
      if (requestIds.length > 0) {
        const { data: requests } = await db
          .from("requests")
          .select("id, title, priority, customer_id, assigned_agent_id")
          .in("id", requestIds);
        for (const r of requests ?? []) requestsById.set(r.id, r);

        const customerIds = Array.from(new Set((requests ?? []).map((r) => r.customer_id)));
        if (customerIds.length > 0) {
          const { data: profiles } = await db.from("profiles").select("id, first_name, last_name").in("id", customerIds);
          for (const p of profiles ?? []) {
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
        waitingSince: formatWaiting(row.requested_at),
        status: row.status,
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
    const { data: approval, error } = await db
      .from("agent_approvals")
      .select("id, agent_run_id, requested_action, reason, status, review_comment")
      .eq("id", req.params.id)
      .single();
    if (error || !approval) throw notFound("Approval not found");

    const { data: run } = await db.from("agent_runs").select("request_id").eq("id", approval.agent_run_id).single();
    const requestId = run?.request_id ?? null;

    let transcript: TranscriptEntry[] = [];
    if (requestId) {
      const { data: messages } = await db
        .from("request_messages")
        .select("id, sender_type, message, created_at")
        .eq("request_id", requestId)
        .order("created_at", { ascending: true });

      transcript = (messages ?? []).map((m) => ({
        id: m.id,
        role: m.sender_type === "customer" ? "user" : "agent",
        content: m.message,
        timestamp: new Date(m.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      }));
    }

    const escalation: Escalation = {
      approvalId: approval.id,
      requestId,
      requestedAction: approval.requested_action,
      reason: approval.reason,
      status: approval.status,
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
    const { data: profiles } = await db
      .from("profiles")
      .select("id, first_name, last_name")
      .in("role", ["admin", "agent"])
      .eq("status", "active");
    res.json(
      (profiles ?? []).map((p) => ({
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

    const { data, error } = await db
      .from("requests")
      .update({ assigned_agent_id: adminId })
      .eq("id", req.params.id)
      .select()
      .single();
    if (error || !data) throw notFound("Request not found");

    res.json(data);
  }),
);

export default router;
