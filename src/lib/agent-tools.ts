// Read-only tools available to the ReAct loop's Act step (lib/react-agent.ts).
// Every tool here only reads from data already loaded for this caller by
// chat.ts (knowledge_documents + the caller's own requests) — none of them
// perform a side effect or reach outside that caller's own data, consistent
// with the AI Boundary Matrix (docs/ai-boundary-matrix.md): the agent can
// look things up, never change anything.
import type { AiKnowledgeInput, AiRequestInput } from "./ai.js";
import type { LlmToolDefinition } from "./llm/types.js";

export const AGENT_TOOL_DEFINITIONS: LlmToolDefinition[] = [
  {
    name: "search_knowledge_base",
    description:
      "Search the published knowledge base for articles relevant to a topic. Use this whenever you need information to answer the customer instead of guessing.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The topic or question to search for." },
      },
      required: ["query"],
    },
  },
  {
    name: "check_request_status",
    description: "Look up the status of the caller's own support request(s). Takes no arguments.",
    parameters: { type: "object", properties: {} },
  },
];

function scoreMatch(query: string, haystack: string): number {
  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  let score = 0;
  for (const w of words) {
    if (haystack.toLowerCase().includes(w)) score += 1;
  }
  return score;
}

function searchKnowledgeBase(args: Record<string, unknown>, knowledge: AiKnowledgeInput[]): string {
  const query = typeof args.query === "string" ? args.query : "";
  const ranked = knowledge
    .map((doc) => ({ doc, score: scoreMatch(query, `${doc.title} ${doc.content}`) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (ranked.length === 0) return "No matching knowledge base articles found.";
  return ranked.map((r) => `### ${r.doc.title}\n${r.doc.content.slice(0, 500)}`).join("\n\n");
}

function checkRequestStatus(activeRequests: AiRequestInput[]): string {
  if (activeRequests.length === 0) return "The caller has no requests on file.";
  return activeRequests.map((r) => `- "${r.title}": ${r.status}`).join("\n");
}

export function executeAgentTool(
  name: string,
  args: Record<string, unknown>,
  context: { knowledge: AiKnowledgeInput[]; activeRequests: AiRequestInput[] },
): string {
  switch (name) {
    case "search_knowledge_base":
      return searchKnowledgeBase(args, context.knowledge);
    case "check_request_status":
      return checkRequestStatus(context.activeRequests);
    default:
      return `Unknown tool "${name}".`;
  }
}
