import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTraceRows } from "../src/lib/trace-log.js";

const meta = { query: "where is my refund", promptVersion: "v-test", totalLatencyMs: 840 };

test("trace rows cover retrieval, model/tool calls and outcome, in order", () => {
  const rows = buildTraceRows(
    {
      retrieval: [{ id: "k1", title: "Refund policy", score: 7 }],
      traceEvents: [
        { kind: "model_call", iteration: 1, provider: "gemini", model: "m1", detail: "Requested tools: search_knowledge_base", latencyMs: 410 },
        { kind: "tool_call", iteration: 1, toolName: "search_knowledge_base", toolInput: { query: "refund" }, detail: "1 article", latencyMs: 2 },
        { kind: "model_call", iteration: 2, provider: "gemini", model: "m1", detail: "Final answer", latencyMs: 380 },
      ],
      flow: { kind: "model", provider: "gemini", model: "m1", attempts: ["gemini"], cached: false, stages: [], outcome: "answered" },
    },
    meta,
  );
  assert.deepEqual(rows.map((r) => r.kind), ["retrieval", "model_call", "tool_call", "model_call", "outcome"]);
  assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3, 4, 5]);
  assert.equal(rows[2].tool_name, "search_knowledge_base");
  assert.equal(rows[1].prompt_version, "v-test");
  assert.equal(rows[4].outcome, "answered");
  assert.equal(rows[4].latency_ms, 840);
});

test("a gateway failure is recorded with its error and a fallback outcome", () => {
  const rows = buildTraceRows(
    {
      traceEvents: [{ kind: "model_call", iteration: 1, detail: "Model call failed", latencyMs: 90, error: "429 quota" }],
      fallbackReason: "429 quota",
      flow: { kind: "fallback", provider: null, model: null, attempts: [], cached: false, stages: [], outcome: "fallback", failureReason: "429 quota" },
    },
    meta,
  );
  assert.equal(rows[1].error, "429 quota");
  assert.equal(rows.at(-1)?.outcome, "fallback");
  assert.equal(rows.at(-1)?.error, "429 quota");
});

test("a boundary block adds a guardrail row before the outcome", () => {
  const rows = buildTraceRows(
    {
      boundaryViolation: { category: "refund", matchedText: "I've processed your refund" },
      flow: { kind: "model", provider: "p", model: "m", attempts: ["p"], cached: false, stages: [], outcome: "blocked" },
    },
    meta,
  );
  assert.deepEqual(rows.map((r) => r.kind), ["retrieval", "guardrail", "outcome"]);
});
