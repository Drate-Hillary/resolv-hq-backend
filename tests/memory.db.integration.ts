// Opt-in integration test against the REAL database (DATABASE_URL).
//   npm run test:db
// It acts as an existing customer by injecting req.user (no tokens, no auth
// changes), writes one clearly named fact, and deletes exactly that fact in a
// finally block. It does not touch the audit log or any other table, and the
// retention check is a dry run (counts only).
import "dotenv/config";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import { loadCustomerMemory } from "../src/lib/customer-memory.js";
import { prisma } from "../src/lib/prisma.js";
import { purgeExpired } from "../src/lib/retention.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import memoryRouter from "../src/routes/memory.js";

const KEY = "zz_selftest_do_not_use";
let customerId = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
let base = "";

const call = (method: string, path: string, body?: unknown) =>
  fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

before(async () => {
  const profile = await prisma.customer_profiles.findFirst({ select: { user_id: true } });
  assert.ok(profile, "no customer profile exists to test with");
  customerId = profile.user_id;
  await prisma.customer_memory.deleteMany({ where: { customer_id: customerId, memory_key: KEY } });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: customerId, role: "customer" } as never;
    next();
  });
  app.use("/memory-facts", memoryRouter);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await prisma.customer_memory.deleteMany({ where: { customer_id: customerId, memory_key: KEY } });
  server?.close();
  await prisma.$disconnect();
});

test("real database: create, duplicate, update, export, loader, delete", async () => {
  const created = await call("POST", "/memory-facts", { key: KEY, value: "first" });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: string };

  assert.equal((await call("POST", "/memory-facts", { key: KEY, value: "again" })).status, 409);

  const before = await prisma.customer_memory.findUniqueOrThrow({ where: { id } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await call("PATCH", `/memory-facts/${id}`, { value: "second" })).status, 200);
  const after = await prisma.customer_memory.findUniqueOrThrow({ where: { id } });
  assert.equal(after.memory_value, "second");
  assert.ok(after.updated_at! > before.updated_at!, "updated_at should advance on update");

  const exported = (await (await call("GET", "/memory-facts/export")).json()) as { facts: { key: string; value: string }[] };
  assert.ok(exported.facts.some((f) => f.key === KEY && f.value === "second"));

  const profile = await prisma.customer_profiles.findUniqueOrThrow({ where: { user_id: customerId }, select: { memory_enabled: true } });
  const loaded = await loadCustomerMemory(customerId, "customer");
  assert.equal(loaded.some((f) => f.key === KEY), profile.memory_enabled);

  assert.equal((await call("DELETE", `/memory-facts/${id}`)).status, 204);
  assert.equal(await prisma.customer_memory.count({ where: { id } }), 0);
});

test("real database: retention dry run runs and deletes nothing", async () => {
  const counts = async () => [
    await prisma.customer_memory.count(),
    await prisma.customer_memory_access_logs.count(),
    await prisma.ai_conversations.count(),
  ];
  const beforeCounts = await counts();
  const result = await purgeExpired({ dryRun: true });
  assert.equal(result.dryRun, true);
  assert.deepEqual(await counts(), beforeCounts);
});
