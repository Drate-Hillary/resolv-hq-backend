import { Router, type Request, type Response } from "express";
import { formatEscalationDraft, type EscalationDraft } from "../lib/agent-tools.js";
import { generateAssistantReply, type AiAccountInput, type AiKnowledgeInput, type AiRequestInput } from "../lib/ai.js";
import { badRequest, notFound } from "../lib/errors.js";
import { formatMemberSince, mapChatMessageRow, mapConversationRow } from "../lib/mappers.js";
import { assertConversationAccess } from "../lib/ownership.js";
import { SYSTEM_PROMPT_VERSION } from "../lib/prompts/system-prompt.js";
import { finalStatusIds, loadStatuses } from "../lib/statuses.js";
import { prisma } from "../lib/prisma.js";
import { asyncRoute } from "../middleware/error-handler.js";
import type { AiConversationRow, AiMessageRow, RequestRow } from "../types/database.types.js";

const router = Router();

function isStaff(role: string): boolean {
  return role === "admin" || role === "agent";
}

/** Backs the account_status_lookup tool (lib/agent-tools.ts) — always the
 * caller's own account, resolved server-side from req.user, never
 * client-supplied. */
async function loadAccountInput(userId: string, role: string): Promise<AiAccountInput> {
  const profile = await prisma.profiles.findUnique({ where: { id: userId } });

  let customerProfile: { organization_name: string | null; city: string | null; country: string | null } | null = null;
  if (role === "customer") {
    customerProfile = await prisma.customer_profiles.findUnique({ where: { user_id: userId } });
  }

  return {
    role,
    status: profile?.status ?? "active",
    organizationName: customerProfile?.organization_name ?? null,
    city: customerProfile?.city ?? null,
    country: customerProfile?.country ?? "Uganda",
    memberSince: profile ? formatMemberSince(profile.created_at as unknown as string) : "unknown",
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
    const data = (await prisma.ai_conversations.create({
      data: { customer_id: req.user!.id, title: title ?? null },
    })) as unknown as AiConversationRow;
    res.status(201).json(mapConversationRow(data, 0));
  }),
);

router.get(
  "/conversations",
  asyncRoute(async (req: Request, res: Response) => {
    const rows = (await prisma.ai_conversations.findMany({
      where: { customer_id: req.user!.id },
      orderBy: { created_at: "desc" },
    })) as unknown as AiConversationRow[];
    if (rows.length === 0) {
      res.json([]);
      return;
    }

    const ids = rows.map((c) => c.id);
    const messages = await prisma.ai_messages.findMany({
      where: { conversation_id: { in: ids } },
      select: { id: true, conversation_id: true },
    });
    const countByConversation = new Map<string, number>();
    for (const m of messages) {
      countByConversation.set(m.conversation_id, (countByConversation.get(m.conversation_id) ?? 0) + 1);
    }
    res.json(rows.map((c) => mapConversationRow(c, countByConversation.get(c.id) ?? 0)));
  }),
);

router.get(
  "/conversations/:id",
  asyncRoute(async (req: Request, res: Response) => {
    await assertConversationAccess(req.params.id, req.user!);
    const messages = (await prisma.ai_messages.findMany({
      where: { conversation_id: req.params.id },
      orderBy: { created_at: "asc" },
    })) as unknown as AiMessageRow[];
    res.json(messages.map((m) => mapChatMessageRow(m)));
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

    const userRow = (await prisma.ai_messages.create({
      data: { conversation_id: req.params.id, sender_type: "customer", content },
    })) as unknown as AiMessageRow;

    const statuses = await loadStatuses();
    const statusNameById = new Map(statuses.map((s) => [s.id, s.name]));
    const finalIds = await finalStatusIds();

    const [docs, requests, account] = await Promise.all([
      prisma.knowledge_documents.findMany({ where: { status: "published" } }),
      (isStaff(user.role)
        ? prisma.requests.findMany({
            where: finalIds.length > 0 ? { status_id: { notIn: finalIds } } : undefined,
          })
        : prisma.requests.findMany({ where: { customer_id: user.id } })) as unknown as Promise<RequestRow[]>,
      loadAccountInput(user.id, user.role),
    ]);

    const knowledgeInputs: AiKnowledgeInput[] = docs.map((d) => ({
      id: d.id,
      title: d.title,
      content: d.content ?? "",
    }));
    const requestInputs: AiRequestInput[] = requests.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status_id ? statusNameById.get(r.status_id) ?? "unknown" : "unknown",
    }));

    const answer = await generateAssistantReply(content, knowledgeInputs, requestInputs, account, isStaff(user.role));

    const assistantRow = (await prisma.ai_messages.create({
      data: {
        conversation_id: req.params.id,
        sender_type: "assistant",
        content: answer.text,
      },
    })) as unknown as AiMessageRow;

    // The tool itself never writes anything (AI Boundary Matrix — the
    // toolset stays read-only); this is the one place a drafted escalation
    // actually reaches a human; it's created "awaiting_approval", so nothing
    // is filed until staff act on it via admin/approvals.ts.
    let escalation: ({ approvalId: string; runId: string } & EscalationDraft) | null = null;
    if (answer.escalationDraft) {
      const run = await prisma.agent_runs.create({
        data: {
          customer_id: user.id,
          conversation_id: req.params.id,
          status: "awaiting_approval",
          current_step: "draft_escalation_ticket",
          prompt_version: SYSTEM_PROMPT_VERSION,
        },
      });
      const approval = await prisma.agent_approvals.create({
        data: {
          agent_run_id: run.id,
          requested_action: formatEscalationDraft(answer.escalationDraft),
          reason: answer.escalationDraft.suggestedAction,
          status: "pending",
        },
      });
      escalation = { approvalId: approval.id, runId: run.id, ...answer.escalationDraft };
    }

    res.status(201).json({
      userMessage: mapChatMessageRow(userRow),
      assistantMessage: mapChatMessageRow(assistantRow),
      suggestions: answer.suggestions,
      steps: answer.steps,
      sources: answer.sources,
      trace: answer.trace ?? [],
      fallbackReason: answer.fallbackReason ?? null,
      knowledgeCount: knowledgeInputs.length,
      openRequestCount: requestInputs.length,
      escalation,
    });
  }),
);

/** Scoped through the message's conversation, not just its id, so a
 * customer can't rate another customer's message by guessing an id. */
router.patch(
  "/messages/:id/feedback",
  asyncRoute(async (req: Request, res: Response) => {
    const { feedback } = req.body as { feedback?: "up" | "down" | null };
    if (feedback !== "up" && feedback !== "down" && feedback !== null) {
      throw badRequest('feedback must be "up", "down", or null');
    }

    const message = await prisma.ai_messages.findUnique({
      where: { id: req.params.id },
      select: { id: true, conversation_id: true },
    });
    if (!message) throw notFound("Message not found");

    await assertConversationAccess(message.conversation_id, req.user!);

    const data = (await prisma.ai_messages.update({
      where: { id: req.params.id },
      data: { feedback },
    })) as unknown as AiMessageRow;

    res.json(mapChatMessageRow(data));
  }),
);

export default router;
