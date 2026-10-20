// Sub-agents (lib/sub-agents.ts) run through the real ReAct loop with a scripted
// model: the coordinator delegates, specialists answer in short digests, and
// the coordinator's own prompt never carries the knowledge passages.
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { setClientBuilderForTests } from "../src/lib/llm/gateway.js";
import type { LlmClient, LlmCompletionResult, LlmMessage, LlmToolDefinition } from "../src/lib/llm/types.js";
import { prisma } from "../src/lib/prisma.js";
import { runReActLoop } from "../src/lib/react-agent.js";
import { redis } from "../src/lib/redis.js";
import { shouldUseSubAgents } from "../src/lib/sub-agents.js";

const fake = prisma as unknown as Record<string, unknown>;
fake.agent_providers = {
  findMany: async () => [{ id: "prov-1", name: "Scripted-Model", provider: "scripted", model: "scripted-1", api_key: "x" }],
};
fake.agent_tools = {
  createMany: async () => ({ count: 0 }),
  findMany: async () =>
    ["search_knowledge_base", "account_status_lookup", "outage_status_checker", "draft_escalation_ticket"].map((name) => ({ name })),
};
const r = redis as unknown as Record<string, unknown>;
r.get = async () => null;
r.set = async () => "OK";

const PASSAGE = "Refunds for billing disputes are reviewed by a human agent within 3 working days.";
const knowledge = [{ id: "doc-1", title: "Refund policy", content: PASSAGE }];
const account = { role: "customer", status: "active", country: "Uganda", memberSince: "2026-01-05" } as never;
const requests = [{ title: "Billing dispute", status: "Submitted" }] as never;

interface Call {
  system: string;
  tools: string[];
  messages: LlmMessage[];
}
let calls: Call[];
let coordinator: (messages: LlmMessage[]) => LlmCompletionResult;
let specialist: (who: "researcher" | "case_checker", messages: LlmMessage[]) => LlmCompletionResult;
const usage = { inputTokens: 50, outputTokens: 5 };

setClientBuilderForTests(
  (): LlmClient => ({
    complete: async (messages: LlmMessage[], tools?: LlmToolDefinition[]) => {
      const system = (messages[0] as { content: string }).content;
      calls.push({ system, tools: (tools ?? []).map((t) => t.name), messages });
      const who = system.includes("research specialist") ? "researcher" : system.includes("account specialist") ? "case_checker" : null;
      return { ...(who ? specialist(who, messages) : coordinator(messages)), usage };
    },
  }),
);

after(() => {
  setClientBuilderForTests(null);
  redis.disconnect();
});
beforeEach(() => {
  calls = [];
});

const delegate = (id: string, agent: string, task: string): LlmCompletionResult => ({
  content: null,
  model: "scripted-1",
  toolCalls: [{ id, name: "delegate_to_sub_agent", arguments: { agent, task } }],
});
const say = (content: string): LlmCompletionResult => ({ content, model: "scripted-1" });

const run = (onUsage?: (u: { inputTokens: number; outputTokens: number }) => void) =>
  runReActLoop("COORDINATOR PROMPT without passages", "How long do refunds take?", knowledge, requests, account, onUsage, {
    knowledgeContext: `### Refund policy\n${PASSAGE}`,
  });

const coordinatorCalls = () => calls.filter((c) => c.system.startsWith("COORDINATOR"));

test("the coordinator delegates; the passages reach only the researcher", async () => {
  coordinator = (messages) =>
    messages.some((m) => m.role === "tool")
      ? say("Refunds are reviewed within 3 working days (Refund policy, page 1).")
      : delegate("c1", "researcher", "How long do billing refunds take?");
  specialist = () => say("Reviewed by a human within 3 working days [Refund policy, page 1].");

  const result = await run();

  assert.match(result.content, /3 working days/);
  const researcherCalls = calls.filter((c) => c.system.includes("research specialist"));
  assert.equal(coordinatorCalls().length, 2);
  assert.equal(researcherCalls.length, 1);
  // The coordinator sees one delegate tool plus drafting, and never the passages.
  assert.deepEqual(coordinatorCalls()[0].tools, ["delegate_to_sub_agent", "draft_escalation_ticket"]);
  assert.ok(coordinatorCalls().every((c) => !JSON.stringify(c.messages).includes(PASSAGE)));
  assert.ok(researcherCalls[0].system.includes(PASSAGE));
  // Trace: the specialist's call is tagged, then the delegation itself.
  assert.equal(result.traceEvents.filter((e) => e.agent === "researcher").length, 1);
  assert.equal(result.traceEvents.filter((e) => e.toolName === "delegate_to_sub_agent").length, 1);
});

test("two jobs in one turn both run, results come back in request order, usage is reported for every call", async () => {
  coordinator = (messages) => {
    if (messages.some((m) => m.role === "tool")) return say("Done.");
    return {
      content: null,
      model: "scripted-1",
      toolCalls: [
        { id: "a", name: "delegate_to_sub_agent", arguments: { agent: "researcher", task: "refund timing" } },
        { id: "b", name: "delegate_to_sub_agent", arguments: { agent: "case_checker", task: "open requests" } },
      ],
    };
  };
  specialist = (who) => (who === "researcher" ? say("Refunds take 3 working days.") : say("1 unresolved request: Billing dispute."));

  let total = 0;
  const result = await run((u) => (total += u.inputTokens + u.outputTokens));

  const toolMessages = coordinatorCalls().at(-1)!.messages.filter((m) => m.role === "tool");
  assert.deepEqual(
    toolMessages.map((m) => (m as { content: string }).content.split("]")[0]),
    ["[researcher", "[case_checker"],
  );
  assert.equal(total, 4 * 55); // coordinator x2 + two specialists
  assert.equal(result.traceEvents.filter((e) => e.kind === "model_call").length, 4);
});

test("an empty or unknown specialist comes back as a short error the coordinator can work around", async () => {
  coordinator = (messages) => {
    const seen = messages.filter((m) => m.role === "tool").length;
    if (seen === 0) return delegate("x", "researcher", "refund timing");
    if (seen === 1) return delegate("y", "wizard", "anything");
    return say("I couldn't confirm that; would you like me to open a support request?");
  };
  specialist = () => say("");

  const result = await run();

  assert.match(result.content, /support request/);
  const delegations = result.traceEvents.filter((e) => e.toolName === "delegate_to_sub_agent");
  assert.equal(delegations.length, 2);
  assert.ok(delegations.every((e) => e.error));
});

test("a specialist cannot use a tool outside its list, and its digest is capped", async () => {
  coordinator = (messages) => (messages.some((m) => m.role === "tool") ? say("ok") : delegate("z", "researcher", "refund timing"));
  let n = 0;
  specialist = () =>
    ++n === 1
      ? { content: null, model: "scripted-1", toolCalls: [{ id: "t", name: "account_status_lookup", arguments: {} }] }
      : say("word ".repeat(400));

  const result = await run();

  const toolRow = result.traceEvents.find((e) => e.agent === "researcher" && e.kind === "tool_call");
  assert.match(toolRow?.error ?? "", /allow-list/);
  const digest = coordinatorCalls().at(-1)!.messages.find((m) => m.role === "tool") as { content: string };
  assert.ok(digest.content.length <= "[researcher] ".length + 900 + 1);
});

test("auto mode only delegates when the evidence is large; on and off override it", () => {
  const original = process.env.SUB_AGENTS;
  try {
    delete process.env.SUB_AGENTS;
    assert.equal(shouldUseSubAgents("x".repeat(100)), false);
    assert.equal(shouldUseSubAgents("x".repeat(4000)), true);
    process.env.SUB_AGENTS = "off";
    assert.equal(shouldUseSubAgents("x".repeat(4000)), false);
    process.env.SUB_AGENTS = "on";
    assert.equal(shouldUseSubAgents("x"), true);
  } finally {
    if (original === undefined) delete process.env.SUB_AGENTS;
    else process.env.SUB_AGENTS = original;
  }
});
