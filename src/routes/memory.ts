import { Router, type Request, type Response } from "express";
import { requireRole } from "../lib/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { mapMemoryRow } from "../lib/mappers.js";
import { db } from "../lib/supabase.js";
import { asyncRoute } from "../middleware/error-handler.js";

const router = Router();

router.get(
  "/",
  requireRole("customer"),
  asyncRoute(async (req: Request, res: Response) => {
    const { data, error } = await db
      .from("customer_memory")
      .select("*")
      .eq("customer_id", req.user!.id)
      .order("created_at", { ascending: true });
    if (error) throw error;
    res.json((data ?? []).map(mapMemoryRow));
  }),
);

/** Scoped by customer_id, not just id, so a customer can't touch another
 * customer's memory by guessing an id. */
router.patch(
  "/:id",
  requireRole("customer"),
  asyncRoute(async (req: Request, res: Response) => {
    const { value } = req.body as { value?: string };
    if (typeof value !== "string" || !value.trim()) throw badRequest("value is required");

    const { data, error } = await db
      .from("customer_memory")
      .update({ memory_value: value })
      .eq("id", req.params.id)
      .eq("customer_id", req.user!.id)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) throw notFound("Memory fact not found");
    res.json(mapMemoryRow(data));
  }),
);

router.delete(
  "/:id",
  requireRole("customer"),
  asyncRoute(async (req: Request, res: Response) => {
    const { data, error } = await db
      .from("customer_memory")
      .delete()
      .eq("id", req.params.id)
      .eq("customer_id", req.user!.id)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) throw notFound("Memory fact not found");
    res.status(204).end();
  }),
);

export default router;
