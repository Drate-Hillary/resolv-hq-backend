// Shared by src/routes/admin/approvals.ts (the ticket-queue decide) and
// whatever the agent-workspace console calls once a run hits its approval
// gate. Both flows ultimately do the exact same thing to the exact same
// agent_approvals row, so there is exactly one implementation of that
// update here.
import { prisma } from "./prisma.js";
import { isNotFound } from "./prisma-errors.js";
import { notFound } from "./errors.js";
import { notifyUsers } from "./notify.js";
import type { ApprovalStatus } from "../types/database.types.js";

export type ApprovalDecision = Extract<ApprovalStatus, "approved" | "rejected">;

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
    select: { customer_id: true, request_id: true },
  });

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
      requestId: run.request_id,
    },
    user.id,
  );

  return approval;
}
