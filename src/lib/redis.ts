import { Redis } from "ioredis";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * Single shared client for both rate limiting (middleware/rate-limit.ts)
 * and LLM response caching (lib/llm/gateway.ts). ioredis queues commands and
 * reconnects on its own — every caller here still wraps its own calls in
 * try/catch and fails open, so a missing/unreachable Redis degrades
 * rate limiting and caching rather than taking the API down.
 */
export const redis = new Redis(url, {
  maxRetriesPerRequest: 2,
  retryStrategy: (times) => Math.min(times * 200, 2000),
  lazyConnect: true,
});

redis.on("error", (err) => {
  console.error("Redis error (rate limiting/caching will fail open):", err.message);
});

redis.connect().catch((err) => {
  console.error(`Could not connect to Redis at ${url} — rate limiting/caching disabled until it's reachable:`, err.message);
});
