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
import { completeWithFallback } from "./llm/gateway.js";
import type { LlmMessage } from "./llm/types.js";
import { getActiveToolDefinitions } from "./tool-registry.js";

export interface ReActStep {
  phase: "plan" | "act" | "observe" | "respond";
  detail: string;
}

export interface ReActResult {
  content: string;
  model: string;
  providerName: string;
  cached: boolean;
  iterations: number;
  /** Providers tried on the first model call, in order (the last answered it). */
  attempts: string[];
  trace: ReActStep[];
  /** Set when the loop called draft_escalation_ticket — the structured brief
   * for a human to review, kept alongside `content` rather than requiring
   * the caller to re-parse it out of the tool's text observation. */
  escalationDraft?: EscalationDraft;
}

/** Hard ceiling on Plan-Act-Observe cycles for a single turn — a structural
 * safety valve, not a business rule, so a model that keeps asking for tools
 * can't loop (and rack up provider calls) forever. */
const MAX_ITERATIONS = 4;

const FALLBACK_ON_EXHAUSTION =
  "I wasn't able to work through this fully — could you rephrase your question, or would you like me to open a support request instead?";

export async function runReActLoop(
  systemPrompt: string,
  query: string,
  knowledge: AiKnowledgeInput[],
  activeRequests: AiRequestInput[],
  account: AiAccountInput,
): Promise<ReActResult> {
  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: query },
  ];
  const trace: ReActStep[] = [];
  let attempts: string[] | undefined;
  let escalationDraft: EscalationDraft | undefined;
  const tools = await getActiveToolDefinitions();
  const allowedTools = new Set(tools.map((t) => t.name));

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    const result = await completeWithFallback(messages, tools);
    attempts ??= result.attempts ?? [];

    if (result.toolCalls && result.toolCalls.length > 0) {
      trace.push({ phase: "plan", detail: `Decided to call: ${result.toolCalls.map((c) => c.name).join(", ")}` });
      messages.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });

      for (const call of result.toolCalls) {
        if (call.argumentsParseError) {
          const observation = `Your call to "${call.name}" could not be executed: its arguments were not valid (${call.argumentsParseError}). Retry with a corrected JSON arguments object.`;
          trace.push({ phase: "act", detail: `${call.name}: rejected — ${call.argumentsParseError}` });
          console.error(`ReAct loop: rejected malformed tool-call arguments for "${call.name}": ${call.argumentsParseError}`);
          trace.push({ phase: "observe", detail: observation });
          messages.push({ role: "tool", toolCallId: call.id, content: observation });
          continue;
        }

        if (!allowedTools.has(call.name)) {
          const observation = `Tool "${call.name}" is not available.`;
          trace.push({ phase: "act", detail: `${call.name}: rejected — not an active tool` });
          trace.push({ phase: "observe", detail: observation });
          messages.push({ role: "tool", toolCallId: call.id, content: observation });
          continue;
        }

        trace.push({ phase: "act", detail: `${call.name}(${JSON.stringify(call.arguments)})` });
        const observation = executeAgentTool(call.name, call.arguments, { knowledge, activeRequests, account });
        if (call.name === "draft_escalation_ticket") {
          escalationDraft = buildEscalationDraft(call.arguments) ?? escalationDraft;
        }
        trace.push({ phase: "observe", detail: observation.slice(0, 200) });
        messages.push({ role: "tool", toolCallId: call.id, content: observation });
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
      trace,
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
    trace,
    escalationDraft,
  };
}
