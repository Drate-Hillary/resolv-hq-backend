import { Router, type Request, type Response } from "express";
import { generateAssistantReply, type AiAccountInput, type AiKnowledgeInput, type AiRequestInput } from "../lib/ai.js";
import { badRequest } from "../lib/errors.js";
import { formatMemberSince, mapChatMessageRow, mapConversationRow } from "../lib/mappers.js";
import { assertConversationAccess } from "../lib/ownership.js";
import { finalStatusIds, loadStatuses } from "../lib/statuses.js";
import { db } from "../lib/supabase.js";
import { asyncRoute } from "../middleware/error-handler.js";

const router = Router();

function isStaff(role: string): boolean {
  return role === "admin" || role === "agent";
}

/** Backs the account_status_lookup tool (lib/agent-tools.ts) — always the
 * caller's own account, resolved server-side from req.user, never
 * client-supplied. */
async function loadAccountInput(userId: string, role: string): Promise<AiAccountInput> {
  const { data: profile } = await db.from("profiles").select("*").eq("id", userId).single();

  let customerProfile: { organization_name: string | null; city: string | null; country: string } | null = null;
  if (role === "customer") {
    const { data } = await db.from("customer_profiles").select("*").eq("user_id", userId).single();
    customerProfile = data;
  }

  return {
    role,
    status: profile?.status ?? "active",
    organizationName: customerProfile?.organization_name ?? null,
    city: customerProfile?.city ?? null,
    country: customerProfile?.country ?? "Uganda",
    memberSince: profile ? formatMemberSince(profile.created_at) : "unknown",
  };
}

/**
 * customer_id is "the owning user" for both callers of this table today:
 * the customer app's real assistant chat, and resolv-hq's internal staff
 * demo chat — in the latter case that's the staff member's own id. Always
 * forced to req.user.id, never client-supplied.
 */
router.post(
  "/conversations",
  asyncRoute(async (req: Request, res: Response) => {
    const { title } = req.body as { title?: string };
    const { data, error } = await db
      .from("ai_conversations")
      .insert({ customer_id: req.user!.id, title: title ?? null })
      .select()
      .single();
    if (error || !data) throw error ?? new Error("Failed to create conversation");
    res.status(201).json(mapConversationRow(data, 0));
  }),
);

router.get(
  "/conversations",
  asyncRoute(async (req: Request, res: Response) => {
    const { data: conversations, error } = await db
      .from("ai_conversations")
      .select("*")
      .eq("customer_id", req.user!.id)
      .order("created_at", { ascending: false });
    if (error) throw error;
    const rows = conversations ?? [];
    if (rows.length === 0) {
      res.json([]);
      return;
    }

    const ids = rows.map((c) => c.id);
    const { data: messages } = await db.from("ai_messages").select("id, conversation_id").in("conversation_id", ids);
    const countByConversation = new Map<string, number>();
    for (const m of messages ?? []) {
      countByConversation.set(m.conversation_id, (countByConversation.get(m.conversation_id) ?? 0) + 1);
    }
    res.json(rows.map((c) => mapConversationRow(c, countByConversation.get(c.id) ?? 0)));
  }),
);

router.get(
  "/conversations/:id",
  asyncRoute(async (req: Request, res: Response) => {
    await assertConversationAccess(req.params.id, req.user!);
    const { data: messages, error } = await db
      .from("ai_messages")
      .select("*")
      .eq("conversation_id", req.params.id)
      .order("created_at", { ascending: true });
    if (error) throw error;
    res.json((messages ?? []).map((m) => mapChatMessageRow(m)));
  }),
);

/**
 * Accepts only the user's text — sender_type is never client-writable. The
 * assistant reply is generated and inserted here, server-side, using the
 * real answerQuestion logic for every caller, including the internal staff
 * demo chat.
 */
router.post(
  "/conversations/:id/messages",
  asyncRoute(async (req: Request, res: Response) => {
    const user = req.user!;
    await assertConversationAccess(req.params.id, user);
    const { content } = req.body as { content?: string };
    if (!content) throw badRequest("content is required");

    const { data: userRow, error: userError } = await db
      .from("ai_messages")
      .insert({ conversation_id: req.params.id, sender_type: "customer", content })
      .select()
      .single();
    if (userError || !userRow) throw userError ?? new Error("Failed to persist message");

    const statuses = await loadStatuses();
    const statusNameById = new Map(statuses.map((s) => [s.id, s.name]));
    const finalIds = await finalStatusIds();

    const [{ data: docs }, { data: requests }, account] = await Promise.all([
      db.from("knowledge_documents").select("*").eq("status", "published"),
      isStaff(user.role)
        ? db.from("requests").select("*").not("status_id", "in", `(${finalIds.join(",") || "null"})`)
        : db.from("requests").select("*").eq("customer_id", user.id),
      loadAccountInput(user.id, user.role),
    ]);

    const knowledgeInputs: AiKnowledgeInput[] = (docs ?? []).map((d) => ({
      id: d.id,
      title: d.title,
      content: d.content ?? "",
    }));
    const requestInputs: AiRequestInput[] = (requests ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status_id ? statusNameById.get(r.status_id) ?? "unknown" : "unknown",
    }));

    const answer = await generateAssistantReply(content, knowledgeInputs, requestInputs, account, isStaff(user.role));

    const { data: assistantRow, error: assistantError } = await db
      .from("ai_messages")
      .insert({
        conversation_id: req.params.id,
        sender_type: "assistant",
        content: answer.text,
      })
      .select()
      .single();
    if (assistantError || !assistantRow) throw assistantError ?? new Error("Failed to persist assistant reply");

    res.status(201).json({
      userMessage: mapChatMessageRow(userRow),
      assistantMessage: mapChatMessageRow(assistantRow),
      suggestions: answer.suggestions,
      steps: answer.steps,
    });
  }),
);

export default router;
