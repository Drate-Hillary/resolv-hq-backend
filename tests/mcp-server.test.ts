import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type McpServerDeps } from "../src/lib/mcp-server.js";

const ALL = ["search_knowledge_base", "account_status_lookup", "outage_status_checker", "draft_escalation_ticket"];

function makeDeps(over: Partial<McpServerDeps> & { active?: Set<string> } = {}): McpServerDeps {
  const state = { active: over.active ?? new Set(ALL) };
  return {
    getActiveTools: async () => state.active,
    loadCallerAccount: async () => ({ role: "customer", status: "active", organizationName: null, city: null, country: "Uganda", memberSince: "unknown" }) as never,
    loadCallerRequests: async () => [] as never,
    loadCallerKnowledge: async () => [] as never,
    ...over,
  };
}

async function connect(deps: McpServerDeps) {
  const server = await createMcpServer({ id: "u1", role: "customer" } as never, deps);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, close: () => client.close() };
}

test("tools/list advertises the four active tools with read-only annotations", async () => {
  const { client, close } = await connect(makeDeps());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...ALL].sort());
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true);
    assert.equal(t.annotations?.destructiveHint, false);
    assert.ok(t.outputSchema);
  }
  await close();
});

test("inactive tools are not advertised", async () => {
  const { client, close } = await connect(makeDeps({ active: new Set(["account_status_lookup"]) }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["account_status_lookup"]);
  await close();
});

test("a tool deactivated after listing is rejected with an explicit tool error", async () => {
  const active = new Set(ALL);
  const { client, close } = await connect(makeDeps({ getActiveTools: async () => active }));
  active.delete("account_status_lookup");
  const res = await client.callTool({ name: "account_status_lookup", arguments: {} });
  assert.equal(res.isError, true);
  assert.match(JSON.stringify(res.content), /inactive/);
  await close();
});

test("account_status_lookup returns structured content", async () => {
  const { client, close } = await connect(makeDeps());
  const res = await client.callTool({ name: "account_status_lookup", arguments: {} });
  assert.notEqual(res.isError, true);
  assert.equal((res.structuredContent as { country: string }).country, "Uganda");
  await close();
});

test("no matches is a successful empty result", async () => {
  const { client, close } = await connect(makeDeps());
  const kb = await client.callTool({ name: "search_knowledge_base", arguments: { query: "x" } });
  assert.notEqual(kb.isError, true);
  assert.deepEqual((kb.structuredContent as { matches: unknown[] }).matches, []);
  const out = await client.callTool({ name: "outage_status_checker", arguments: {} });
  assert.notEqual(out.isError, true);
  assert.deepEqual((out.structuredContent as { openIssues: unknown[] }).openIssues, []);
  await close();
});

test("loader failures become tool errors without structuredContent", async () => {
  const { client, close } = await connect(
    makeDeps({ loadCallerRequests: async () => { throw new Error("db down"); } }),
  );
  const res = await client.callTool({ name: "outage_status_checker", arguments: {} });
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent, undefined);
  await close();
});

test("schema-invalid and unknown arguments are rejected", async () => {
  const { client, close } = await connect(makeDeps());
  const extra = await client.callTool({ name: "account_status_lookup", arguments: { userId: "other" } }).catch((e) => e);
  assert.ok(extra instanceof Error || extra.isError === true);
  const missing = await client.callTool({ name: "search_knowledge_base", arguments: {} }).catch((e) => e);
  assert.ok(missing instanceof Error || missing.isError === true);
  await close();
});

test("draft_escalation_ticket is never submitted; empty summary is an error", async () => {
  const { client, close } = await connect(makeDeps());
  const ok = await client.callTool({ name: "draft_escalation_ticket", arguments: { summary: "Power outage at my shop" } });
  assert.notEqual(ok.isError, true);
  assert.equal((ok.structuredContent as { submitted: boolean }).submitted, false);
  const bad = await client.callTool({ name: "draft_escalation_ticket", arguments: { summary: "   " } });
  assert.equal(bad.isError, true);
  await close();
});
