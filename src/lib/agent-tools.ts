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
import { isRelevant, scoreText } from "./text-match.js";

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
        keyFacts: {
          type: "string",
          description:
            "Optional: the specific facts a human reviewer needs from the conversation so far — dates, order/account details mentioned, what the caller already tried. A few short bullet-style lines, not a transcript dump.",
        },
        suggestedAction: {
          type: "string",
          description: "Optional: what you think the human reviewer should do next.",
        },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
];

export interface EscalationDraft {
  title: string;
  description: string;
  category: string;
  priority: "low" | "normal" | "high";
  keyFacts: string | null;
  suggestedAction: string | null;
}

function searchKnowledgeBase(args: Record<string, unknown>, knowledge: AiKnowledgeInput[]): string {
  const query = typeof args.query === "string" ? args.query : "";
  const ranked = knowledge
    .filter((doc) => isRelevant(query, `${doc.title} ${doc.content}`))
    .map((doc) => ({ doc, score: scoreText(query, `${doc.title} ${doc.content}`) }))
    .sort((a, b) => b.score - a.score || a.doc.content.length - b.doc.content.length)
    .slice(0, 3);

  if (ranked.length === 0) return "No matching knowledge base articles found.";
  return ranked
    .map((r) => `### ${r.doc.title}${r.doc.page ? ` (page ${r.doc.page})` : ""}\n${r.doc.content.slice(0, 500)}`)
    .join("\n\n");
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

/** Pure synthesis step: turns the model's tool-call arguments (its read of
 * the conversation so far) into a structured brief. Exported so
 * react-agent.ts can capture the same structured object the loop hands back
 * to a human reviewer, without re-deriving it from the formatted text. */
export function buildEscalationDraft(args: Record<string, unknown>): EscalationDraft | null {
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  if (!summary) return null;

  const { category, priority } = classifyRequest(summary);
  const keyFacts = typeof args.keyFacts === "string" && args.keyFacts.trim() ? args.keyFacts.trim() : null;
  const suggestedAction =
    typeof args.suggestedAction === "string" && args.suggestedAction.trim() ? args.suggestedAction.trim() : null;

  return { title: category, description: summary, category, priority, keyFacts, suggestedAction };
}

export function formatEscalationDraft(draft: EscalationDraft): string {
  const lines = [
    "DRAFT (not submitted — a human must review and file this):",
    `Title: ${draft.title}`,
    `Description: ${draft.description}`,
    `Suggested category: ${draft.category}`,
    `Suggested priority: ${draft.priority}`,
  ];
  if (draft.keyFacts) lines.push(`Key facts: ${draft.keyFacts}`);
  if (draft.suggestedAction) lines.push(`Suggested next step: ${draft.suggestedAction}`);
  return lines.join("\n");
}

function draftEscalationTicket(args: Record<string, unknown>): string {
  const draft = buildEscalationDraft(args);
  if (!draft) return "Cannot draft a ticket without a summary of the issue.";
  return formatEscalationDraft(draft);
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
