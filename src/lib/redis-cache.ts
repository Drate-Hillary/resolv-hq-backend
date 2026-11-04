import { redis } from "./redis.js";

const inFlightLoads = new Map<string, Promise<unknown>>();

/**
 * Redis-backed read-through cache. Redis failures are logged and treated as
 * cache misses; database loader failures still propagate to the caller.
 */
export async function getOrLoadRedisCache<T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  try {
    const cached = await redis.get(key);
    if (cached !== null) {
      try {
        return JSON.parse(cached) as T;
      } catch (err) {
        console.error(`Redis cache entry "${key}" is invalid JSON; refreshing it:`, err);
        await redis.del(key).catch((deleteError: unknown) => {
          console.error(`Could not delete invalid Redis cache entry "${key}":`, deleteError);
        });
      }
    }
  } catch (err) {
    console.error(`Redis cache read failed for "${key}", loading from the database:`, err);
  }

  const pending = inFlightLoads.get(key);
  if (pending) return pending as Promise<T>;

  const loadPromise = load().then(async (value) => {
    try {
      await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } catch (err) {
      console.error(`Redis cache write failed for "${key}":`, err);
    }
    return value;
  });

  inFlightLoads.set(key, loadPromise);
  try {
    return await loadPromise;
  } finally {
    if (inFlightLoads.get(key) === loadPromise) inFlightLoads.delete(key);
  }
}

export async function invalidateRedisCache(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch (err) {
    console.error(`Redis cache invalidation failed for "${key}":`, err);
  }
}
