import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";
import express from "express";
import { loadRetentionPolicy, purgeExpired } from "../src/lib/retention.js";
import { prisma } from "../src/lib/prisma.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import adminMemoryRouter from "../src/routes/admin/memory.js";
import memoryRouter from "../src/routes/memory.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-09T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const CUSTOMER = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";
const ADMIN = "00000000-0000-4000-8000-0000000000fe";
const AGENT = "00000000-0000-4000-8000-0000000000fd";

type Row = Record<string, unknown> & { id: string };
let tables: { memory: Row[]; logs: Row[]; conversations: Row[] };

// Evaluates the small subset of Prisma `where` the retention code and routes use.
function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "agent_runs") return (row.has_runs ? 1 : 0) === 0 || !(cond as { none?: unknown }).none;
    if (cond && typeof cond === "object" && "lt" in (cond as object)) return (row[key] as Date) < (cond as { lt: Date }).lt;
    return row[key] === cond;
  });
}
function table(name: keyof typeof tables) {
  return {
    count: async ({ where }: { where?: Record<string, unknown> } = {}) => tables[name].filter((r) => matches(r, where)).length,
    findMany: async ({ where, take }: { where?: Record<string, unknown>; take?: number } = {}) =>
      tables[name].filter((r) => matches(r, where)).sort((a, b) => +(b.created_at as Date) - +(a.created_at as Date)).slice(0, take),
    deleteMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
      const before = tables[name].length;
      tables[name] = tables[name].filter((r) => !matches(r, where));
      return { count: before - tables[name].length };
    },
  };
}
const p = prisma as unknown as Record<string, unknown>;
p.customer_memory = {
  ...table("memory"),
  findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
    tables.memory.filter((r) => matches(r, where)).map((r) => ({ ...r, memory_key: r.memory_key, memory_value: r.memory_value })),
};
p.customer_memory_access_logs = table("logs");
p.ai_conversations = table("conversations");

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const id = String(req.headers["x-user"]);
  req.user = { id, role: id === ADMIN ? "admin" : id === AGENT ? "agent" : "customer" } as never;
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
const get = (user: string, path: string) => fetch(base + path, { headers: { "x-user": user } });

const policy = { memoryIdleDays: 365, auditLogDays: 730, conversationDays: 365 };

beforeEach(() => {
  tables = {
    memory: [
      { id: "m1", customer_id: CUSTOMER, memory_key: "old", memory_value: "x", is_enabled: true, created_at: ago(500), updated_at: ago(400) },
      { id: "m2", customer_id: CUSTOMER, memory_key: "recent", memory_value: "y", is_enabled: true, created_at: ago(500), updated_at: ago(10) },
    ],
    logs: [
      { id: "l1", actor_id: ADMIN, customer_id: CUSTOMER, memory_record_id: null, action: "viewed", created_at: ago(800) },
      { id: "l2", actor_id: ADMIN, customer_id: CUSTOMER, memory_record_id: null, action: "viewed", created_at: ago(5) },
      { id: "l3", actor_id: AGENT, customer_id: OTHER, memory_record_id: null, action: "created", created_at: ago(2) },
    ],
    conversations: [
      { id: "c1", updated_at: ago(400), has_runs: false },
      { id: "c2", updated_at: ago(400), has_runs: true },
      { id: "c3", updated_at: ago(3), has_runs: false },
    ],
  };
});

test("policy defaults are defined and overridable; 0 disables a rule", () => {
  const saved = { ...process.env };
  delete process.env.MEMORY_RETENTION_DAYS;
  assert.deepEqual(loadRetentionPolicy(), policy);
  process.env.MEMORY_RETENTION_DAYS = "30";
  process.env.AUDIT_LOG_RETENTION_DAYS = "not-a-number";
  assert.equal(loadRetentionPolicy().memoryIdleDays, 30);
  assert.equal(loadRetentionPolicy().auditLogDays, 730);
  process.env = saved;
});

test("dry run reports counts and deletes nothing", async () => {
  const r = await purgeExpired({ dryRun: true, now: NOW, policy });
  assert.deepEqual([r.memoryFacts, r.auditLogs, r.conversations], [1, 1, 1]);
  assert.equal(tables.memory.length, 2);
  assert.equal(tables.logs.length, 3);
});

test("purge removes only expired rows and keeps conversations that have agent runs", async () => {
  const r = await purgeExpired({ now: NOW, policy });
  assert.deepEqual([r.memoryFacts, r.auditLogs, r.conversations], [1, 1, 1]);
  assert.deepEqual(tables.memory.map((m) => m.id), ["m2"]);
  assert.deepEqual(tables.logs.map((l) => l.id).sort(), ["l2", "l3"]);
  assert.deepEqual(tables.conversations.map((c) => c.id).sort(), ["c2", "c3"]);
});

test("a rule set to 0 days is skipped", async () => {
  const r = await purgeExpired({ now: NOW, policy: { ...policy, memoryIdleDays: 0 } });
  assert.equal(r.memoryFacts, 0);
  assert.equal(tables.memory.length, 2);
});

test("customer can export only their own facts", async () => {
  tables.memory.push({ id: "m3", customer_id: OTHER, memory_key: "theirs", memory_value: "z", is_enabled: true, created_at: ago(1), updated_at: ago(1) });
  const res = await get(CUSTOMER, "/memory-facts/export");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment/);
  const body = (await res.json()) as { facts: { key: string }[] };
  assert.deepEqual(body.facts.map((f) => f.key).sort(), ["old", "recent"]);
});

test("audit log is readable by admins only, filterable and never contains values", async () => {
  assert.equal((await get(AGENT, "/admin/memory/audit")).status, 403);
  assert.equal((await get(CUSTOMER, "/admin/memory/audit")).status, 403);

  const all = (await (await get(ADMIN, "/admin/memory/audit")).json()) as { customerId: string; action: string }[];
  assert.equal(all.length, 3);
  const one = (await (await get(ADMIN, `/admin/memory/audit?customerId=${OTHER}`)).json()) as { customerId: string }[];
  assert.deepEqual(one.map((r) => r.customerId), [OTHER]);
  assert.equal((await get(ADMIN, "/admin/memory/audit?customerId=nope")).status, 400);
  assert.ok(!JSON.stringify(all).includes("memory_value"));
});

test("retention preview is admin-only and does not delete", async () => {
  assert.equal((await get(AGENT, "/admin/memory/retention")).status, 403);
  const res = await get(ADMIN, "/admin/memory/retention");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { wouldDelete: { dryRun: boolean } };
  assert.equal(body.wouldDelete.dryRun, true);
});
