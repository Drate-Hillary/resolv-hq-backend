import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { MulterError } from "multer";
import { HttpError } from "../lib/errors.js";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }

  if (err instanceof MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE" ? "File is too large" : err.message;
    res.status(400).json({ error: message });
    return;
  }

  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};

/**
 * Wraps an async route handler so a thrown/rejected error reaches
 * errorHandler. Fixed to Express's own Request/Response (no generics) —
 * an earlier generic `<Req, Res>` version couldn't be inferred from a bare
 * `async (req, res) => ...` callback and silently fell back to `unknown`
 * for both params.
 */
export const asyncRoute =
  (handler: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    handler(req, res, next).catch(next);
  };
