import { Router, type Request, type Response } from "express";
import { classifyRequest } from "../lib/ai.js";
import { requireRole } from "../lib/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { buildTimeline, mapMessageRow, mapRequestRow, priorityToDb, resolveCategoryId } from "../lib/mappers.js";
import { assertRequestAccess } from "../lib/ownership.js";
import { finalStatusIds, loadStatuses, statusIdByName } from "../lib/statuses.js";
import { prisma } from "../lib/prisma.js";
import { asyncRoute } from "../middleware/error-handler.js";
import type { RequestCategoryOption } from "../types/api.js";
import type { RequestMessageRow, RequestRow, RequestStatusHistoryRow } from "../types/database.types.js";

const router = Router();

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

  const [row, categories, messages, history] = await Promise.all([
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
    messages: messages.map(mapMessageRow),
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

    await prisma.notifications.create({
      data: {
        user_id: current.customer_id,
        request_id: req.params.id,
        title: "Request updated",
        message: `Your request is now "${status}".`,
      },
    });

    res.json(await loadRequestDetail(req.params.id, req.user!));
  }),
);

/** Self-assign only — assigned_agent_id is always req.user.id. */
router.patch(
  "/:id/assign",
  requireRole("staff"),
  asyncRoute(async (req: Request, res: Response) => {
    await prisma.requests.updateMany({
      where: { id: req.params.id },
      data: { assigned_agent_id: req.user!.id },
    });
    res.json(await loadRequestDetail(req.params.id, req.user!));
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
    await assertRequestAccess(req.params.id, user);
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
    res.status(201).json(mapMessageRow(data));
  }),
);

export default router;
