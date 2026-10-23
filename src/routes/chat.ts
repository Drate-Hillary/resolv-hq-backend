import { publishEvent } from "../lib/bus.js";
import { publish } from "../lib/realtime.js";
import { Prisma } from "@prisma/client";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { resolveMimeType } from "../lib/attachment-storage.js";
import { formatEscalationDraft, type EscalationDraft } from "../lib/agent-tools.js";
import { generateAssistantReply } from "../lib/ai.js";
import { HttpError, badRequest, notFound } from "../lib/errors.js";
import { extractPages, isIndexable } from "../lib/knowledge-index.js";
import { completeWithFallback, GatewayUnavailableError } from "../lib/llm/gateway.js";
import { mapChatMessageRow, mapConversationRow } from "../lib/mappers.js";
import { isStaffRole, loadCallerAccount, loadCallerKnowledge, loadCallerRequests } from "../lib/agent-tool-context.js";
import { notifyStaff } from "../lib/notify.js";
import { assertConversationAccess } from "../lib/ownership.js";
import { SYSTEM_PROMPT_VERSION } from "../lib/prompts/system-prompt.js";
import { prisma } from "../lib/prisma.js";
import { loadCustomerMemory } from "../lib/customer-memory.js";
import { writeTraceLog } from "../lib/trace-log.js";
import { asyncRoute } from "../middleware/error-handler.js";
import type { AiConversationRow, AiMessageRow } from "../types/database.types.js";

const router = Router();

const summaryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

/** Cap on document text sent to the model for a summary (~15k tokens). */
const SUMMARY_MAX_CHARS = 60_000;

/** Customer messages (questions) allowed in one conversation; the client asks for a new chat after this. */
export const MAX_MESSAGES_PER_CONVERSATION = 50;

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
/**
 * The models a user can choose between: active registered providers, by name
 * only. Never includes the API key or anything else about the account.
 */
router.get(
  "/models",
  asyncRoute(async (_req: Request, res: Response) => {
    const rows = await prisma.agent_providers.findMany({
      where: { status: "active" },
      select: { id: true, name: true, provider: true, model: true },
      orderBy: { created_at: "asc" },
    });
    res.json(rows);
  }),
);

router.post(
  "/conversations/:id/messages",
  asyncRoute(async (req: Request, res: Response) => {
    const user = req.user!;
    await assertConversationAccess(req.params.id, user);
    const { content, providerId } = req.body as { content?: string; providerId?: string };
    if (!content) throw badRequest("content is required");

    // Any signed-in user may pick one of the active models (see GET /chat/models).
    let preferredProviderId: string | undefined;
    if (providerId) {
      const chosen = await prisma.agent_providers.findUnique({ where: { id: providerId }, select: { status: true } });
      if (!chosen) throw badRequest("The selected model is not registered");
      if (chosen.status !== "active") throw badRequest("The selected model is disabled");
      preferredProviderId = providerId;
    }

    const sent = await prisma.ai_messages.count({
      where: { conversation_id: req.params.id, sender_type: "customer" },
    });
    if (sent >= MAX_MESSAGES_PER_CONVERSATION) {
      throw new HttpError(
        409,
        `This chat has reached its ${MAX_MESSAGES_PER_CONVERSATION}-message limit. Please start a new chat.`,
      );
    }

    const userRow = (await prisma.ai_messages.create({
      data: { conversation_id: req.params.id, sender_type: "customer", content },
    })) as unknown as AiMessageRow;

    const [knowledgeInputs, requestInputs, account, customerMemory] = await Promise.all([
      loadCallerKnowledge(content),
      loadCallerRequests(user),
      loadCallerAccount(user),
      loadCustomerMemory(user.id, user.role),
    ]);

    const replyStart = Date.now();
    const answer = await generateAssistantReply(
      content,
      knowledgeInputs,
      requestInputs,
      account,
      isStaffRole(user.role),
      customerMemory,
      // Pushed as each model call finishes so the console's token count climbs
      // during the run instead of jumping when the response lands.
      (usage) =>
        void publish(
          { userIds: [user.id] },
          { type: "usage", conversationId: req.params.id, ...usage },
        ),
      preferredProviderId,
    );

    const assistantRow = (await prisma.ai_messages.create({
      data: {
        conversation_id: req.params.id,
        sender_type: "assistant",
        content: answer.text,
        model: answer.model,
      },
    })) as unknown as AiMessageRow;

    // The tool itself never writes anything (AI Boundary Matrix — the
    // toolset stays read-only); this is the one place a drafted escalation
    // actually reaches a human; it's created "awaiting_approval", so nothing
    // is filed until staff act on it via admin/approvals.ts.
    let escalation: ({ approvalId: string; runId: string } & EscalationDraft) | null = null;

    // One agent_runs row per task that involved a model (or fell back from
    // one). It carries the path the task took, which is what the console's
    // flow diagram is rebuilt from — so that history is persistent.
    let run: { id: string } | null = null;
    if (answer.flow) {
      const escalated = Boolean(answer.escalationDraft);
      try {
        run = await prisma.agent_runs.create({
          data: {
            customer_id: user.id,
            conversation_id: req.params.id,
            status: escalated ? "awaiting_approval" : answer.flow.kind === "fallback" ? "failed" : "completed",
            current_step: escalated ? "draft_escalation_ticket" : "respond",
            iterations: answer.trace?.filter((s) => s.phase === "plan").length ?? 0,
            model: answer.flow.model,
            prompt_version: SYSTEM_PROMPT_VERSION,
            completed_at: escalated ? null : new Date(),
            error_message: answer.flow.failureReason ?? null,
            // The structured draft rides along so approving it can file the real request.
            tool_input: { ...answer.flow, ...(answer.escalationDraft ? { escalationDraft: answer.escalationDraft } : {}) } as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        // A drafted escalation needs its run row to be reviewable, so that
        // failure surfaces; plain history must never cost the user their answer.
        if (escalated) throw err;
        console.error("Failed to record agent run:", err);
      }
    }

    let timeline: Awaited<ReturnType<typeof writeTraceLog>> = [];
    if (run) {
      timeline = await writeTraceLog(run.id, answer, { query: content, promptVersion: SYSTEM_PROMPT_VERSION, totalLatencyMs: Date.now() - replyStart });
    }

    if (answer.escalationDraft && run) {
      const approval = await prisma.agent_approvals.create({
        data: {
          agent_run_id: run.id,
          requested_action: formatEscalationDraft(answer.escalationDraft),
          reason: answer.escalationDraft.suggestedAction,
          status: "pending",
        },
      });
      escalation = { approvalId: approval.id, runId: run.id, ...answer.escalationDraft };
      await notifyStaff(
        {
          type: "ai",
          title: "Approval needed",
          message: `The assistant drafted an escalation: ${answer.escalationDraft.title}`,
        },
        user.id,
      );
    }

    if (run) {
      publishEvent("agent.run.completed", { runId: run.id, conversationId: req.params.id, escalated: Boolean(escalation) });
      if (escalation) publishEvent("approval.requested", { approvalId: escalation.approvalId, runId: run.id, title: escalation.title });
    }

    res.status(201).json({
      userMessage: mapChatMessageRow(userRow),
      assistantMessage: mapChatMessageRow(assistantRow),
      suggestions: answer.suggestions,
      steps: answer.steps,
      sources: answer.sources,
      trace: answer.trace ?? [],
      timeline,
      handoffs: answer.steps.filter((s) => s.startsWith("Handoff:")),
      // From the model-call events, not the saved timeline: the timeline is
      // empty when no run row was recorded, which would report 0 for a real call.
      tokens: {
        input: (answer.traceEvents ?? []).reduce((n, e) => n + (e.inputTokens ?? 0), 0),
        output: (answer.traceEvents ?? []).reduce((n, e) => n + (e.outputTokens ?? 0), 0),
      },
      fallbackReason: answer.fallbackReason ?? null,
      knowledgeCount: new Set(knowledgeInputs.map((k) => k.id)).size,
      openRequestCount: requestInputs.length,
      escalation,
    });
  }),
);

/**
 * Any signed-in user (customers included): reads an uploaded PDF/text file and
 * has the model summarise it. Nothing is stored — the file is read from memory
 * and discarded. Adding a document to the knowledge base stays staff-only
 * (POST /admin/knowledge).
 */
router.post(
  "/summarize-document",
  summaryUpload.single("file"),
  asyncRoute(async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) throw badRequest("A file is required");
    if (!isIndexable(resolveMimeType(file.mimetype, file.originalname), file.originalname)) {
      throw badRequest("Only PDF, Word (.docx) and plain-text files can be summarised");
    }

    const { providerId } = req.body as { providerId?: string };
    let preferredProviderId: string | undefined;
    if (providerId?.trim()) {
      const chosen = await prisma.agent_providers.findUnique({ where: { id: providerId }, select: { status: true } });
      if (!chosen) throw badRequest("The selected model is not registered");
      if (chosen.status !== "active") throw badRequest("The selected model is disabled");
      preferredProviderId = providerId;
    }

    const pages = await extractPages(file.buffer, resolveMimeType(file.mimetype, file.originalname), file.originalname);
    if (pages.length === 0) throw badRequest("No readable text was found in that file");
    const full = pages.map((p) => `[Page ${p.page}]\n${p.text.trim()}`).join("\n\n");
    const truncated = full.length > SUMMARY_MAX_CHARS;

    try {
      const result = await completeWithFallback(
        [
          {
            role: "system",
            content:
              "You summarise documents for a customer-support team. Give a short overview, then the key points as bullets, then any deadlines, amounts or required actions. Use only what the document says and cite page numbers like (p. 3) where useful.",
          },
          { role: "user", content: `Summarise this document (${file.originalname}):\n\n${full.slice(0, SUMMARY_MAX_CHARS)}` },
        ],
        undefined,
        [],
        preferredProviderId,
      );
      res.json({
        summary: result.content ?? "",
        fileName: file.originalname,
        pages: pages.length,
        truncated,
        model: result.model,
        provider: result.providerName,
      });
    } catch (err) {
      if (err instanceof GatewayUnavailableError) throw new HttpError(503, err.message);
      throw err;
    }
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
