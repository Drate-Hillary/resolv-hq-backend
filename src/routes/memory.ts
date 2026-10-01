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

/** Scoped by customer_id, not just id, so a customer can't touch another
 * customer's memory by guessing an id. */
router.patch(
  "/:id",
  requireRole("customer"),
  asyncRoute(async (req: Request, res: Response) => {
    const { value } = req.body as { value?: string };
    if (typeof value !== "string" || !value.trim()) throw badRequest("value is required");

    const existing = await prisma.customer_memory.findFirst({
      where: { id: req.params.id, customer_id: req.user!.id },
    });
    if (!existing) throw notFound("Memory fact not found");

    const data = (await prisma.customer_memory.update({
      where: { id: req.params.id },
      data: { memory_value: value },
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
