import assert from "node:assert/strict";
import test from "node:test";
import { executeAgentTool, getMyTicketsResult, outageStatusCheckerResult } from "../src/lib/agent-tools.js";
import type { AiRequestInput } from "../src/lib/ai.js";

const requests: AiRequestInput[] = [
  { id: "1", title: "Refund for double charge", status: "Open", isFinal: false, ticketNumber: 41, priority: "high", createdAt: "2026-10-01" },
  { id: "2", title: "Login code never arrives", status: "Resolved", isFinal: true, ticketNumber: 37, priority: "medium", createdAt: "2026-09-12" },
];

test("get_my_tickets returns resolved and open tickets by default", () => {
  assert.equal(getMyTicketsResult({}, requests).tickets.length, 2);
});

test("get_my_tickets filters by status group, keyword and ticket number", () => {
  assert.deepEqual(getMyTicketsResult({ status: "open" }, requests).tickets.map((t) => t.ticketNumber), [41]);
  assert.deepEqual(getMyTicketsResult({ status: "resolved" }, requests).tickets.map((t) => t.ticketNumber), [37]);
  assert.deepEqual(getMyTicketsResult({ query: "login" }, requests).tickets.map((t) => t.ticketNumber), [37]);
  assert.deepEqual(getMyTicketsResult({ query: "#41" }, requests).tickets.map((t) => t.ticketNumber), [41]);
});

test("get_my_tickets says so when nothing matches and runs through the tool switch", () => {
  const context = { knowledge: [], activeRequests: requests, account: { role: "customer", status: "active", organizationName: null, city: null, country: "Uganda", memberSince: "2026" } };
  assert.match(executeAgentTool("get_my_tickets", { query: "zzzz" }, context), /No matching tickets/);
  assert.match(executeAgentTool("get_my_tickets", { status: "open" }, context), /#41 "Refund for double charge": Open, high priority/);
});

test("outage_status_checker no longer reports resolved tickets as unresolved", () => {
  const result = outageStatusCheckerResult(requests);
  assert.deepEqual(result.openIssues.map((i) => i.title), ["Refund for double charge"]);
});
