import type { Request, Response } from "express";
import { Router } from "express";
import { requireRole } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { isNotFound } from "../../lib/prisma-errors.js";
import { prisma } from "../../lib/prisma.js";
import { asyncRoute } from "../../middleware/error-handler.js";
import type { AgentProviderRow } from "../../types/database.types.js";

const router = Router();
router.use(requireRole("staff"));

/**
 * api_key never leaves this service in full — every response replaces it
 * with the last 4 characters so the console can confirm a key is set
 * without displaying the credential itself (see migrations/0001).
 */
function toPublic(row: AgentProviderRow) {
  const { api_key, ...rest } = row;
  return { ...rest, api_key_last4: api_key.slice(-4) };
}

router.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const data = (await prisma.agent_providers.findMany({
      orderBy: { created_at: "desc" },
    })) as unknown as AgentProviderRow[];
    res.json(data.map(toPublic));
  }),
);

router.post(
  "/",
  asyncRoute(async (req: Request, res: Response) => {
    const { name, provider, model = null, api_key } = req.body as {
      name?: string;
      provider?: string;
      model?: string | null;
      api_key?: string;
    };
    if (!name) throw badRequest("name is required");
    if (!provider) throw badRequest("provider is required");
    if (!api_key) throw badRequest("api_key is required");

    const data = (await prisma.agent_providers.create({
      data: { name, provider, model, api_key },
    })) as unknown as AgentProviderRow;

    res.status(201).json(toPublic(data));
  }),
);

/** Mirrors admin/tools.ts's toggleStatus — flips active/disabled. */
router.patch(
  "/:id/status",
  asyncRoute(async (req: Request, res: Response) => {
    const { id } = req.params;
    const current = await prisma.agent_providers.findUnique({ where: { id }, select: { status: true } });
    if (!current) throw notFound("Provider not found");

    const nextStatus = current.status === "active" ? "disabled" : "active";
    let data: AgentProviderRow;
    try {
      data = (await prisma.agent_providers.update({
        where: { id },
        data: { status: nextStatus },
      })) as unknown as AgentProviderRow;
    } catch (err) {
      if (isNotFound(err)) throw notFound("Provider not found");
      throw err;
    }

    res.json(toPublic(data));
  }),
);

export default router;
