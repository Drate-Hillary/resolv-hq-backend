import { db } from "./supabase.js";
import { forbidden, notFound } from "./errors.js";

/**
 * RLS used to guarantee a customer could only ever see/touch their own
 * `requests` row (and everything hanging off it: messages, attachments,
 * status history, feedback). With the service-role key, that guarantee is
 * gone — every request-scoped route for a customer caller MUST call this
 * first. Staff callers are never restricted (open-queue semantics).
 */
export async function assertRequestAccess(requestId: string, user: { id: string; role: string }) {
  const { data, error } = await db
    .from("requests")
    .select("id, customer_id")
    .eq("id", requestId)
    .single();

  if (error || !data) throw notFound("Request not found");

  const isStaff = user.role === "admin" || user.role === "agent";
  if (!isStaff && data.customer_id !== user.id) {
    throw forbidden("You do not have access to this request");
  }

  return data;
}

/** Same idea for a customer's own ai_conversations row. */
export async function assertConversationAccess(
  conversationId: string,
  user: { id: string; role: string }
) {
  const { data, error } = await db
    .from("ai_conversations")
    .select("id, customer_id")
    .eq("id", conversationId)
    .single();

  if (error || !data) throw notFound("Conversation not found");

  if (data.customer_id !== user.id) {
    throw forbidden("You do not have access to this conversation");
  }

  return data;
}
