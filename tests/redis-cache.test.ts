import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { getOrLoadRedisCache, invalidateRedisCache } from "../src/lib/redis-cache.js";
import { redis } from "../src/lib/redis.js";

const client = redis as unknown as {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, ...args: (string | number)[]) => Promise<string>;
  del: (...keys: string[]) => Promise<number>;
};
const originalMethods = { get: client.get, set: client.set, del: client.del };
let values: Map<string, string>;

beforeEach(() => {
  values = new Map();
  client.get = async (key) => values.get(key) ?? null;
  client.set = async (key, value) => {
    values.set(key, value);
    return "OK";
  };
  client.del = async (...keys) => {
    let deleted = 0;
    for (const key of keys) deleted += Number(values.delete(key));
    return deleted;
  };
});

after(() => {
  Object.assign(client, originalMethods);
  redis.disconnect();
});

test("read-through cache reuses Redis values and refreshes after invalidation", async () => {
  let loads = 0;
  const load = async () => ({ value: ++loads });

  assert.deepEqual(await getOrLoadRedisCache("test:entry", 60, load), { value: 1 });
  assert.deepEqual(await getOrLoadRedisCache("test:entry", 60, load), { value: 1 });
  assert.equal(loads, 1);

  await invalidateRedisCache("test:entry");
  assert.deepEqual(await getOrLoadRedisCache("test:entry", 60, load), { value: 2 });
  assert.equal(loads, 2);
});

test("concurrent cache misses share one database load", async () => {
  let loads = 0;
  const load = async () => {
    loads += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return ["passage"];
  };

  const results = await Promise.all([
    getOrLoadRedisCache("test:concurrent", 60, load),
    getOrLoadRedisCache("test:concurrent", 60, load),
  ]);

  assert.deepEqual(results, [["passage"], ["passage"]]);
  assert.equal(loads, 1);
});

test("Redis errors fall back to the loader while loader errors propagate", async () => {
  client.get = async () => {
    throw new Error("Redis unavailable");
  };
  client.set = async () => {
    throw new Error("Redis unavailable");
  };

  assert.equal(await getOrLoadRedisCache("test:redis-down", 60, async () => "database value"), "database value");
  await assert.rejects(
    getOrLoadRedisCache("test:database-error", 60, async () => {
      throw new Error("database unavailable");
    }),
    /database unavailable/,
  );
});
