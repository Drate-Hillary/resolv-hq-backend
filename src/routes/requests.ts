import { Router, type Request, type RequestHandler, type Response } from "express";
import multer from "multer";
import { classifyRequest, generateAssistantReply, type AiAnswer } from "../lib/ai.js";
import { requireRole } from "../lib/auth.js";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
import {
  getAttachmentSignedUrl,
  isAllowedAttachmentType,
  MAX_ATTACHMENT_BYTES,
  resolveMimeType,
  uploadAttachmentFile,
} from "../lib/attachment-storage.js";
import { buildTimeline, mapAttachmentRow, mapMessageRow, mapRequestRow, priorityToDb, resolveCategoryId } from "../lib/mappers.js";
import { notifyStaff, notifyUsers } from "../lib/notify.js";
import { publishEvent } from "../lib/bus.js";
import { publish } from "../lib/realtime.js";
import { assertRequestAccess } from "../lib/ownership.js";
import { isNotFound } from "../lib/prisma-errors.js";
import { finalStatusIds, loadStatuses, statusIdByName } from "../lib/statuses.js";
import { prisma } from "../lib/prisma.js";
import { isStaffRole, loadCallerAccount, loadCallerKnowledge, loadCallerRequests } from "../lib/agent-tool-context.js";
import { loadCustomerMemory } from "../lib/customer-memory.js";
import { truncateAtBoundary } from "../lib/context-budget.js";
import { createMcpAgentTools } from "../lib/mcp-agent-tools.js";
import { asyncRoute } from "../middleware/error-handler.js";
import { rateLimit } from "../middleware/rate-limit.js";
import type { RequestAttachment, RequestCategoryOption } from "../types/api.js";
import type { RequestMessageRow, RequestRow, RequestStatusHistoryRow } from "../types/database.types.js";

const router = Router();

const attachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES } });
const aiTicketReplyRateLimit = rateLimit({
  keyPrefix: "ticket-ai",
  max: 20,
  windowMs: 60 * 1000,
});
const limitAiTicketCreation: RequestHandler = (req, res, next) => {
  if ((req.body as { responseMode?: string } | undefined)?.responseMode === "ai") {
    void aiTicketReplyRateLimit(req, res, next);
    return;
  }
  next();
};
const limitAiTicketMessages: RequestHandler = (req, res, next) => {
  if (req.user?.role !== "customer") {
    next();
    return;
  }
  prisma.requests
    .findUnique({ where: { id: req.params.id }, select: { response_mode: true } })
    .then((ticket) => {
      if (ticket?.response_mode === "ai") return aiTicketReplyRateLimit(req, res, next);
      next();
    })
    .catch(next);
};

/** A request's attachments, newest last, each with a fresh short-lived signed URL. */
async function loadAttachments(requestId: string): Promise<RequestAttachment[]> {
  const rows = await prisma.request_attachments.findMany({
    where: { request_id: requestId },
    orderBy: { created_at: "asc" },
  });
  return Promise.all(rows.map(async (row) => mapAttachmentRow(row, await getAttachmentSignedUrl(row.storage_path))));
}

function isStaff(role: string): boolean {
  return role === "admin" || role === "agent";
}

function senderTypeFor(role: string): "customer" | "admin" | "agent" {
  if (role === "admin") return "admin";
  if (role === "agent") return "agent";
  return "customer";
}

async function loadCategories(): Promise<RequestCategoryOption[]> {
  const data = await prisma.request_categories.findMany();
  return data.map((row) => ({ id: row.id, name: row.name, description: row.description }));
}

async function resolveStaffNames(rows: { customer_id: string; assigned_agent_id: string | null }[]) {
  const ids = new Set<string>();
  for (const r of rows) {
    ids.add(r.customer_id);
    if (r.assigned_agent_id) ids.add(r.assigned_agent_id);
  }
  const nameById = new Map<string, string | null>();
  if (ids.size === 0) return nameById;
  const data = await prisma.profiles.findMany({
    where: { id: { in: Array.from(ids) } },
    select: { id: true, first_name: true, last_name: true },
  });
  for (const p of data) nameById.set(p.id, [p.first_name, p.last_name].filter(Boolean).join(" ") || null);
  return nameById;
}

/** Full ServiceRequest detail: row + category/status name + messages/history. */
async function loadRequestDetail(id: string, user: { role: string }) {
  const statuses = await loadStatuses();
  const statusNameById = new Map(statuses.map((s) => [s.id, s.name]));

  const [row, categories, messages, history, attachments] = await Promise.all([
    prisma.requests.findUnique({ where: { id } }) as unknown as Promise<RequestRow | null>,
    loadCategories(),
    prisma.request_messages.findMany({
      where: { request_id: id },
      orderBy: { created_at: "asc" },
    }) as unknown as Promise<RequestMessageRow[]>,
    prisma.request_status_history.findMany({
      where: { request_id: id },
      orderBy: { created_at: "asc" },
    }) as unknown as Promise<RequestStatusHistoryRow[]>,
    loadAttachments(id),
  ]);
  if (!row) throw notFound("Request not found");

  const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
  const categoryName = row.category_id ? categoryMap.get(row.category_id) ?? null : null;
  const statusName = row.status_id ? statusNameById.get(row.status_id) ?? "unknown" : "unknown";

  let staffExtra: { customerName?: string | null; assignedAgentName?: string | null } | undefined;
  if (isStaff(user.role)) {
    const nameById = await resolveStaffNames([row]);
    staffExtra = {
      customerName: nameById.get(row.customer_id) ?? null,
      assignedAgentName: row.assigned_agent_id ? nameById.get(row.assigned_agent_id) ?? null : null,
    };
  }

  return {
    ...mapRequestRow(row, categoryName, statusName, staffExtra),
    messages: messages.map((msg) => ({
      ...mapMessageRow(msg),
      attachments: attachments.filter((a) => a.messageId === msg.id),
    })),
    attachments,
    timeline: buildTimeline(history, row.created_at, statusNameById),
  };
}

async function generateTicketAiReply(
  requestId: string,
  ticket: Pick<RequestRow, "ticket_number" | "title" | "description">,
  user: Parameters<typeof loadCallerAccount>[0],
  latestCustomerMessage: string,
) {
  const [knowledge, activeRequests, account, customerMemory, history] = await Promise.all([
    loadCallerKnowledge(latestCustomerMessage),
    loadCallerRequests(user),
    loadCallerAccount(user),
    loadCustomerMemory(user.id, user.role),
    prisma.request_messages.findMany({
      where: { request_id: requestId },
      orderBy: { created_at: "desc" },
      take: 12,
      select: { sender_type: true, message: true },
    }),
  ]);
  const transcript = truncateAtBoundary(
    history
      .reverse()
      .filter((message) => message.message.trim().length > 0)
      .map((message) => {
        const speaker =
          message.sender_type === "customer"
            ? "Customer"
            : message.sender_type === "assistant"
              ? "AI assistant"
              : "Support";
        return `${speaker}: ${message.message}`;
      })
      .join("\n"),
    4000,
  );
  const query = [
    `Reply to the customer's latest message in support ticket #${ticket.ticket_number}.`,
    `Ticket title: ${ticket.title}`,
    `Original issue: ${truncateAtBoundary(ticket.description, 2000)}`,
    "Recent conversation:",
    transcript,
    `Latest customer message: ${truncateAtBoundary(latestCustomerMessage, 4000)}`,
    "Answer the latest message directly, using the earlier conversation only as context.",
    "This is already an open support ticket; do not draft a second ticket.",
  ].join("\n\n");
  const mcpTools = await createMcpAgentTools(user);
  let answer: AiAnswer;
  try {
    answer = await generateAssistantReply(
      query,
      knowledge,
      activeRequests,
      account,
      isStaffRole(user.role),
      customerMemory,
      undefined,
      undefined,
      false,
      mcpTools,
    );
  } finally {
    await mcpTools.close();
  }
  const assistantRow = (await prisma.request_messages.create({
    data: {
      request_id: requestId,
      sender_type: "assistant",
      sender_id: null,
      message: answer.text,
    },
  })) as unknown as RequestMessageRow;
  const aiReply = mapMessageRow(assistantRow);

  void publish(
    { userIds: [user.id], staff: true },
    { type: "message", requestId, message: aiReply },
  );
  await notifyUsers(
    [user.id],
    {
      type: "ai",
      title: "AI assistant replied",
      message: answer.text.length > 120 ? `${answer.text.slice(0, 117)}…` : answer.text,
      requestId,
    },
  );
  return aiReply;
}

/**
 * Customer: only their own requests, newest first.
 * Staff (admin/agent): the open queue across every customer, oldest first —
 * intentional, not a missing filter (see ownership.ts).
 */
router.get(
  "/",
  asyncRoute(async (req: Request, res: Response) => {
    const user = req.user!;
    const [categories, statuses] = await Promise.all([loadCategories(), loadStatuses()]);
    const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
    const statusNameById = new Map(statuses.map((s) => [s.id, s.name]));

    let rows: RequestRow[];
    if (isStaff(user.role)) {
      const finalIds = await finalStatusIds();
      rows = (await prisma.requests.findMany({
        where: finalIds.length > 0 ? { status_id: { notIn: finalIds } } : undefined,
        orderBy: { created_at: "asc" },
      })) as unknown as RequestRow[];
    } else {
      rows = (await prisma.requests.findMany({
        where: { customer_id: user.id },
        orderBy: { created_at: "desc" },
      })) as unknown as RequestRow[];
    }

    if (isStaff(user.role)) {
      const nameById = await resolveStaffNames(rows);
      res.json(
        rows.map((row) =>
          mapRequestRow(
            row,
            row.category_id ? categoryMap.get(row.category_id) ?? null : null,
            row.status_id ? statusNameById.get(row.status_id) ?? "unknown" : "unknown",
            {
              customerName: nameById.get(row.customer_id) ?? null,
              assignedAgentName: row.assigned_agent_id ? nameById.get(row.assigned_agent_id) ?? null : null,
            },
          ),
        ),
      );
      return;
    }

    res.json(
      rows.map((row) =>
        mapRequestRow(
          row,
          row.category_id ? categoryMap.get(row.category_id) ?? null : null,
          row.status_id ? statusNameById.get(row.status_id) ?? "unknown" : "unknown",
        ),
      ),
    );
  }),
);

/** Customer-only, per the source app's createRequest — customer_id is always req.user.id, never trusted from the body. */
router.post(
  "/",
  requireRole("customer"),
  limitAiTicketCreation,
  asyncRoute(async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const { description, categoryId, responseMode = "human" } = req.body as {
      description?: string;
      categoryId?: string | null;
      responseMode?: string;
    };
    if (!description) throw badRequest("description is required");
    if (responseMode !== "human" && responseMode !== "ai") {
      throw badRequest('responseMode must be "human" or "ai"');
    }

    const [categories, submittedStatusId] = await Promise.all([loadCategories(), statusIdByName("submitted")]);
    const { category, priority } = classifyRequest(description);
    const resolvedCategoryId = categoryId ?? resolveCategoryId(categories, category);

    const requestRow = (await prisma.requests.create({
      data: {
        customer_id: userId,
        category_id: resolvedCategoryId,
        status_id: submittedStatusId,
        title: category,
        description,
        priority: priorityToDb(priority),
        source: "mobile",
        response_mode: responseMode,
      },
    })) as unknown as RequestRow;

    const messageRow = (await prisma.request_messages.create({
      data: { request_id: requestRow.id, sender_type: "customer", sender_id: userId, message: description },
    })) as unknown as RequestMessageRow;
    let aiReply: ReturnType<typeof mapMessageRow> | undefined;
    let aiError: string | undefined;
    if (responseMode === "ai") {
      try {
        aiReply = await generateTicketAiReply(requestRow.id, requestRow, req.user!, description);
      } catch (error) {
        console.error(`AI ticket reply failed for request ${requestRow.id}:`, error);
        aiError = "Your ticket was created, but the AI assistant couldn't reply. Switch to Human mode or try again later.";
      }
    }

    const categoryName = categories.find((c) => c.id === resolvedCategoryId)?.name ?? category;

    if (responseMode === "human") {
      await notifyStaff(
        {
          type: "request_update",
          title: priority === "high" ? "New high-priority request" : "New request",
          message: `${categoryName}: ${description.slice(0, 120)}`,
          requestId: requestRow.id,
        },
        userId,
      );
    }

    publishEvent("request.created", {
      requestId: requestRow.id,
      ticketNumber: String(requestRow.ticket_number),
      title: requestRow.title,
      priority,
      source: "mobile",
    });

    res.status(201).json({
      ...mapRequestRow(requestRow, categoryName, "submitted"),
      messages: [mapMessageRow(messageRow), ...(aiReply ? [aiReply] : [])],
      ...(aiError ? { aiError } : {}),
    });
  }),
);

router.get(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    await assertRequestAccess(req.params.id, req.user!);
    res.json(await loadRequestDetail(req.params.id, req.user!));
  }),
);

router.patch(
  "/:id/response-mode",
  requireRole("customer"),
  asyncRoute(async (req: Request, res: Response) => {
    const { responseMode } = req.body as { responseMode?: string };
    if (responseMode !== "human" && responseMode !== "ai") {
      throw badRequest('responseMode must be "human" or "ai"');
    }

    await assertRequestAccess(req.params.id, req.user!);
    const current = await prisma.requests.findUnique({
      where: { id: req.params.id },
      select: {
        response_mode: true,
        status_id: true,
        closed_at: true,
        title: true,
        description: true,
        ticket_number: true,
      },
    });
    if (!current) throw notFound("Request not found");

    const finalIds = await finalStatusIds();
    if (current.closed_at || (current.status_id && finalIds.includes(current.status_id))) {
      throw new HttpError(409, "Response mode can only be changed while the ticket is open");
    }

    const updated = await prisma.requests.update({
      where: { id: req.params.id },
      data: { response_mode: responseMode, updated_at: new Date() },
    });

    let aiError: string | undefined;
    if (current.response_mode !== responseMode) {
      const lastMessage =
        responseMode === "ai"
          ? await prisma.request_messages.findFirst({
              where: { request_id: req.params.id },
              orderBy: { created_at: "desc" },
              select: { sender_type: true, message: true },
            })
          : null;
      const modeMessageRow = (await prisma.request_messages.create({
        data: {
          request_id: req.params.id,
          sender_type: "system",
          sender_id: null,
          message:
            responseMode === "ai"
              ? "The customer switched this conversation to AI assistant mode. The existing ticket history is preserved."
              : "The customer switched this conversation to Human support. The existing ticket history is preserved for staff follow-up.",
        },
      })) as unknown as RequestMessageRow;
      void publish(
        { userIds: [req.user!.id], staff: true },
        { type: "message", requestId: req.params.id, message: mapMessageRow(modeMessageRow) },
      );

      if (lastMessage?.sender_type === "customer" && lastMessage.message.trim()) {
        try {
          await generateTicketAiReply(req.params.id, current, req.user!, lastMessage.message);
        } catch (error) {
          console.error(`AI ticket reply failed after mode switch for request ${req.params.id}:`, error);
          aiError = "AI mode is on, but the assistant couldn't reply yet. Send another message or switch to Human mode.";
        }
      }
    }

    if (current.response_mode !== responseMode && responseMode === "human") {
      await notifyStaff(
        {
          type: "support",
          title: "Customer requested human support",
          message: `A customer switched "${current.title}" to Human mode.`,
          requestId: req.params.id,
        },
        req.user!.id,
      );
    }

    res.json({ ...(await loadRequestDetail(updated.id, req.user!)), ...(aiError ? { aiError } : {}) });
  }),
);

router.patch(
  "/:id/status",
  requireRole("staff"),
  asyncRoute(async (req: Request, res: Response) => {
    const { status } = req.body as { status?: string };
    if (!status) throw badRequest("status is required");
    const newStatusId = await statusIdByName(status);
    if (!newStatusId) throw badRequest(`Unknown status "${status}"`);

    const current = await prisma.requests.findUnique({
      where: { id: req.params.id },
      select: { status_id: true, customer_id: true },
    });
    if (!current) throw notFound("Request not found");

    const finalIds = await finalStatusIds();
    await prisma.requests.update({
      where: { id: req.params.id },
      data: {
        status_id: newStatusId,
        updated_at: new Date(),
        resolved_at: finalIds.includes(newStatusId) ? new Date() : null,
      },
    });

    await prisma.request_status_history.create({
      data: {
        request_id: req.params.id,
        old_status_id: current.status_id,
        new_status_id: newStatusId,
        changed_by: req.user!.id,
      },
    });

    await notifyUsers(
      [current.customer_id],
      {
        type: finalIds.includes(newStatusId) ? "completed" : "request_update",
        title: finalIds.includes(newStatusId) ? "Request completed" : "Request updated",
        message: `Your request is now "${status}".`,
        requestId: req.params.id,
      },
      req.user!.id,
    );

    res.json(await loadRequestDetail(req.params.id, req.user!));
  }),
);

/** Closing is a distinct, explicit staff action from resolving — a request
 * can be "completed" for a while before staff close it out. Idempotent. */
router.patch(
  "/:id/close",
  requireRole("staff"),
  asyncRoute(async (req: Request, res: Response) => {
    let closed;
    try {
      closed = await prisma.requests.update({
        where: { id: req.params.id },
        data: { closed_at: new Date() },
        select: { customer_id: true },
      });
    } catch (err) {
      if (isNotFound(err)) throw notFound("Request not found");
      throw err;
    }
    await notifyUsers(
      [closed.customer_id],
      { type: "completed", title: "Request closed", message: "Your request has been closed by our team.", requestId: req.params.id },
      req.user!.id,
    );
    res.json(await loadRequestDetail(req.params.id, req.user!));
  }),
);

/** Self-assign only — assigned_agent_id is always req.user.id. */
router.patch(
  "/:id/assign",
  requireRole("staff"),
  asyncRoute(async (req: Request, res: Response) => {
    const before = await prisma.requests.findUnique({
      where: { id: req.params.id },
      select: { customer_id: true, assigned_agent_id: true },
    });
    await prisma.requests.updateMany({
      where: { id: req.params.id },
      data: { assigned_agent_id: req.user!.id },
    });
    // Only announce a real change of owner, not an agent re-claiming their own request.
    if (before && before.assigned_agent_id !== req.user!.id) {
      await notifyUsers(
        [before.customer_id],
        { type: "support", title: "An agent picked up your request", message: "Someone from our team is now working on it.", requestId: req.params.id },
        req.user!.id,
      );
    }
    res.json(await loadRequestDetail(req.params.id, req.user!));
  }),
);

/**
 * Upload a file to a request (optionally tied to one of its messages).
 * Customers can only attach to their own requests (assertRequestAccess);
 * uploaded_by is always req.user, never client-supplied.
 */
router.post(
  "/:id/attachments",
  attachmentUpload.single("file"),
  asyncRoute(async (req: Request, res: Response) => {
    const user = req.user!;
    const access = await assertRequestAccess(req.params.id, user);
    const file = req.file;
    if (!file) throw badRequest("A file is required");
    const mimeType = resolveMimeType(file.mimetype, file.originalname);
    if (!isAllowedAttachmentType(mimeType)) {
      throw badRequest("That file type isn't supported — attach an image, PDF, text, Word or Excel file.");
    }

    const messageIdInput = (req.body as { messageId?: string }).messageId;
    let messageId: string | null = null;
    if (messageIdInput) {
      const message = await prisma.request_messages.findFirst({
        where: { id: messageIdInput, request_id: req.params.id },
        select: { id: true },
      });
      if (!message) throw badRequest("messageId does not belong to this request");
      messageId = message.id;
    }

    const storagePath = await uploadAttachmentFile(req.params.id, file.buffer, file.originalname, mimeType);
    const row = await prisma.request_attachments.create({
      data: {
        request_id: req.params.id,
        message_id: messageId,
        uploaded_by: user.id,
        file_name: file.originalname,
        file_type: mimeType,
        file_size_bytes: file.size,
        storage_path: storagePath,
      },
    });

    // Files uploaded while a request is being filed are already covered by
    // the "new request" notification; anything added afterwards is news for
    // whoever is handling it (or, if staff attached it, for the customer).
    const info = await prisma.requests.findUnique({
      where: { id: req.params.id },
      select: { assigned_agent_id: true, created_at: true },
    });
    const justFiled = info?.created_at ? Date.now() - info.created_at.getTime() < 2 * 60 * 1000 : false;
    if (isStaff(user.role)) {
      await notifyUsers(
        [access.customer_id],
        { type: "support", title: "New attachment", message: `${file.originalname} was added to your request.`, requestId: req.params.id },
        user.id,
      );
    } else if (!justFiled) {
      const note = {
        type: "support" as const,
        title: "New attachment",
        message: `${file.originalname} was added to a request.`,
        requestId: req.params.id,
      };
      if (info?.assigned_agent_id) await notifyUsers([info.assigned_agent_id], note, user.id);
      else await notifyStaff(note, user.id);
    }

    const mapped = mapAttachmentRow(row, await getAttachmentSignedUrl(storagePath));
    // Tell open tickets/chats so the file appears on its message without a reload.
    void publish(
      { userIds: [access.customer_id], staff: true },
      { type: "attachment", requestId: req.params.id, messageId: row.message_id, attachment: mapped },
    );
    res.status(201).json(mapped);
  }),
);

router.get(
  "/:id/attachments",
  asyncRoute(async (req: Request, res: Response) => {
    await assertRequestAccess(req.params.id, req.user!);
    res.json(await loadAttachments(req.params.id));
  }),
);

router.get(
  "/:id/messages",
  asyncRoute(async (req: Request, res: Response) => {
    await assertRequestAccess(req.params.id, req.user!);
    const data = (await prisma.request_messages.findMany({
      where: { request_id: req.params.id },
      orderBy: { created_at: "asc" },
    })) as unknown as RequestMessageRow[];
    res.json(data.map(mapMessageRow));
  }),
);

/** sender_id/sender_type are always derived from req.user — never trusted from the client. */
router.post(
  "/:id/messages",
  limitAiTicketMessages,
  asyncRoute(async (req: Request, res: Response) => {
    const user = req.user!;
    const access = await assertRequestAccess(req.params.id, user);
    const request = await prisma.requests.findUnique({
      where: { id: req.params.id },
      select: {
        response_mode: true,
        title: true,
        description: true,
        ticket_number: true,
        status_id: true,
        closed_at: true,
      },
    });
    if (!request) throw notFound("Request not found");
    const { text = "", forAttachment } = req.body as { text?: string; forAttachment?: boolean };
    // The app posts an empty message first and attaches the file to it, so an
    // attachment-only message may have no text; anything else needs some.
    if (typeof text !== "string" || (!text && forAttachment !== true)) throw badRequest("text is required");
    if (isStaff(user.role) && request.response_mode === "ai") {
      throw new HttpError(409, "This ticket is in AI mode. The customer must switch it to Human mode before staff can reply.");
    }

    const data = (await prisma.request_messages.create({
      data: {
        request_id: req.params.id,
        sender_type: senderTypeFor(user.role),
        sender_id: user.id,
        message: text,
      },
    })) as unknown as RequestMessageRow;

    const mapped = mapMessageRow(data);
    let aiReply: ReturnType<typeof mapMessageRow> | undefined;
    let aiError: string | undefined;

    const finalIds = await finalStatusIds();
    const shouldGenerateAiReply =
      user.role === "customer" &&
      request.response_mode === "ai" &&
      text.trim().length > 0 &&
      !request.closed_at &&
      !(request.status_id && finalIds.includes(request.status_id));

    if (shouldGenerateAiReply) {
      try {
        aiReply = await generateTicketAiReply(req.params.id, request, user, text);
      } catch (error) {
        console.error(`AI ticket reply failed for request ${req.params.id}:`, error);
        aiError = "Your message was saved, but the AI assistant couldn't reply. Switch to Human mode or try again later.";
      }
    }

    // Instant delivery: push the saved message to the customer and every
    // connected staff member (open-queue semantics) before doing anything
    // else. The sender's own tabs get it too; clients de-duplicate by id.
    void publish(
      { userIds: [access.customer_id], staff: true },
      { type: "message", requestId: req.params.id, message: mapped },
    );
    res.status(201).json({ ...mapped, ...(aiReply ? { aiReply } : {}), ...(aiError ? { aiError } : {}) });

    // Notifications are a side effect, so they no longer hold up the reply
    // the sender is waiting on (they used to be awaited before responding).
    const preview = text ? (text.length > 120 ? `${text.slice(0, 117)}…` : text) : "Sent an attachment";
    void (async () => {
      try {
        if (isStaff(user.role)) {
          await notifyUsers(
            [access.customer_id],
            { type: "support", title: "New reply on your request", message: preview, requestId: req.params.id },
            user.id,
          );
        } else {
          // The customer replied: tell whoever owns the request, or the whole
          // staff queue if nobody has picked it up yet.
          const owner = await prisma.requests.findUnique({
            where: { id: req.params.id },
            select: { assigned_agent_id: true, response_mode: true },
          });
          if (owner?.response_mode === "human") {
            const message = { type: "support" as const, title: "Customer replied", message: preview, requestId: req.params.id };
            if (owner.assigned_agent_id) await notifyUsers([owner.assigned_agent_id], message, user.id);
            else await notifyStaff(message, user.id);
          }
        }
      } catch (err) {
        console.error("Failed to send message notifications:", err);
      }
    })();
  }),
);

/**
 * "X is typing…" signal. Nothing is stored — it's pushed straight to the other
 * participants and the client expires it on its own if no further ping
 * arrives. Access is checked exactly like reading the thread, and the sender
 * is always req.user, never a client-supplied id.
 */
router.post(
  "/:id/typing",
  asyncRoute(async (req: Request, res: Response) => {
    const user = req.user!;
    const access = await assertRequestAccess(req.params.id, user);
    const { typing } = req.body as { typing?: boolean };

    void publish(
      { userIds: [access.customer_id], staff: true },
      {
        type: "typing",
        requestId: req.params.id,
        userId: user.id,
        senderType: senderTypeFor(user.role),
        typing: typing !== false,
      },
    );
    res.status(204).end();
  }),
);

export default router;
