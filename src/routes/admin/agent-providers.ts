import type { Request, Response } from "express";
import { Router } from "express";
import { requireRole } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { db } from "../../lib/supabase.js";
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
    const { data, error } = await db.from("agent_providers").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    res.json((data ?? []).map(toPublic));
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

    const { data, error } = await db
      .from("agent_providers")
      .insert({ name, provider, model, api_key })
      .select("*")
      .single();
    if (error || !data) throw error ?? badRequest("Failed to register model");

    res.status(201).json(toPublic(data));
  }),
);

/** Mirrors admin/tools.ts's toggleStatus — flips active/disabled. */
router.patch(
  "/:id/status",
  asyncRoute(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { data: current, error: fetchError } = await db
      .from("agent_providers")
      .select("status")
      .eq("id", id)
      .single();
    if (fetchError || !current) throw notFound("Provider not found");

    const nextStatus = current.status === "active" ? "disabled" : "active";
    const { data, error } = await db
      .from("agent_providers")
      .update({ status: nextStatus })
      .eq("id", id)
      .select("*")
      .single();
    if (error || !data) throw error ?? notFound("Provider not found");

    res.json(toPublic(data));
  }),
);

export default router;
