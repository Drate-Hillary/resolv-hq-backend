// Shared by src/routes/admin/approvals.ts (the ticket-queue decide) and
// whatever the agent-workspace console calls once a run hits its approval
// gate. Both flows ultimately do the exact same thing to the exact same
// agent_approvals row, so there is exactly one implementation of that
// update here.
import { publishEvent } from "./bus.js";
import { prisma } from "./prisma.js";
import { isNotFound } from "./prisma-errors.js";
import { notFound } from "./errors.js";
import { priorityToDb, resolveCategoryId } from "./mappers.js";
import { statusIdByName } from "./statuses.js";
import type { EscalationDraft } from "./agent-tools.js";
import { notifyUsers } from "./notify.js";
import type { ApprovalStatus } from "../types/database.types.js";

export type ApprovalDecision = Extract<ApprovalStatus, "approved" | "rejected">;

/**
 * An approved escalation becomes a real request in the ticket queue, linked
 * back to the run so the console can open it. Idempotent: a run that already
 * has a request (or has no stored draft) is left alone.
 */
async function fileEscalationRequest(run: { id: string; customer_id: string | null; request_id: string | null; tool_input: unknown }) {
  if (run.request_id) return run.request_id;
  const customerId = run.customer_id;
  if (!customerId) return null;
  const draft = (run.tool_input as { escalationDraft?: EscalationDraft } | null)?.escalationDraft;
  if (!draft) return null;

  const [categories, statusId] = await Promise.all([prisma.request_categories.findMany(), statusIdByName("submitted")]);
  const details = [draft.description, draft.keyFacts && `Key facts: ${draft.keyFacts}`, draft.suggestedAction && `Suggested next step: ${draft.suggestedAction}`]
    .filter(Boolean)
    .join("\n\n");

  return prisma.$transaction(async (tx) => {
    const request = await tx.requests.create({
      data: {
        customer_id: customerId,
        category_id: resolveCategoryId(categories, draft.category),
        status_id: statusId,
        title: draft.title,
        description: details,
        priority: priorityToDb(draft.priority),
        source: "mobile",
        ai_handled: true,
      },
    });
    await tx.request_messages.create({
      data: { request_id: request.id, sender_type: "customer", sender_id: customerId, message: draft.description },
    });
    await tx.agent_runs.update({ where: { id: run.id }, data: { request_id: request.id } });
    return request.id;
  });
}

export async function decideApproval(
  approvalId: string,
  decision: ApprovalDecision,
  user: { id: string },
  note?: string,
) {
  let approval;
  try {
    approval = await prisma.agent_approvals.update({
      where: { id: approvalId },
      data: {
        status: decision,
        reviewed_by: user.id,
        reviewed_at: new Date(),
        review_comment: note ?? null,
      },
    });
  } catch (err) {
    if (isNotFound(err)) throw notFound("Approval not found");
    throw err;
  }

  // The run itself was left "awaiting_approval" when the draft was created —
  // this is the only place its outcome is known, so it's the only place
  // that can close it out.
  const run = await prisma.agent_runs.update({
    where: { id: approval.agent_run_id },
    data: { status: decision === "approved" ? "completed" : "failed", completed_at: new Date() },
    select: { id: true, customer_id: true, request_id: true, tool_input: true },
  });

  let requestId = run.request_id;
  if (decision === "approved") {
    try {
      requestId = await fileEscalationRequest(run);
    } catch (err) {
      // The decision is already recorded; a failure here must not undo it.
      console.error("Failed to file the approved escalation as a request:", err);
    }
  }

  publishEvent("approval.decided", { approvalId: approval.id, runId: approval.agent_run_id, decision });

  // Whoever the assistant was talking to hears the outcome.
  await notifyUsers(
    [run.customer_id],
    {
      type: "ai",
      title: decision === "approved" ? "Escalation approved" : "Escalation declined",
      message:
        decision === "approved"
          ? "Our team approved the escalation and will follow up with you."
          : note
            ? `Our team reviewed your escalation and declined it: ${note}`
            : "Our team reviewed your escalation and decided not to proceed with it.",
      requestId,
    },
    user.id,
  );

  return { ...approval, requestId };
}
