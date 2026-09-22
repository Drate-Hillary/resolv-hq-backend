// Read-only tools available to the ReAct loop's Act step (lib/react-agent.ts).
// Every tool here only reads from data already loaded for this caller by
// chat.ts (knowledge_documents, the caller's own requests, the caller's own
// account) — none of them perform a side effect or reach outside that
// caller's own data, consistent with the AI Boundary Matrix
// (docs/ai-boundary-matrix.md): the agent can look things up and draft a
// proposal, never change anything or claim it already did.
//
// Names and scope (account_status_lookup, outage_status_checker,
// draft_escalation_ticket) come from the brief's own tool list. Per Week 3's
// own finding on this (docs/week-3-iryn.md, Task 10), the brief's
// "outage"/ticket framing has no literal analog in this schema — it's
// mapped onto the real domain model: outage_status_checker reads the
// caller's own requests (the closest real "is something broken for me"
// signal), and draft_escalation_ticket produces a *proposal* (title,
// description, category, priority) rather than creating anything, since
// this whole toolset must stay read-only.
import { classifyRequest } from "./classify.js";
import type { AiAccountInput, AiKnowledgeInput, AiRequestInput } from "./ai.js";
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
      additionalProperties: false,
    },
  },
  {
    name: "account_status_lookup",
    description:
      "Look up the caller's own account status: role, active/suspended state, organization, and location. Takes no arguments — it always resolves to the caller's own account, never another customer's.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "outage_status_checker",
    description:
      "Check whether the caller has any known open issues (support requests not yet resolved). Use this to answer 'is something wrong with my account/service?' before guessing. Takes no arguments.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "draft_escalation_ticket",
    description:
      "Prepare a DRAFT escalation ticket (title, description, suggested category and priority) for a human to review and file — this does not create or submit anything. Use this when the caller needs something a human must act on, then tell them you've prepared it for review, never that it has been filed.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "A one-sentence summary of the issue to escalate, based on the conversation so far.",
        },
      },
      required: ["summary"],
      additionalProperties: false,
    },
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

function accountStatusLookup(account: AiAccountInput): string {
  const parts = [
    `Role: ${account.role}`,
    `Status: ${account.status}`,
    account.organizationName ? `Organization: ${account.organizationName}` : null,
    account.city ? `Location: ${account.city}, ${account.country}` : `Country: ${account.country}`,
    `Member since: ${account.memberSince}`,
  ];
  return parts.filter(Boolean).join("\n");
}

function outageStatusChecker(activeRequests: AiRequestInput[]): string {
  if (activeRequests.length === 0) {
    return "No known open issues — nothing currently on file is unresolved.";
  }
  return activeRequests.map((r) => `- "${r.title}": ${r.status}`).join("\n");
}

function draftEscalationTicket(args: Record<string, unknown>): string {
  const summary = typeof args.summary === "string" ? args.summary : "";
  if (!summary.trim()) return "Cannot draft a ticket without a summary of the issue.";

  const { category, priority } = classifyRequest(summary);
  return [
    "DRAFT (not submitted — a human must review and file this):",
    `Title: ${category}`,
    `Description: ${summary.trim()}`,
    `Suggested category: ${category}`,
    `Suggested priority: ${priority}`,
  ].join("\n");
}

export function executeAgentTool(
  name: string,
  args: Record<string, unknown>,
  context: { knowledge: AiKnowledgeInput[]; activeRequests: AiRequestInput[]; account: AiAccountInput },
): string {
  switch (name) {
    case "search_knowledge_base":
      return searchKnowledgeBase(args, context.knowledge);
    case "account_status_lookup":
      return accountStatusLookup(context.account);
    case "outage_status_checker":
      return outageStatusChecker(context.activeRequests);
    case "draft_escalation_ticket":
      return draftEscalationTicket(args);
    default:
      return `Unknown tool "${name}".`;
  }
}
