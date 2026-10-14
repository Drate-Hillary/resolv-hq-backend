// End-to-end trace log. One agent_runs row per task is the summary; this adds
// the ordered detail under it — what was retrieved, each model call and tool
// call with its latency and any error, and how the task ended — so a run can
// be replayed after the fact (GET /admin/traces/:runId), not just counted.
import type { Prisma } from "@prisma/client";
import type { AiAnswer } from "./ai.js";
import { prisma } from "./prisma.js";

export type TraceLogKind = "retrieval" | "model_call" | "tool_call" | "guardrail" | "outcome";

export interface TraceLogRow {
  seq: number;
  kind: TraceLogKind;
  iteration: number | null;
  provider: string | null;
  model: string | null;
  prompt_version: string | null;
  tool_name: string | null;
  tool_input: Prisma.InputJsonValue | null;
  detail: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  error: string | null;
  outcome: string | null;
}

const QUERY_CHARS = 300;

/** Pure: turns a finished answer into ordered trace rows. */
export function buildTraceRows(
  answer: Pick<AiAnswer, "retrieval" | "traceEvents" | "boundaryViolation" | "flow" | "fallbackReason">,
  meta: { query: string; promptVersion: string; totalLatencyMs: number },
): TraceLogRow[] {
  const rows: Omit<TraceLogRow, "seq">[] = [];
  const blank = {
    iteration: null, provider: null, model: null, prompt_version: null, tool_name: null,
    tool_input: null, detail: null, latency_ms: null, input_tokens: null, output_tokens: null, error: null, outcome: null,
  };

  rows.push({
    ...blank,
    kind: "retrieval",
    prompt_version: meta.promptVersion,
    tool_input: { query: meta.query.slice(0, QUERY_CHARS) },
    detail: JSON.stringify(answer.retrieval ?? []),
  });

  for (const e of answer.traceEvents ?? []) {
    rows.push({
      ...blank,
      kind: e.kind,
      iteration: e.iteration,
      provider: e.provider ?? null,
      model: e.model ?? null,
      prompt_version: e.kind === "model_call" ? meta.promptVersion : null,
      tool_name: e.toolName ?? null,
      tool_input: (e.toolInput as Prisma.InputJsonValue | undefined) ?? null,
      detail: e.detail,
      latency_ms: e.latencyMs,
      input_tokens: e.inputTokens ?? null,
      output_tokens: e.outputTokens ?? null,
      error: e.error ?? null,
    });
  }

  if (answer.boundaryViolation) {
    rows.push({
      ...blank,
      kind: "guardrail",
      detail: `Boundary matrix (${answer.boundaryViolation.category}) blocked: "${answer.boundaryViolation.matchedText}"`,
    });
  }

  rows.push({
    ...blank,
    kind: "outcome",
    provider: answer.flow?.provider ?? null,
    model: answer.flow?.model ?? null,
    latency_ms: meta.totalLatencyMs,
    error: answer.flow?.failureReason ?? answer.fallbackReason ?? null,
    outcome: answer.flow?.outcome ?? null,
  });

  return rows.map((r, i) => ({ ...r, seq: i + 1 }));
}

/** Best-effort: a trace write must never cost the customer their answer.
 * Returns the rows either way so the response can still carry the timeline. */
export async function writeTraceLog(
  runId: string,
  answer: Parameters<typeof buildTraceRows>[0],
  meta: Parameters<typeof buildTraceRows>[1],
): Promise<TraceLogRow[]> {
  const rows = buildTraceRows(answer, meta);
  try {
    await prisma.agent_trace_logs.createMany({
      data: rows.map((r) => ({
        ...r,
        agent_run_id: runId,
        tool_input: r.tool_input ?? undefined,
      })),
    });
  } catch (err) {
    console.error("Failed to write agent trace log:", err);
  }
  return rows;
}
