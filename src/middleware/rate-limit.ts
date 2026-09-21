// Fixed-window rate limiting backed by Redis (INCR + PEXPIRE), so limits
// hold across restarts and multiple backend instances instead of resetting
// per-process like an in-memory counter would. Scoped per caller: the
// authenticated user's id once requireAuth has run, or their IP before that
// (e.g. /health). Fails open on a Redis error — a rate limiter that can take
// the whole API down when its store is unreachable is worse than no limiter.
import type { NextFunction, Request, Response } from "express";
import { redis } from "../lib/redis.js";

export interface RateLimitOptions {
  /** Requests allowed per window. */
  max: number;
  windowMs: number;
  /** Distinguishes this limiter's keys/headers from any other mounted elsewhere. */
  keyPrefix: string;
}

export function rateLimit(options: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const identifier = req.user?.id ?? req.ip ?? "unknown";
    const key = `ratelimit:${options.keyPrefix}:${identifier}`;

    try {
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.pexpire(key, options.windowMs);
      }
      const ttlMs = await redis.pttl(key);

      res.setHeader("X-RateLimit-Limit", String(options.max));
      res.setHeader("X-RateLimit-Remaining", String(Math.max(0, options.max - count)));

      if (count > options.max) {
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil(ttlMs / 1000))));
        res.status(429).json({ error: "Too many requests — please slow down and try again shortly." });
        return;
      }
    } catch (err) {
      console.error(`rate-limit(${options.keyPrefix}) Redis error, failing open:`, err);
    }

    next();
  };
}
