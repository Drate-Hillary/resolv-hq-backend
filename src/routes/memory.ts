import { Router, type Request, type Response } from "express";
import { requireRole } from "../lib/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { mapMemoryRow } from "../lib/mappers.js";
import { prisma } from "../lib/prisma.js";
import { asyncRoute } from "../middleware/error-handler.js";
import type { CustomerMemoryRow } from "../types/database.types.js";

const router = Router();

router.get(
  "/",
  requireRole("customer"),
  asyncRoute(async (req: Request, res: Response) => {
    const data = (await prisma.customer_memory.findMany({
      where: { customer_id: req.user!.id },
      orderBy: { created_at: "asc" },
    })) as unknown as CustomerMemoryRow[];
    res.json(data.map(mapMemoryRow));
  }),
);

router.delete(
  "/",
  requireRole("customer"),
  asyncRoute(async (req: Request, res: Response) => {
    await prisma.customer_memory.deleteMany({
      where: { customer_id: req.user!.id },
    });
    res.status(204).end();
  }),
);

/** Scoped by customer_id, not just id, so a customer can't touch another
 * customer's memory by guessing an id. */
router.patch(
  "/:id",
  requireRole("customer"),
  asyncRoute(async (req: Request, res: Response) => {
    const { value, enabled } = req.body as { value?: string; enabled?: boolean };
    if (value === undefined && enabled === undefined) throw badRequest("value or enabled is required");
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw badRequest("value must be a non-empty string");
    }
    if (enabled !== undefined && typeof enabled !== "boolean") {
      throw badRequest("enabled must be a boolean");
    }

    const existing = await prisma.customer_memory.findFirst({
      where: { id: req.params.id, customer_id: req.user!.id },
    });
    if (!existing) throw notFound("Memory fact not found");

    const data = (await prisma.customer_memory.update({
      where: { id: req.params.id },
      data: {
        ...(value !== undefined ? { memory_value: value.trim() } : {}),
        ...(enabled !== undefined ? { is_enabled: enabled } : {}),
      },
    })) as unknown as CustomerMemoryRow;
    res.json(mapMemoryRow(data));
  }),
);

router.delete(
  "/:id",
  requireRole("customer"),
  asyncRoute(async (req: Request, res: Response) => {
    const { count } = await prisma.customer_memory.deleteMany({
      where: { id: req.params.id, customer_id: req.user!.id },
    });
    if (count === 0) throw notFound("Memory fact not found");
    res.status(204).end();
  }),
);

export default router;
