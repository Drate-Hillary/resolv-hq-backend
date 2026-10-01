import { Router, type Request, type Response } from "express";
import { mapCategoryRow } from "../lib/mappers.js";
import { prisma } from "../lib/prisma.js";
import { asyncRoute } from "../middleware/error-handler.js";

const router = Router();

router.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const data = await prisma.request_categories.findMany({ orderBy: { name: "asc" } });
    res.json(data.map(mapCategoryRow));
  }),
);

export default router;
