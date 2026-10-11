import type { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { Router } from "express";
import { requireRole } from "../../lib/auth.js";
import { badRequest, HttpError, notFound } from "../../lib/errors.js";
import { isNotFound, isUniqueViolation } from "../../lib/prisma-errors.js";
import { prisma } from "../../lib/prisma.js";
import { AGENT_TOOL_DEFINITIONS } from "../../lib/agent-tools.js";
import { BUILT_IN_TOOL_NAMES, syncBuiltInTools } from "../../lib/tool-registry.js";
import { asyncRoute } from "../../middleware/error-handler.js";

const router = Router();
router.use(requireRole("staff"));

router.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    await syncBuiltInTools();
    const rows = await prisma.agent_tools.findMany({ orderBy: { name: "asc" } });
    // `executable`: has a code handler the agent can run. Registered tools
    // without one are catalogue-only and never offered to the model.
    const definitions = new Map(AGENT_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
    res.json(
      rows.map((row) => ({
        ...row,
        executable: BUILT_IN_TOOL_NAMES.has(row.name),
        inputSchema: definitions.get(row.name)?.parameters ?? null,
      })),
    );
  }),
);

// Tool names are what the model calls, so keep them to a safe identifier shape
// (matches the provider tool-name constraints: letters, digits, _ and -).
const TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function assertValidName(name: string) {
  if (!TOOL_NAME.test(name)) {
    throw badRequest("name must start with a letter and use only letters, digits, _ or - (max 64 chars)");
  }
}

/** Registers a new tool in the registry. */
router.post(
  "/",
  asyncRoute(async (req: Request, res: Response) => {
    const { name, description, requires_approval, is_active } = req.body as {
      name?: string;
      description?: string;
      requires_approval?: boolean;
      is_active?: boolean;
    };
    if (!name?.trim()) throw badRequest("name is required");
    assertValidName(name.trim());

    const insert: Prisma.agent_toolsCreateInput = {
      name: name.trim(),
      description: description?.trim() || null,
      requires_approval: requires_approval ?? false,
      is_active: is_active ?? true,
    };

    try {
      const data = await prisma.agent_tools.create({ data: insert });
      res.status(201).json(data);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, `A tool named "${insert.name}" is already registered`);
      throw err;
    }
  }),
);

router.patch(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    const { name, description, requires_approval, is_active } = req.body as {
      name?: string;
      description?: string | null;
      requires_approval?: boolean;
      is_active?: boolean;
    };

    const update: Prisma.agent_toolsUpdateInput = {};
    if (name !== undefined) {
      if (!name.trim()) throw badRequest("name cannot be empty");
      assertValidName(name.trim());
      update.name = name.trim();
    }
    if (description !== undefined) update.description = description?.trim() || null;
    if (requires_approval !== undefined) update.requires_approval = requires_approval;
    if (is_active !== undefined) update.is_active = is_active;
    if (Object.keys(update).length === 0) throw badRequest("Nothing to update");

    try {
      const data = await prisma.agent_tools.update({ where: { id: req.params.id }, data: update });
      res.json(data);
    } catch (err) {
      if (isNotFound(err)) throw notFound("Tool not found");
      if (isUniqueViolation(err)) throw new HttpError(409, `A tool named "${update.name}" is already registered`);
      throw err;
    }
  }),
);

router.delete(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    await prisma.agent_tools.deleteMany({ where: { id: req.params.id } });
    res.status(204).end();
  }),
);

/** Ported from tools-view's `toggleStatus` — flips active/disabled. */
router.patch(
  "/:id/status",
  asyncRoute(async (req: Request, res: Response) => {
    const { id } = req.params;
    const current = await prisma.agent_tools.findUnique({ where: { id }, select: { is_active: true } });
    if (!current) throw notFound("Tool not found");

    const nextActive = !current.is_active;
    try {
      const data = await prisma.agent_tools.update({ where: { id }, data: { is_active: nextActive } });
      res.json(data);
    } catch (err) {
      if (isNotFound(err)) throw notFound("Tool not found");
      throw err;
    }
  }),
);

export default router;
