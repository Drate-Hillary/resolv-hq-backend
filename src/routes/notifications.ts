import { Router, type Request, type Response } from "express";
import { requireRole } from "../lib/auth.js";
import { notFound } from "../lib/errors.js";
import { mapNotificationRow } from "../lib/mappers.js";
import { prisma } from "../lib/prisma.js";
import { asyncRoute } from "../middleware/error-handler.js";
import type { NotificationRow } from "../types/database.types.js";

const router = Router();

router.get(
  "/",
  requireRole("customer"),
  asyncRoute(async (req: Request, res: Response) => {
    const data = (await prisma.notifications.findMany({
      where: { user_id: req.user!.id },
      orderBy: { created_at: "desc" },
    })) as unknown as NotificationRow[];
    res.json(data.map(mapNotificationRow));
  }),
);

/** Scoped by user_id, not just id, so a customer can't mark another
 * customer's notification read by guessing an id. */
router.patch(
  "/:id/read",
  requireRole("customer"),
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
  requireRole("customer"),
  asyncRoute(async (req: Request, res: Response) => {
    await prisma.notifications.updateMany({
      where: { user_id: req.user!.id, is_read: false },
      data: { is_read: true },
    });
    res.json({ ok: true });
  }),
);

export default router;
