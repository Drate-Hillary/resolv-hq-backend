import type { Request, Response } from "express";
import { Router } from "express";
import { requireRole } from "../../lib/auth.js";
import { prisma } from "../../lib/prisma.js";
import { asyncRoute } from "../../middleware/error-handler.js";

const router = Router();
router.use(requireRole("staff"));

router.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const [recordCount, keyGroups] = await Promise.all([
      prisma.customer_memory.count(),
      prisma.customer_memory.groupBy({
        by: ["memory_key"],
        _count: { _all: true },
        orderBy: { memory_key: "asc" },
      }),
    ]);

    res.json({
      recordCount,
      keys: keyGroups.map((group) => ({
        key: group.memory_key,
        recordCount: group._count._all,
      })),
    });
  }),
);

export default router;
