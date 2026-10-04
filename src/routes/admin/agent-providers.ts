import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { Router } from "express";
import { requireRole } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { buildSankey, type AgentFlowRecord } from "../../lib/llm/flow-log.js";
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

/** Declared before any "/:id" route so "flow" isn't read as an id. */
router.get(
  "/flow",
  asyncRoute(async (_req: Request, res: Response) => {
    const runs = await prisma.agent_runs.findMany({
      where: { tool_input: { not: Prisma.DbNull } },
      orderBy: { started_at: "desc" },
      take: 300,
      select: { tool_input: true },
    });
    const flows = runs
      .map((r) => r.tool_input as unknown as AgentFlowRecord | null)
      .filter((f): f is AgentFlowRecord => !!f && (f.kind === "model" || f.kind === "fallback"));
    res.json(buildSankey(flows));
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

/**
 * Partial update — name/provider/model always, api_key only when a
 * non-empty value is sent, so fixing the model doesn't force re-entering
 * the key. status is not handled here; use PATCH /:id/status for that.
 */
router.patch(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, provider, model, api_key } = req.body as {
      name?: string;
      provider?: string;
      model?: string | null;
      api_key?: string;
    };

    const update: Prisma.agent_providersUpdateInput = {};
    if (name !== undefined) {
      if (!name.trim()) throw badRequest("name cannot be empty");
      update.name = name.trim();
    }
    if (provider !== undefined) {
      if (!provider.trim()) throw badRequest("provider cannot be empty");
      update.provider = provider.trim();
    }
    if (model !== undefined) update.model = model?.trim() || null;
    if (api_key !== undefined && api_key.trim()) update.api_key = api_key.trim();
    if (Object.keys(update).length === 0) throw badRequest("Nothing to update");

    let data: AgentProviderRow;
    try {
      data = (await prisma.agent_providers.update({ where: { id }, data: update })) as unknown as AgentProviderRow;
    } catch (err) {
      if (isNotFound(err)) throw notFound("Provider not found");
      throw err;
    }

    res.json(toPublic(data));
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
