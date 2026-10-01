import { Router, type Request, type Response } from "express";
import multer from "multer";
import { classifyRequest } from "../lib/ai.js";
import { requireRole } from "../lib/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import {
  getAttachmentSignedUrl,
  isAllowedAttachmentType,
  MAX_ATTACHMENT_BYTES,
  uploadAttachmentFile,
} from "../lib/attachment-storage.js";
import { buildTimeline, mapAttachmentRow, mapMessageRow, mapRequestRow, priorityToDb, resolveCategoryId } from "../lib/mappers.js";
import { notifyStaff, notifyUsers } from "../lib/notify.js";
import { assertRequestAccess } from "../lib/ownership.js";
import { isNotFound } from "../lib/prisma-errors.js";
import { finalStatusIds, loadStatuses, statusIdByName } from "../lib/statuses.js";
import { prisma } from "../lib/prisma.js";
import { asyncRoute } from "../middleware/error-handler.js";
import type { RequestAttachment, RequestCategoryOption } from "../types/api.js";
import type { RequestMessageRow, RequestRow, RequestStatusHistoryRow } from "../types/database.types.js";

const router = Router();

const attachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES } });

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
  asyncRoute(async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const { description, categoryId } = req.body as { description?: string; categoryId?: string | null };
    if (!description) throw badRequest("description is required");

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
      },
    })) as unknown as RequestRow;

    const messageRow = (await prisma.request_messages.create({
      data: { request_id: requestRow.id, sender_type: "customer", sender_id: userId, message: description },
    })) as unknown as RequestMessageRow;

    const categoryName = categories.find((c) => c.id === resolvedCategoryId)?.name ?? category;

    await notifyStaff(
      {
        type: "request_update",
        title: priority === "high" ? "New high-priority request" : "New request",
        message: `${categoryName}: ${description.slice(0, 120)}`,
        requestId: requestRow.id,
      },
      userId,
    );

    res.status(201).json({
      ...mapRequestRow(requestRow, categoryName, "submitted"),
      messages: [mapMessageRow(messageRow)],
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
    if (!isAllowedAttachmentType(file.mimetype)) {
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

    const storagePath = await uploadAttachmentFile(req.params.id, file.buffer, file.originalname, file.mimetype);
    const row = await prisma.request_attachments.create({
      data: {
        request_id: req.params.id,
        message_id: messageId,
        uploaded_by: user.id,
        file_name: file.originalname,
        file_type: file.mimetype,
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

    res.status(201).json(mapAttachmentRow(row, await getAttachmentSignedUrl(storagePath)));
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
  asyncRoute(async (req: Request, res: Response) => {
    const user = req.user!;
    const access = await assertRequestAccess(req.params.id, user);
    const { text } = req.body as { text?: string };
    if (!text) throw badRequest("text is required");

    const data = (await prisma.request_messages.create({
      data: {
        request_id: req.params.id,
        sender_type: senderTypeFor(user.role),
        sender_id: user.id,
        message: text,
      },
    })) as unknown as RequestMessageRow;

    const preview = text.length > 120 ? `${text.slice(0, 117)}…` : text;
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
        select: { assigned_agent_id: true },
      });
      const message = { type: "support" as const, title: "Customer replied", message: preview, requestId: req.params.id };
      if (owner?.assigned_agent_id) await notifyUsers([owner.assigned_agent_id], message, user.id);
      else await notifyStaff(message, user.id);
    }
    res.status(201).json(mapMessageRow(data));
  }),
);

export default router;
