import { Router, type Request, type Response } from "express";
import { classifyRequest } from "../lib/ai.js";
import { badRequest } from "../lib/errors.js";
import { asyncRoute } from "../middleware/error-handler.js";

const router = Router();

/**
 * requests.ts's create handler calls `classifyRequest` in-process rather
 * than hitting this endpoint over HTTP — this route exists for callers
 * (e.g. a future "preview classification before submitting" UI) that want
 * the classification without creating a request.
 */
router.post(
  "/classify",
  asyncRoute(async (req: Request, res: Response) => {
    const { description } = req.body as { description?: string };
    if (!description) throw badRequest("description is required");
    res.json(classifyRequest(description));
  }),
);

export default router;
