import { Router, type Request, type Response } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncRoute } from "../middleware/error-handler.js";

const router = Router();

/**
 * Copy the customer app used to hard-code: { onboarding, privacy, support,
 * chat, request_status_copy }, one entry per app_content row. Public (mounted
 * before requireAuth) because onboarding is shown before sign-in.
 */
router.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const rows = await prisma.app_content.findMany();
    res.set("Cache-Control", "public, max-age=300");
    res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  }),
);

export default router;
