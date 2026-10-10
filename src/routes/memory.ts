import { Router, type Request, type Response } from "express";
import { requireRole } from "../lib/auth.js";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
import { validateKeyAndValue } from "../lib/memory-input.js";
import { isUniqueViolation } from "../lib/prisma-errors.js";
import { mapMemoryRow } from "../lib/mappers.js";
import { prisma } from "../lib/prisma.js";
import { asyncRoute } from "../middleware/error-handler.js";
import type { CustomerMemoryRow } from "../types/database.types.js";

const router = Router();

/** Upper bound on facts per customer, so memory stays small and reviewable. */
export const MAX_FACTS_PER_CUSTOMER = 50;

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

/** Portability: everything stored about the caller in this table, as a JSON download. */
router.get(
  "/export",
  requireRole("customer"),
  asyncRoute(async (req: Request, res: Response) => {
    const data = (await prisma.customer_memory.findMany({
      where: { customer_id: req.user!.id },
      orderBy: { created_at: "asc" },
    })) as unknown as CustomerMemoryRow[];
    res.setHeader("Content-Disposition", 'attachment; filename="saved-information.json"');
    res.json({ exportedAt: new Date().toISOString(), facts: data.map(mapMemoryRow) });
  }),
);

router.post(
  "/",
  requireRole("customer"),
  asyncRoute(async (req: Request, res: Response) => {
    const { key, value } = validateKeyAndValue(req.body?.key, req.body?.value);
    const enabled = req.body?.enabled;
    if (enabled !== undefined && typeof enabled !== "boolean") throw badRequest("enabled must be a boolean");

    const count = await prisma.customer_memory.count({ where: { customer_id: req.user!.id } });
    if (count >= MAX_FACTS_PER_CUSTOMER) {
      throw new HttpError(409, `You can save at most ${MAX_FACTS_PER_CUSTOMER} facts`);
    }

    try {
      const created = (await prisma.customer_memory.create({
        data: {
          customer_id: req.user!.id,
          memory_key: key,
          memory_value: value,
          ...(enabled !== undefined ? { is_enabled: enabled } : {}),
        },
      })) as unknown as CustomerMemoryRow;
      res.status(201).json(mapMemoryRow(created));
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, "A fact with that key already exists");
      throw error;
    }
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
        updated_at: new Date(),
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
