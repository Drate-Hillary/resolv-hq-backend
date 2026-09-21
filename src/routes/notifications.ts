import { Router, type Request, type Response } from "express";
import { requireRole } from "../lib/auth.js";
import { notFound } from "../lib/errors.js";
import { mapNotificationRow } from "../lib/mappers.js";
import { db } from "../lib/supabase.js";
import { asyncRoute } from "../middleware/error-handler.js";

const router = Router();

router.get(
  "/",
  requireRole("customer"),
  asyncRoute(async (req: Request, res: Response) => {
    const { data, error } = await db
      .from("notifications")
      .select("*")
      .eq("user_id", req.user!.id)
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json((data ?? []).map(mapNotificationRow));
  }),
);

/** Scoped by user_id, not just id, so a customer can't mark another
 * customer's notification read by guessing an id. */
router.patch(
  "/:id/read",
  requireRole("customer"),
  asyncRoute(async (req: Request, res: Response) => {
    const { data, error } = await db
      .from("notifications")
      .update({ is_read: true })
      .eq("id", req.params.id)
      .eq("user_id", req.user!.id)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) throw notFound("Notification not found");
    res.json(mapNotificationRow(data));
  }),
);

router.patch(
  "/read-all",
  requireRole("customer"),
  asyncRoute(async (req: Request, res: Response) => {
    const { error } = await db
      .from("notifications")
      .update({ is_read: true })
      .eq("user_id", req.user!.id)
      .eq("is_read", false);
    if (error) throw error;
    res.json({ ok: true });
  }),
);

export default router;
