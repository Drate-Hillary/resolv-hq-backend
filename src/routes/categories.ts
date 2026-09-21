import { Router, type Request, type Response } from "express";
import { mapCategoryRow } from "../lib/mappers.js";
import { db } from "../lib/supabase.js";
import { asyncRoute } from "../middleware/error-handler.js";

const router = Router();

router.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const { data, error } = await db.from("request_categories").select("*").order("name", { ascending: true });
    if (error) throw error;
    res.json((data ?? []).map(mapCategoryRow));
  }),
);

export default router;
