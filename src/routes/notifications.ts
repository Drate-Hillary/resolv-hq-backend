import { Router, type Request, type Response } from "express";
import { notFound } from "../lib/errors.js";
import { mapNotificationRow } from "../lib/mappers.js";
import { prisma } from "../lib/prisma.js";
import { asyncRoute } from "../middleware/error-handler.js";
import type { NotificationRow } from "../types/database.types.js";

const router = Router();

/**
 * Every authenticated role has its own inbox (customers: request updates;
 * staff: new requests, customer replies, approvals) — always scoped to
 * req.user, never a client-supplied id. Newest 100 only.
 */
router.get(
  "/",
  asyncRoute(async (req: Request, res: Response) => {
    const data = (await prisma.notifications.findMany({
      where: { user_id: req.user!.id },
      orderBy: { created_at: "desc" },
      take: 100,
    })) as unknown as NotificationRow[];
    res.json(data.map(mapNotificationRow));
  }),
);

/** Scoped by user_id, not just id, so a customer can't mark another
 * customer's notification read by guessing an id. */
router.patch(
  "/:id/read",
  asyncRoute(async (req: Request, res: Response) => {
    const existing = await prisma.notifications.findFirst({
      where: { id: req.params.id, user_id: req.user!.id },
    });
    if (!existing) throw notFound("Notification not found");

    const data = (await prisma.notifications.update({
      where: { id: req.params.id },
      data: { is_read: true },
    })) as unknown as NotificationRow;
    res.json(mapNotificationRow(data));
  }),
);

router.patch(
  "/read-all",
  asyncRoute(async (req: Request, res: Response) => {
    await prisma.notifications.updateMany({
      where: { user_id: req.user!.id, is_read: false },
      data: { is_read: true },
    });
    res.json({ ok: true });
  }),
);

export default router;
