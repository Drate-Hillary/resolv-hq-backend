// Shared by src/routes/admin/approvals.ts (the ticket-queue decide) and
// whatever the agent-workspace console calls once a run hits its approval
// gate. Both flows ultimately do the exact same thing to the exact same
// agent_approvals row, so there is exactly one implementation of that
// update here.
import { prisma } from "./prisma.js";
import { isNotFound } from "./prisma-errors.js";
import { notFound } from "./errors.js";
import type { ApprovalStatus } from "../types/database.types.js";

export type ApprovalDecision = Extract<ApprovalStatus, "approved" | "rejected">;

export async function decideApproval(
  approvalId: string,
  decision: ApprovalDecision,
  user: { id: string },
  note?: string,
) {
  try {
    return await prisma.agent_approvals.update({
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
}
