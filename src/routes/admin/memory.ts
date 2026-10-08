import type { Request, Response } from "express";
import { Router } from "express";
import { requireRole } from "../../lib/auth.js";
import { badRequest, HttpError, notFound } from "../../lib/errors.js";
import { mapMemoryRow } from "../../lib/mappers.js";
import { isUniqueViolation } from "../../lib/prisma-errors.js";
import { prisma } from "../../lib/prisma.js";
import { asyncRoute } from "../../middleware/error-handler.js";
import type { CustomerMemoryRow } from "../../types/database.types.js";

const router = Router();
router.use(requireRole("staff"));

const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
const MAX_MEMORY_VALUE_LENGTH = 2000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mapAgentMemory(record: {
  id: string;
  memory_key: string;
  value: string;
  is_enabled: boolean;
}) {
  return { id: record.id, key: record.memory_key, value: record.value, enabled: record.is_enabled };
}

function validateKeyAndValue(key: unknown, value: unknown) {
  if (typeof key !== "string" || !KEY_PATTERN.test(key.trim())) {
    throw badRequest("key must start with a letter and contain only letters, digits, _, . or - (max 64 chars)");
  }
  if (typeof value !== "string" || !value.trim() || value.trim().length > MAX_MEMORY_VALUE_LENGTH) {
    throw badRequest(`value must contain 1 to ${MAX_MEMORY_VALUE_LENGTH} characters`);
  }
  return { key: key.trim(), value: value.trim() };
}

function throwMemoryKeyConflict(error: unknown): void {
  if (isUniqueViolation(error)) {
    throw new HttpError(409, "A memory record with that key already exists in this account");
  }
}

async function requireCustomer(customerId: string) {
  if (!UUID_PATTERN.test(customerId)) throw badRequest("customerId must be a valid id");
  const customer = await prisma.profiles.findFirst({
    where: { id: customerId, role: "customer" },
    select: { id: true, first_name: true, last_name: true, email: true },
  });
  if (!customer) throw notFound("Customer not found");
  return {
    id: customer.id,
    name: [customer.first_name, customer.last_name].filter(Boolean).join(" ") || "Customer",
    email: customer.email,
  };
}

async function recordCustomerMemoryAccess(
  actorId: string,
  customerId: string,
  action: string,
  memoryRecordId?: string,
) {
  await prisma.customer_memory_access_logs.create({
    data: {
      actor_id: actorId,
      customer_id: customerId,
      memory_record_id: memoryRecordId,
      action,
    },
  });
}

router.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const [customerRecordCount, staffRecordCount, keyGroups] = await Promise.all([
      prisma.customer_memory.count(),
      prisma.agent_memory_records.count(),
      prisma.customer_memory.groupBy({
        by: ["memory_key"],
        _count: { _all: true },
        orderBy: { memory_key: "asc" },
      }),
    ]);

    res.json({
      recordCount: customerRecordCount + staffRecordCount,
      customerRecordCount,
      staffRecordCount,
      keys: keyGroups.map((group) => ({
        key: group.memory_key,
        recordCount: group._count._all,
      })),
    });
  }),
);

router.get(
  "/me",
  asyncRoute(async (req: Request, res: Response) => {
    const records = await prisma.agent_memory_records.findMany({
      where: { staff_id: req.user!.id },
      orderBy: { created_at: "asc" },
    });
    res.json(records.map(mapAgentMemory));
  }),
);

router.post(
  "/me",
  asyncRoute(async (req: Request, res: Response) => {
    const { key, value } = validateKeyAndValue(req.body?.key, req.body?.value);
    const enabled = req.body?.enabled;
    if (enabled !== undefined && typeof enabled !== "boolean") throw badRequest("enabled must be a boolean");

    try {
      const record = await prisma.agent_memory_records.create({
        data: {
          staff_id: req.user!.id,
          memory_key: key,
          value,
          ...(enabled !== undefined ? { is_enabled: enabled } : {}),
        },
      });
      res.status(201).json(mapAgentMemory(record));
    } catch (error) {
      throwMemoryKeyConflict(error);
      throw error;
    }
  }),
);

router.patch(
  "/me/:id",
  asyncRoute(async (req: Request, res: Response) => {
    const { key, value, enabled } = req.body as {
      key?: unknown;
      value?: unknown;
      enabled?: unknown;
    };
    if (key === undefined && value === undefined && enabled === undefined) {
      throw badRequest("At least one of key, value, or enabled is required");
    }

    const update: { memory_key?: string; value?: string; is_enabled?: boolean } = {};
    if (key !== undefined || value !== undefined) {
      const existing = await prisma.agent_memory_records.findFirst({
        where: { id: req.params.id, staff_id: req.user!.id },
      });
      if (!existing) throw notFound("Memory record not found");
      const validated = validateKeyAndValue(key ?? existing.memory_key, value ?? existing.value);
      update.memory_key = validated.key;
      update.value = validated.value;
    }
    if (enabled !== undefined) {
      if (typeof enabled !== "boolean") throw badRequest("enabled must be a boolean");
      update.is_enabled = enabled;
    }

    let record: { count: number };
    try {
      record = await prisma.agent_memory_records.updateMany({
        where: { id: req.params.id, staff_id: req.user!.id },
        data: update,
      });
    } catch (error) {
      throwMemoryKeyConflict(error);
      throw error;
    }
    if (record.count === 0) throw notFound("Memory record not found");
    const updated = await prisma.agent_memory_records.findFirst({
      where: { id: req.params.id, staff_id: req.user!.id },
    });
    if (!updated) throw notFound("Memory record not found");
    res.json(mapAgentMemory(updated));
  }),
);

router.delete(
  "/me/:id",
  asyncRoute(async (req: Request, res: Response) => {
    const { count } = await prisma.agent_memory_records.deleteMany({
      where: { id: req.params.id, staff_id: req.user!.id },
    });
    if (count === 0) throw notFound("Memory record not found");
    res.status(204).end();
  }),
);

router.delete(
  "/me",
  asyncRoute(async (req: Request, res: Response) => {
    await prisma.agent_memory_records.deleteMany({ where: { staff_id: req.user!.id } });
    res.status(204).end();
  }),
);

router.get(
  "/customers",
  asyncRoute(async (req: Request, res: Response) => {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    if (search.length < 2) throw badRequest("search must be at least 2 characters");
    if (search.length > 100) throw badRequest("search cannot exceed 100 characters");

    const customers = await prisma.profiles.findMany({
      where: {
        role: "customer",
        OR: [
          { first_name: { contains: search, mode: "insensitive" } },
          { last_name: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
        ],
      },
      select: { id: true, first_name: true, last_name: true, email: true },
      orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
      take: 25,
    });

    res.json(
      customers.map((customer) => ({
        id: customer.id,
        name: [customer.first_name, customer.last_name].filter(Boolean).join(" ") || "Customer",
        email: customer.email,
      })),
    );
  }),
);

router.get(
  "/customers/:customerId",
  asyncRoute(async (req: Request, res: Response) => {
    const customer = await requireCustomer(req.params.customerId);
    const [records, preferences] = await Promise.all([
      prisma.customer_memory.findMany({
        where: { customer_id: customer.id },
        orderBy: { created_at: "asc" },
      }) as unknown as Promise<CustomerMemoryRow[]>,
      prisma.customer_profiles.findUnique({
        where: { user_id: customer.id },
        select: { memory_enabled: true },
      }),
    ]);
    await recordCustomerMemoryAccess(req.user!.id, customer.id, "viewed");
    res.json({
      customer,
      memoryEnabled: preferences?.memory_enabled ?? true,
      facts: records.map(mapMemoryRow),
    });
  }),
);

router.patch(
  "/customers/:customerId/preferences",
  asyncRoute(async (req: Request, res: Response) => {
    const customer = await requireCustomer(req.params.customerId);
    const { memoryEnabled } = req.body as { memoryEnabled?: unknown };
    if (typeof memoryEnabled !== "boolean") throw badRequest("memoryEnabled must be a boolean");

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.customer_profiles.updateMany({
        where: { user_id: customer.id },
        data: { memory_enabled: memoryEnabled },
      });
      if (updated.count === 0) throw notFound("Customer profile not found");
      await tx.customer_memory_access_logs.create({
        data: {
          actor_id: req.user!.id,
          customer_id: customer.id,
          action: memoryEnabled ? "master_enabled" : "master_disabled",
        },
      });
      return tx.customer_profiles.findUnique({
        where: { user_id: customer.id },
        select: { memory_enabled: true },
      });
    });
    res.json({ memoryEnabled: result?.memory_enabled ?? false });
  }),
);

router.post(
  "/customers/:customerId",
  asyncRoute(async (req: Request, res: Response) => {
    const customer = await requireCustomer(req.params.customerId);
    const { key, value } = validateKeyAndValue(req.body?.key, req.body?.value);
    const enabled = req.body?.enabled;
    if (enabled !== undefined && typeof enabled !== "boolean") throw badRequest("enabled must be a boolean");
    try {
      const record = await prisma.$transaction(async (tx) => {
        const created = (await tx.customer_memory.create({
          data: {
            customer_id: customer.id,
            memory_key: key,
            memory_value: value,
            ...(enabled !== undefined ? { is_enabled: enabled } : {}),
          },
        })) as unknown as CustomerMemoryRow;
        await tx.customer_memory_access_logs.create({
          data: {
            actor_id: req.user!.id,
            customer_id: customer.id,
            memory_record_id: created.id,
            action: "created",
          },
        });
        return created;
      });
      res.status(201).json(mapMemoryRow(record));
    } catch (error) {
      throwMemoryKeyConflict(error);
      throw error;
    }
  }),
);

router.patch(
  "/customers/:customerId/:memoryId",
  asyncRoute(async (req: Request, res: Response) => {
    const customer = await requireCustomer(req.params.customerId);
    const { key, value, enabled } = req.body as {
      key?: unknown;
      value?: unknown;
      enabled?: unknown;
    };
    if (key === undefined && value === undefined && enabled === undefined) {
      throw badRequest("At least one of key, value, or enabled is required");
    }
    if (enabled !== undefined && typeof enabled !== "boolean") throw badRequest("enabled must be a boolean");
    const existing = (await prisma.customer_memory.findFirst({
      where: { id: req.params.memoryId, customer_id: customer.id },
    })) as unknown as CustomerMemoryRow | null;
    if (!existing) throw notFound("Memory fact not found");

    const update: { memory_key?: string; memory_value?: string; is_enabled?: boolean } = {};
    if (key !== undefined || value !== undefined) {
      const validated = validateKeyAndValue(key ?? existing.memory_key, value ?? existing.memory_value);
      update.memory_key = validated.key;
      update.memory_value = validated.value;
    }
    if (enabled !== undefined) update.is_enabled = enabled;

    try {
      const record = await prisma.$transaction(async (tx) => {
        const updated = (await tx.customer_memory.update({
          where: { id: existing.id },
          data: update,
        })) as unknown as CustomerMemoryRow;
        await tx.customer_memory_access_logs.create({
          data: {
            actor_id: req.user!.id,
            customer_id: customer.id,
            memory_record_id: updated.id,
            action: "updated",
          },
        });
        return updated;
      });
      res.json(mapMemoryRow(record));
    } catch (error) {
      throwMemoryKeyConflict(error);
      throw error;
    }
  }),
);

router.delete(
  "/customers/:customerId/:memoryId",
  asyncRoute(async (req: Request, res: Response) => {
    const customer = await requireCustomer(req.params.customerId);
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.customer_memory.deleteMany({
        where: { id: req.params.memoryId, customer_id: customer.id },
      });
      if (count === 0) throw notFound("Memory fact not found");
      await tx.customer_memory_access_logs.create({
        data: {
          actor_id: req.user!.id,
          customer_id: customer.id,
          memory_record_id: req.params.memoryId,
          action: "deleted",
        },
      });
    });
    res.status(204).end();
  }),
);

export default router;
