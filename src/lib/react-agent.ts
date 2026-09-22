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
import { AGENT_TOOL_DEFINITIONS, executeAgentTool } from "./agent-tools.js";
import type { AiAccountInput, AiKnowledgeInput, AiRequestInput } from "./ai.js";
import { completeWithFallback } from "./llm/gateway.js";
import type { LlmMessage } from "./llm/types.js";

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
  trace: ReActStep[];
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

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    const result = await completeWithFallback(messages, AGENT_TOOL_DEFINITIONS);

    if (result.toolCalls && result.toolCalls.length > 0) {
      trace.push({ phase: "plan", detail: `Decided to call: ${result.toolCalls.map((c) => c.name).join(", ")}` });
      messages.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });

      for (const call of result.toolCalls) {
        trace.push({ phase: "act", detail: `${call.name}(${JSON.stringify(call.arguments)})` });
        const observation = executeAgentTool(call.name, call.arguments, { knowledge, activeRequests, account });
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
      trace,
    };
  }

  trace.push({ phase: "respond", detail: `Stopped after ${MAX_ITERATIONS} iterations without a final answer` });
  return {
    content: FALLBACK_ON_EXHAUSTION,
    model: "n/a",
    providerName: "n/a",
    cached: false,
    iterations: MAX_ITERATIONS,
    trace,
  };
}
