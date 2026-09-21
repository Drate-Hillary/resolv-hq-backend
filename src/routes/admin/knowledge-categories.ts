import type { Request, Response } from "express";
import { Router } from "express";
import { requireRole } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { db } from "../../lib/supabase.js";
import { asyncRoute } from "../../middleware/error-handler.js";

const router = Router();
router.use(requireRole("staff"));

router.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const { data, error } = await db.from("knowledge_categories").select("*").order("name", { ascending: true });
    if (error) throw error;
    res.json(data ?? []);
  }),
);

router.post(
  "/",
  asyncRoute(async (req: Request, res: Response) => {
    const { name, description = null } = req.body as { name?: string; description?: string | null };
    if (!name?.trim()) throw badRequest("name is required");

    const { data, error } = await db
      .from("knowledge_categories")
      .insert({ name: name.trim(), description })
      .select("*")
      .single();
    if (error) throw error.code === "23505" ? badRequest("A category with that name already exists") : error;

    res.json(data);
  }),
);

router.patch(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    const { name, description } = req.body as { name?: string; description?: string | null };
    if (name === undefined && description === undefined) throw badRequest("Nothing to update");
    if (name !== undefined && !name.trim()) throw badRequest("name cannot be empty");

    const update: { name?: string; description?: string | null } = {};
    if (name !== undefined) update.name = name.trim();
    if (description !== undefined) update.description = description;

    const { data, error } = await db
      .from("knowledge_categories")
      .update(update)
      .eq("id", req.params.id)
      .select("*")
      .single();
    if (error || !data) throw notFound("Category not found");

    res.json(data);
  }),
);

// knowledge_documents.category_id is ON DELETE SET NULL, so documents in
// this category are simply uncategorized afterward, not deleted.
router.delete(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    const { error, count } = await db
      .from("knowledge_categories")
      .delete({ count: "exact" })
      .eq("id", req.params.id);
    if (error) throw error;
    if (!count) throw notFound("Category not found");

    res.status(204).end();
  }),
);

export default router;
