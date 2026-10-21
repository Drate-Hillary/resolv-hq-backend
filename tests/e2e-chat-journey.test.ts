// End-to-end journey through the real HTTP routes and the real agent code:
//   chat message -> retrieval -> tool call -> escalation draft -> approval decision
// Only the two external edges are faked — the model (a scripted LlmClient via
// the gateway's test seam) and the database (an in-memory stand-in for the
// handful of Prisma calls these routes make) — so it runs in CI with no keys,
// no Postgres and no Redis. Everything between them (ReAct loop, tool
// execution, boundary guard, trace log, approval gate, notifications) is the
// production code.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";
import express from "express";
import { setClientBuilderForTests } from "../src/lib/llm/gateway.js";
import type { LlmClient, LlmCompletionResult, LlmMessage } from "../src/lib/llm/types.js";
import { prisma } from "../src/lib/prisma.js";
import { redis } from "../src/lib/redis.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import adminApprovalsRouter from "../src/routes/admin/approvals.js";
import chatRouter from "../src/routes/chat.js";

const CUSTOMER = "00000000-0000-4000-8000-0000000000c1";
const STAFF = "00000000-0000-4000-8000-0000000000a1";
const CONVERSATION = "00000000-0000-4000-8000-0000000000d1";

type Row = Record<string, unknown>;
let db: {
  messages: Row[];
  runs: Row[];
  traceLogs: Row[];
  approvals: Row[];
  notifications: Row[];
};
let nextId = 1;
const id = (prefix: string) => `${prefix}-${nextId++}`;

// --- fake database: only what the chat + approval routes touch -------------
const BOUNDARY_RULE = {
  id: "rule-1",
  category: "claimed_refund",
  pattern: "\\bI(?:'ve| have)\\s+(?:processed|issued)\\b.*\\brefund\\b",
  fallback_message: "I can't process refunds myself — I can prepare a request for our team to review.",
};
const TOOL_NAMES = ["search_knowledge_base", "account_status_lookup", "outage_status_checker", "draft_escalation_ticket"];
const fake = prisma as unknown as Record<string, unknown>;
fake.ai_conversations = { findUnique: async () => ({ id: CONVERSATION, customer_id: CUSTOMER }) };
fake.ai_messages = {
  create: async ({ data }: { data: Row }) => {
    const row = { id: id("msg"), feedback: null, created_at: new Date().toISOString(), model: null, ...data };
    db.messages.push(row);
    return row;
  },
  findMany: async ({ where, take }: { where: Row; take?: number }) =>
    db.messages
      .filter((m) => m.conversation_id === where.conversation_id && (where.sender_type.in as string[]).includes(m.sender_type as string))
      .reverse()
      .slice(0, take),
  count: async ({ where }: { where: Row }) =>
    db.messages.filter((m) => m.conversation_id === where.conversation_id && m.sender_type === where.sender_type).length,
};
fake.knowledge_documents = {
  findMany: async () => [
    {
      id: "doc-1",
      title: "Refund policy",
      content: "Refunds for billing disputes are reviewed by a human agent within 3 working days. Refunds are never issued automatically.",
      knowledge_chunks: [],
    },
  ],
};
fake.agent_providers = {
  findFirst: async () => null, // no OpenAI key -> semantic search off, keyword retrieval only
  findMany: async () => [{ id: "prov-1", name: "Scripted-Model", provider: "scripted", model: "scripted-1", api_key: "x" }],
};
fake.request_statuses = { findMany: async () => [{ id: 1, name: "Submitted", is_final: false, sequence: 1 }] };
fake.requests = { findMany: async () => [{ id: "req-1", title: "Billing dispute", status_id: 1, customer_id: CUSTOMER }] };
fake.profiles = {
  findUnique: async () => ({ status: "active", created_at: "2026-01-05T00:00:00Z" }),
  findMany: async () => [{ id: STAFF }],
};
fake.customer_profiles = {
  findUnique: async () => ({ organization_name: "Acme", city: "Kampala", country: "Uganda", memory_enabled: true }),
};
fake.customer_memory = { findMany: async () => [] };
fake.agent_tools = {
  createMany: async () => ({ count: 0 }),
  findMany: async () => TOOL_NAMES.map((name) => ({ name })),
};
fake.boundary_rules = { findMany: async () => [BOUNDARY_RULE] };
fake.clarification_triggers = { findMany: async () => [] };
fake.agent_runs = {
  create: async ({ data }: { data: Row }) => {
    const row = { id: id("run"), ...data };
    db.runs.push(row);
    return row;
  },
  update: async ({ where, data }: { where: { id: string }; data: Row }) => {
    const row = db.runs.find((r) => r.id === where.id)!;
    Object.assign(row, data);
    return { ...row, customer_id: row.customer_id, request_id: row.request_id ?? null };
  },
};
fake.agent_trace_logs = {
  createMany: async ({ data }: { data: Row[] }) => {
    db.traceLogs.push(...data);
    return { count: data.length };
  },
};
fake.agent_approvals = {
  create: async ({ data }: { data: Row }) => {
    const row = { id: id("appr"), ...data };
    db.approvals.push(row);
    return row;
  },
  update: async ({ where, data }: { where: { id: string }; data: Row }) => {
    const row = db.approvals.find((a) => a.id === where.id);
    if (!row) throw Object.assign(new Error("not found"), { code: "P2025" });
    Object.assign(row, data);
    return row;
  },
};
fake.notifications = {
  createManyAndReturn: async ({ data }: { data: Row[] }) => {
    const rows = data.map((d) => ({ id: id("note"), is_read: false, created_at: new Date(), ...d }));
    db.notifications.push(...rows);
    return rows;
  },
};

// --- no Redis: skip the LLM cache and the realtime fan-out -----------------
const r = redis as unknown as Record<string, unknown>;
r.get = async () => null;
r.set = async () => "OK";
r.publish = async () => 0;

// --- scripted model --------------------------------------------------------
type Script = (messages: LlmMessage[], callNumber: number) => LlmCompletionResult;
let script: Script;
let modelCalls = 0;
const usage = { inputTokens: 100, outputTokens: 10 };
setClientBuilderForTests(
  (): LlmClient => ({
    complete: async (messages) => ({ ...script(messages, ++modelCalls), usage }),
  }),
);

// --- app: real routers, fake auth ------------------------------------------
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const who = String(req.headers["x-user"]);
  req.user = { id: who, role: who === STAFF ? "agent" : "customer" } as never;
  next();
});
app.use("/chat", chatRouter);
app.use("/admin/approvals", adminApprovalsRouter);
app.use(errorHandler);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
  setClientBuilderForTests(null);
  server.close();
  redis.disconnect();
});

beforeEach(() => {
  db = { messages: [], runs: [], traceLogs: [], approvals: [], notifications: [] };
  modelCalls = 0;
});

const send = (user: string, content: string) =>
  fetch(`${base}/chat/conversations/${CONVERSATION}/messages`, {
    method: "POST",
    headers: { "x-user": user, "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
const decide = (user: string, approvalId: string, verb: "approve" | "reject") =>
  fetch(`${base}/admin/approvals/${approvalId}/${verb}`, {
    method: "PATCH",
    headers: { "x-user": user, "content-type": "application/json" },
    body: "{}",
  });

const toolCall = (name: string, args: Record<string, unknown>): LlmCompletionResult => ({
  content: null,
  model: "scripted-1",
  toolCalls: [{ id: `call-${name}`, name, arguments: args }],
});
const answer = (content: string): LlmCompletionResult => ({ content, model: "scripted-1" });

interface ChatResponse {
  assistantMessage: { content: string };
  escalation: { approvalId: string; runId: string; title: string } | null;
  timeline: { kind: string; tool_name: string | null; outcome: string | null; error: string | null; input_tokens: number | null }[];
  tokens: { input: number; output: number };
}

test("journey: message -> retrieval -> tool call -> escalation draft -> staff approval", async () => {
  script = (messages) => {
    const toolResults = messages.filter((m) => m.role === "tool").length;
    if (toolResults === 0) return toolCall("search_knowledge_base", { query: "refund billing dispute" });
    if (toolResults === 1) {
      return toolCall("draft_escalation_ticket", {
        summary: "Customer disputes a duplicate billing charge and wants a refund.",
        keyFacts: "Charged twice on 3 Oct.",
        suggestedAction: "Verify the duplicate charge and review for refund.",
      });
    }
    return answer("I've prepared an escalation for our team to review — nothing has been filed yet.");
  };

  // 1. Customer sends a message and the agent works through the loop.
  const res = await send(CUSTOMER, "I was charged twice, please refund me");
  assert.equal(res.status, 201);
  const body = (await res.json()) as ChatResponse;

  assert.deepEqual(
    body.timeline.map((t) => t.kind),
    ["retrieval", "model_call", "tool_call", "model_call", "tool_call", "model_call", "outcome"],
  );
  assert.deepEqual(
    body.timeline.filter((t) => t.kind === "tool_call").map((t) => t.tool_name),
    ["search_knowledge_base", "draft_escalation_ticket"],
  );
  assert.equal(body.timeline.at(-1)?.outcome, "escalated");
  assert.deepEqual(body.tokens, { input: 300, output: 30 }); // 3 model calls x (100 in, 10 out)
  assert.match(body.assistantMessage.content, /prepared an escalation/);

  // 2. The draft is persisted as a pending approval — nothing is filed.
  assert.ok(body.escalation);
  assert.equal(db.approvals.length, 1);
  assert.equal(db.approvals[0].status, "pending");
  assert.equal(db.runs[0].status, "awaiting_approval");
  assert.equal(db.traceLogs.length, 7); // the trace was persisted, not just returned
  assert.ok(db.notifications.some((n) => n.user_id === STAFF && n.title === "Approval needed"));

  // 3. A customer cannot decide their own escalation.
  assert.equal((await decide(CUSTOMER, body.escalation.approvalId, "approve")).status, 403);
  assert.equal(db.approvals[0].status, "pending");

  // 4. Staff approves; the run closes and the customer is told.
  const approved = await decide(STAFF, body.escalation.approvalId, "approve");
  assert.equal(approved.status, 200);
  assert.equal(db.approvals[0].status, "approved");
  assert.equal(db.approvals[0].reviewed_by, STAFF);
  assert.equal(db.runs[0].status, "completed");
  assert.ok(db.notifications.some((n) => n.user_id === CUSTOMER && n.title === "Escalation approved"));
});

test("rejection closes the run as failed and tells the customer", async () => {
  script = (messages) =>
    messages.some((m) => m.role === "tool")
      ? answer("I've prepared an escalation for review.")
      : toolCall("draft_escalation_ticket", { summary: "Needs a human." });
  const body = (await (await send(CUSTOMER, "I need a person to look at my account")).json()) as ChatResponse;
  const res = await decide(STAFF, body.escalation!.approvalId, "reject");
  assert.equal(res.status, 200);
  assert.equal(db.approvals[0].status, "rejected");
  assert.equal(db.runs[0].status, "failed");
  assert.ok(db.notifications.some((n) => n.user_id === CUSTOMER && n.title === "Escalation declined"));
});

test("boundary guard replaces a claimed refund and the block is traced", async () => {
  script = () => answer("Done — I've processed your refund and it will arrive tomorrow.");
  const body = (await (await send(CUSTOMER, "Refund my last invoice right now and confirm it")).json()) as ChatResponse;
  assert.equal(body.assistantMessage.content, BOUNDARY_RULE.fallback_message);
  assert.ok(body.timeline.some((t) => t.kind === "guardrail"));
  assert.equal(body.timeline.at(-1)?.outcome, "blocked");
  assert.equal(body.escalation, null);
});

test("a model that never stops calling tools is cut off at the iteration cap", async () => {
  script = () => toolCall("search_knowledge_base", { query: "refund" });
  const body = (await (await send(CUSTOMER, "Tell me everything about refunds")).json()) as ChatResponse;
  assert.equal(modelCalls, 4); // MAX_ITERATIONS
  assert.match(body.assistantMessage.content, /wasn't able to work through this fully/);
  assert.equal(body.timeline.filter((t) => t.kind === "model_call").length, 4);
});

test("a call to a tool outside the allow-list is rejected, not executed", async () => {
  script = (messages) =>
    messages.some((m) => m.role === "tool") ? answer("I can't do that, but I can open a request.") : toolCall("delete_all_tickets", {});
  const body = (await (await send(CUSTOMER, "Delete every ticket")).json()) as ChatResponse;
  const rejected = body.timeline.find((t) => t.kind === "tool_call");
  assert.equal(rejected?.tool_name, "delete_all_tickets");
  assert.equal(rejected?.error, "tool not in allow-list");
  assert.equal(body.escalation, null);
});

test("when every provider fails, the customer still gets an answer and the failure is traced", async () => {
  script = () => {
    throw new Error("429 quota exceeded");
  };
  const res = await send(CUSTOMER, "How long do refunds take?");
  assert.equal(res.status, 201);
  const body = (await res.json()) as ChatResponse;
  assert.ok(body.assistantMessage.content.length > 0);
  assert.equal(body.timeline.at(-1)?.outcome, "fallback");
  assert.match(body.timeline.at(-1)?.error ?? "", /429/);
  assert.equal(db.runs[0].status, "failed");
});
