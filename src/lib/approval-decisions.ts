// Shared by src/routes/admin/approvals.ts (the ticket-queue decide) and
// whatever the agent-workspace console calls once a run hits its approval
// gate. Both flows ultimately do the exact same thing to the exact same
// agent_approvals row, so there is exactly one implementation of that
// update here.
import { db } from "./supabase.js";
import { notFound } from "./errors.js";
import type { ApprovalStatus } from "../types/database.types.js";

export type ApprovalDecision = Extract<ApprovalStatus, "approved" | "rejected">;

export async function decideApproval(
  approvalId: string,
  decision: ApprovalDecision,
  user: { id: string },
  note?: string,
) {
  const { data, error } = await db
    .from("agent_approvals")
    .update({
      status: decision,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
      review_comment: note ?? null,
    })
    .eq("id", approvalId)
    .select()
    .single();
  if (error || !data) throw notFound("Approval not found");

  return data;
}
