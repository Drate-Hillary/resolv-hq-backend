import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";
import { Prisma } from "@prisma/client";
import express from "express";
import { loadCustomerMemory } from "../src/lib/customer-memory.js";
import { prisma } from "../src/lib/prisma.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import adminMemoryRouter from "../src/routes/admin/memory.js";
import memoryRouter, { MAX_FACTS_PER_CUSTOMER } from "../src/routes/memory.js";

interface Fact {
  id: string;
  customer_id: string;
  memory_key: string;
  memory_value: string;
  is_enabled: boolean;
  created_at: Date;
  updated_at: Date;
}
type AuditEntry = { actor_id: string; customer_id: string; action: string; memory_record_id?: string };

const CUSTOMER_A = "00000000-0000-4000-8000-00000000000a";
const CUSTOMER_B = "00000000-0000-4000-8000-00000000000b";
const STAFF = "00000000-0000-4000-8000-0000000000ff";

let facts: Fact[];
let masterSwitch: Record<string, boolean>;
let auditLog: AuditEntry[];
let n: number;

const match = (f: Fact, where: Partial<Fact> = {}) =>
  Object.entries(where).every(([k, v]) => (f as unknown as Record<string, unknown>)[k] === v);

// In-memory stand-in for the tables these routes touch. It replaces members of
// the shared prisma instance so the real route and loader code runs unmodified.
const fake = {
  findMany: async ({ where }: { where?: Partial<Fact> } = {}) => facts.filter((f) => match(f, where)),
  findFirst: async ({ where }: { where?: Partial<Fact> } = {}) => facts.find((f) => match(f, where)) ?? null,
  count: async ({ where }: { where?: Partial<Fact> } = {}) => facts.filter((f) => match(f, where)).length,
  create: async ({ data }: { data: Partial<Fact> }) => {
    if (facts.some((f) => f.customer_id === data.customer_id && f.memory_key === data.memory_key)) {
      throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
    }
    const row = { id: `f${++n}`, is_enabled: true, created_at: new Date(), updated_at: new Date(), ...data } as Fact;
    facts.push(row);
    return row;
  },
  update: async ({ where, data }: { where: { id: string }; data: Partial<Fact> }) => {
    const row = facts.find((f) => f.id === where.id)!;
    Object.assign(row, data);
    return row;
  },
  deleteMany: async ({ where }: { where: Partial<Fact> }) => {
    const before = facts.length;
    facts = facts.filter((f) => !match(f, where));
    return { count: before - facts.length };
  },
};

const p = prisma as unknown as Record<string, unknown>;
p.customer_memory = fake;
p.customer_profiles = {
  findUnique: async ({ where }: { where: { user_id: string } }) =>
    where.user_id in masterSwitch ? { memory_enabled: masterSwitch[where.user_id] } : null,
  updateMany: async ({ where, data }: { where: { user_id: string }; data: { memory_enabled: boolean } }) => {
    if (!(where.user_id in masterSwitch)) return { count: 0 };
    masterSwitch[where.user_id] = data.memory_enabled;
    return { count: 1 };
  },
};
p.profiles = {
  findFirst: async ({ where }: { where: { id: string } }) => ({ id: where.id, first_name: "C", last_name: null, email: "c@example.com" }),
};
p.customer_memory_access_logs = {
  create: async ({ data }: { data: AuditEntry }) => {
    auditLog.push(data);
  },
};
p.$transaction = async (fn: (tx: unknown) => unknown) => fn(prisma);

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const id = String(req.headers["x-user"]);
  req.user = { id, role: id === STAFF ? "admin" : "customer" } as never;
  next();
});
app.use("/memory-facts", memoryRouter);
app.use("/admin/memory", adminMemoryRouter);
app.use(errorHandler);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.close();
});

const call = (user: string, method: string, path: string, body?: unknown) =>
  fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-user": user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  facts = [];
  n = 0;
  auditLog = [];
  masterSwitch = { [CUSTOMER_A]: true, [CUSTOMER_B]: true };
});

test("customer can create a fact; it is owned by the caller, not the body", async () => {
  const res = await call(CUSTOMER_A, "POST", "/memory-facts", {
    key: "contact_channel",
    value: " SMS ",
    customer_id: CUSTOMER_B,
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { key: string; value: string; enabled: boolean };
  assert.deepEqual([body.key, body.value, body.enabled], ["contact_channel", "SMS", true]);
  assert.equal(facts[0].customer_id, CUSTOMER_A);
});

test("create validates input and rejects duplicates and the per-customer cap", async () => {
  assert.equal((await call(CUSTOMER_A, "POST", "/memory-facts", { key: "1bad", value: "x" })).status, 400);
  assert.equal((await call(CUSTOMER_A, "POST", "/memory-facts", { key: "ok", value: "  " })).status, 400);
  assert.equal((await call(CUSTOMER_A, "POST", "/memory-facts", { key: "ok", value: "x", enabled: "yes" })).status, 400);
  assert.equal((await call(CUSTOMER_A, "POST", "/memory-facts", { key: "ok", value: "x" })).status, 201);
  assert.equal((await call(CUSTOMER_A, "POST", "/memory-facts", { key: "ok", value: "y" })).status, 409);
  for (let i = 0; i < MAX_FACTS_PER_CUSTOMER; i++) {
    await fake.create({ data: { customer_id: CUSTOMER_A, memory_key: `k${i}`, memory_value: "v" } });
  }
  assert.equal((await call(CUSTOMER_A, "POST", "/memory-facts", { key: "extra", value: "x" })).status, 409);
});

test("staff cannot use the customer API", async () => {
  assert.equal((await call(STAFF, "POST", "/memory-facts", { key: "a", value: "b" })).status, 403);
});

test("customers cannot read, change or delete another customer's facts", async () => {
  const b = await fake.create({ data: { customer_id: CUSTOMER_B, memory_key: "secret", memory_value: "v" } });
  const list = (await (await call(CUSTOMER_A, "GET", "/memory-facts")).json()) as unknown[];
  assert.equal(list.length, 0);
  assert.equal((await call(CUSTOMER_A, "PATCH", `/memory-facts/${b.id}`, { value: "hacked" })).status, 404);
  assert.equal((await call(CUSTOMER_A, "DELETE", `/memory-facts/${b.id}`)).status, 404);
  assert.equal(facts[0].memory_value, "v");
  await call(CUSTOMER_A, "DELETE", "/memory-facts");
  assert.equal(facts.length, 1);
});

test("chat loader: only the owner's enabled facts, only when the master switch is on", async () => {
  await fake.create({ data: { customer_id: CUSTOMER_A, memory_key: "on", memory_value: "1" } });
  await fake.create({ data: { customer_id: CUSTOMER_A, memory_key: "off", memory_value: "2", is_enabled: false } });
  await fake.create({ data: { customer_id: CUSTOMER_B, memory_key: "other", memory_value: "3" } });

  assert.deepEqual(await loadCustomerMemory(CUSTOMER_A, "customer"), [{ key: "on", value: "1" }]);
  assert.deepEqual(await loadCustomerMemory(CUSTOMER_A, "admin"), []);
  masterSwitch[CUSTOMER_A] = false;
  assert.deepEqual(await loadCustomerMemory(CUSTOMER_A, "customer"), []);
});

test("deleting all removes only the caller's facts and later context excludes them", async () => {
  await fake.create({ data: { customer_id: CUSTOMER_A, memory_key: "a", memory_value: "1" } });
  await fake.create({ data: { customer_id: CUSTOMER_B, memory_key: "b", memory_value: "2" } });
  assert.equal((await call(CUSTOMER_A, "DELETE", "/memory-facts")).status, 204);
  assert.deepEqual(await loadCustomerMemory(CUSTOMER_A, "customer"), []);
  assert.equal((await loadCustomerMemory(CUSTOMER_B, "customer")).length, 1);
});

test("staff customer-memory access is audited without values; customers are refused admin routes", async () => {
  assert.equal((await call(CUSTOMER_A, "GET", `/admin/memory/customers/${CUSTOMER_B}`)).status, 403);
  assert.equal(auditLog.length, 0);

  const created = await call(STAFF, "POST", `/admin/memory/customers/${CUSTOMER_A}`, {
    key: "contact_channel",
    value: "sensitive-value",
  });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: string };
  await call(STAFF, "GET", `/admin/memory/customers/${CUSTOMER_A}`);
  await call(STAFF, "PATCH", `/admin/memory/customers/${CUSTOMER_A}/${id}`, { value: "other-value" });
  await call(STAFF, "PATCH", `/admin/memory/customers/${CUSTOMER_A}/preferences`, { memoryEnabled: false });
  await call(STAFF, "DELETE", `/admin/memory/customers/${CUSTOMER_A}/${id}`);

  assert.deepEqual(auditLog.map((l) => l.action), ["created", "viewed", "updated", "master_disabled", "deleted"]);
  assert.ok(auditLog.every((l) => l.actor_id === STAFF && l.customer_id === CUSTOMER_A));
  assert.ok(!JSON.stringify(auditLog).includes("sensitive-value"));
  assert.equal(masterSwitch[CUSTOMER_A], false);
});
