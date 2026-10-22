// ReAct Loop Core Implementation: Sense -> Plan -> Act -> Observe -> Respond.
//
//   Sense    the caller's message plus everything already loaded for them
//            (knowledge_documents, their own requests) — the loop's starting
//            context, built by lib/ai.ts before calling in here.
//   Plan     the model decides, each iteration, whether it has enough to
//            answer or needs a tool — a real decision made via tool-calling
//            (lib/llm/types.ts), not a scripted step.
//   Act      if the model asked for a tool, this loop actually calls it
//            (lib/agent-tools.ts). Every tool is read-only — nothing here
//            ever changes state (AI Boundary Matrix).
//   Observe  the tool's result is appended to the conversation as a `tool`
//            message, and the loop goes back to Plan with it in context.
//   Respond  once the model answers with plain content (no more tool
//            calls), that's the final response — or MAX_ITERATIONS is hit,
//            in which case the loop stops and returns a safe fallback
//            rather than looping forever.
import { buildEscalationDraft, executeAgentTool, type EscalationDraft } from "./agent-tools.js";
import type { AiAccountInput, AiKnowledgeInput, AiRequestInput } from "./ai.js";
import { TOOL_OBSERVATION_BUDGET_CHARS, truncateAtBoundary } from "./context-budget.js";
import {
  completeWithFallback,
  GatewayUnavailableError,
  type GatewayResult,
  type ProviderHandoff,
} from "./llm/gateway.js";
import type { LlmMessage } from "./llm/types.js";
import { DELEGATE_TOOL, runSubAgent, type SubAgentRun } from "./sub-agents.js";
import { getActiveToolDefinitions } from "./tool-registry.js";

export interface ReActStep {
  phase: "plan" | "act" | "observe" | "respond";
  detail: string;
}

/** One row of the end-to-end trace log (agent_trace_logs): a single model call
 * or tool call, with how long it took and whether it failed. Kept separate
 * from `trace` above, which is the display-oriented Plan/Act/Observe list. */
export interface TraceEvent {
  kind: "model_call" | "tool_call";
  /** Set when a sub-agent (lib/sub-agents.ts) made this call rather than the main agent. */
  agent?: string;
  iteration: number;
  provider?: string;
  model?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  /** The model's decision for a model_call, the (truncated) observation for a tool_call. */
  detail: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

const TRACE_DETAIL_CHARS = 500;

export interface ReActResult {
  content: string;
  model: string;
  providerName: string;
  cached: boolean;
  iterations: number;
  /** Providers tried on the first model call, in order (the last answered it). */
  attempts: string[];
  handoffs: ProviderHandoff[];
  trace: ReActStep[];
  traceEvents: TraceEvent[];
  /** Set when the loop called draft_escalation_ticket — the structured brief
   * for a human to review, kept alongside `content` rather than requiring
   * the caller to re-parse it out of the tool's text observation. */
  escalationDraft?: EscalationDraft;
}

/** Hard ceiling on Plan-Act-Observe cycles for a single turn — a structural
 * safety valve, not a business rule, so a model that keeps asking for tools
 * can't loop (and rack up provider calls) forever. */
const MAX_ITERATIONS = 4;

/** Ceiling on sub-agent jobs per turn, so delegation can't multiply provider calls without bound. */
const MAX_DELEGATIONS = 4;

/** Tools the coordinator keeps when it delegates; the read-only lookups move to the sub-agents. */
const COORDINATOR_OWN_TOOLS = new Set(["draft_escalation_ticket"]);

const FALLBACK_ON_EXHAUSTION =
  "I wasn't able to work through this fully — could you rephrase your question, or would you like me to open a support request instead?";

export async function runReActLoop(
  systemPrompt: string,
  query: string,
  knowledge: AiKnowledgeInput[],
  activeRequests: AiRequestInput[],
  account: AiAccountInput,
  /** Called after each model call with that call's token usage, so a caller can show a run's cost as it grows. */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void,
  /** When set, the retrieved knowledge is not in `systemPrompt`; this agent hands it to sub-agents instead. */
  delegation?: { knowledgeContext: string },
  /** An admin-selected agent_providers id: tried first on every model call, the others stay as fallback. */
  preferredProviderId?: string,
): Promise<ReActResult> {
  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: query },
  ];
  const trace: ReActStep[] = [];
  const traceEvents: TraceEvent[] = [];
  let attempts: string[] | undefined;
  const handoffs: ProviderHandoff[] = [];
  const excludedProviderIds = new Set<string>();
  let escalationDraft: EscalationDraft | undefined;
  const activeTools = await getActiveToolDefinitions();
  // In sub-agent mode the coordinator sees one delegate tool (plus the drafting tool), which also
  // keeps the long list of tool schemas out of every model call.
  const tools = delegation
    ? [DELEGATE_TOOL, ...activeTools.filter((t) => COORDINATOR_OWN_TOOLS.has(t.name))]
    : activeTools;
  const allowedTools = new Set(tools.map((t) => t.name));
  let delegationsUsed = 0;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    let result: GatewayResult;
    const modelStart = Date.now();
    try {
      result = await completeWithFallback(messages, tools, [...excludedProviderIds], preferredProviderId);
    } catch (err) {
      traceEvents.push({
        kind: "model_call",
        iteration,
        detail: "Model call failed",
        latencyMs: Date.now() - modelStart,
        error: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof GatewayUnavailableError) {
        const allHandoffs = new Map(
          [...handoffs, ...err.handoffs].map((handoff) => [
            `${handoff.from}:${handoff.to}:${handoff.reason}`,
            handoff,
          ]),
        );
        throw new GatewayUnavailableError(
          err.message,
          [...new Set([...(attempts ?? []), ...err.attempts])],
          [...new Set([...excludedProviderIds, ...err.failedProviderIds])],
          [...allHandoffs.values()],
          traceEvents,
        );
      }
      throw err;
    }
    traceEvents.push({
      kind: "model_call",
      iteration,
      provider: result.providerName,
      model: result.model,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      detail: result.toolCalls?.length
        ? `Requested tools: ${result.toolCalls.map((c) => c.name).join(", ")}`
        : truncateAtBoundary(result.content ?? "", TRACE_DETAIL_CHARS),
      latencyMs: Date.now() - modelStart,
    });
    if (result.usage) onUsage?.({ inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens });
    attempts ??= result.attempts ?? [];
    for (const providerId of result.failedProviderIds ?? []) excludedProviderIds.add(providerId);
    for (const handoff of result.handoffs ?? []) {
      const alreadyRecorded = handoffs.some(
        (item) => item.from === handoff.from && item.to === handoff.to && item.reason === handoff.reason,
      );
      if (!alreadyRecorded) handoffs.push(handoff);
    }

    if (result.toolCalls && result.toolCalls.length > 0) {
      trace.push({ phase: "plan", detail: `Decided to call: ${result.toolCalls.map((c) => c.name).join(", ")}` });
      messages.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });

      // Start every delegated job now so independent sub-agents run side by side;
      // results are collected below in the order the model asked for them.
      const delegated = new Map<string, Promise<SubAgentRun>>();
      if (delegation) {
        for (const call of result.toolCalls) {
          if (call.name !== DELEGATE_TOOL.name || call.argumentsParseError || delegationsUsed >= MAX_DELEGATIONS) continue;
          delegationsUsed++;
          delegated.set(
            call.id,
            runSubAgent(call.arguments.agent, call.arguments.task, {
              knowledge,
              activeRequests,
              account,
              knowledgeContext: delegation.knowledgeContext,
              activeTools,
              excludedProviderIds: [...excludedProviderIds],
              preferredProviderId,
              onUsage,
            }).catch((err): SubAgentRun => ({
              agent: String(call.arguments.agent ?? "unknown"),
              text: "That sub-agent hit an unexpected error. Answer from what you already have, or offer to open a support request.",
              events: [{ kind: "tool_call", iteration, detail: "Sub-agent crashed", latencyMs: 0, error: err instanceof Error ? err.message : String(err) }],
              failed: true,
              failedProviderIds: [],
            })),
          );
        }
      }

      for (const call of result.toolCalls) {
        if (call.argumentsParseError) {
          const observation = `Your call to "${call.name}" could not be executed: its arguments were not valid (${call.argumentsParseError}). Retry with a corrected JSON arguments object.`;
          trace.push({ phase: "act", detail: `${call.name}: rejected — ${call.argumentsParseError}` });
          console.error(`ReAct loop: rejected malformed tool-call arguments for "${call.name}": ${call.argumentsParseError}`);
          trace.push({ phase: "observe", detail: observation });
          traceEvents.push({
            kind: "tool_call",
            iteration,
            toolName: call.name,
            detail: observation,
            latencyMs: 0,
            error: `invalid arguments: ${call.argumentsParseError}`,
          });
          messages.push({ role: "tool", toolCallId: call.id, content: observation });
          continue;
        }

        if (!allowedTools.has(call.name)) {
          const observation = `Tool "${call.name}" is not available.`;
          trace.push({ phase: "act", detail: `${call.name}: rejected — not an active tool` });
          trace.push({ phase: "observe", detail: observation });
          traceEvents.push({
            kind: "tool_call",
            iteration,
            toolName: call.name,
            toolInput: call.arguments,
            detail: observation,
            latencyMs: 0,
            error: "tool not in allow-list",
          });
          messages.push({ role: "tool", toolCallId: call.id, content: observation });
          continue;
        }

        if (call.name === DELEGATE_TOOL.name) {
          const job = delegated.get(call.id);
          const detail = `${call.name}(${JSON.stringify(call.arguments)})`;
          trace.push({ phase: "act", detail });
          if (!job) {
            const observation = `Delegation limit of ${MAX_DELEGATIONS} sub-agent jobs per turn reached. Answer from what you already have.`;
            trace.push({ phase: "observe", detail: observation });
            traceEvents.push({ kind: "tool_call", iteration, toolName: call.name, toolInput: call.arguments, detail: observation, latencyMs: 0, error: "delegation limit" });
            messages.push({ role: "tool", toolCallId: call.id, content: observation });
            continue;
          }
          const delegateStart = Date.now();
          const run = await job;
          for (const providerId of run.failedProviderIds) excludedProviderIds.add(providerId);
          traceEvents.push(...run.events);
          traceEvents.push({
            kind: "tool_call",
            iteration,
            toolName: call.name,
            toolInput: call.arguments,
            detail: truncateAtBoundary(run.text, TRACE_DETAIL_CHARS),
            latencyMs: Date.now() - delegateStart,
            error: run.failed ? `sub-agent ${run.agent} failed` : undefined,
          });
          const observation = `[${run.agent}] ${run.text}`;
          trace.push({ phase: "observe", detail: observation.slice(0, 200) });
          messages.push({ role: "tool", toolCallId: call.id, content: truncateAtBoundary(observation, TOOL_OBSERVATION_BUDGET_CHARS) });
          continue;
        }

        trace.push({ phase: "act", detail: `${call.name}(${JSON.stringify(call.arguments)})` });
        const toolStart = Date.now();
        const observation = executeAgentTool(call.name, call.arguments, { knowledge, activeRequests, account });
        traceEvents.push({
          kind: "tool_call",
          iteration,
          toolName: call.name,
          toolInput: call.arguments,
          detail: truncateAtBoundary(observation, TRACE_DETAIL_CHARS),
          latencyMs: Date.now() - toolStart,
        });
        if (call.name === "draft_escalation_ticket") {
          escalationDraft = buildEscalationDraft(call.arguments) ?? escalationDraft;
        }
        trace.push({ phase: "observe", detail: observation.slice(0, 200) });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: truncateAtBoundary(observation, TOOL_OBSERVATION_BUDGET_CHARS),
        });
      }

      continue;
    }

    trace.push({ phase: "respond", detail: "Produced a final answer" });
    return {
      content: result.content ?? FALLBACK_ON_EXHAUSTION,
      model: result.model,
      providerName: result.providerName,
      cached: result.cached ?? false,
      iterations: iteration,
      attempts: attempts ?? [],
      handoffs,
      trace,
      traceEvents,
      escalationDraft,
    };
  }

  trace.push({ phase: "respond", detail: `Stopped after ${MAX_ITERATIONS} iterations without a final answer` });
  return {
    content: FALLBACK_ON_EXHAUSTION,
    model: "n/a",
    providerName: "n/a",
    cached: false,
    iterations: MAX_ITERATIONS,
    attempts: attempts ?? [],
    handoffs,
    trace,
    traceEvents,
    escalationDraft,
  };
}
