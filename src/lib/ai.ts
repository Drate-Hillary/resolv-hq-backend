// Ported from resolv-hq-customer/backend/ai-responses.ts. Same keyword-matching
// logic, now fed real DB reads (knowledge_documents / requests) instead of
// client-supplied arrays. help_articles no longer exists as a table, so the
// knowledge base for this is now knowledge_documents.
//
// answerQuestion() below is the deterministic, no-API-key-required fallback.
// generateAssistantReply() is the real entry point: it calls the Model
// Abstraction Layer (lib/llm/gateway.ts) first and only drops back to
// answerQuestion() if no provider is registered/active or every one fails —
// so the chat keeps working in dev with zero keys configured.
import type { EscalationDraft } from "./agent-tools.js";
import { detectBoundaryViolation } from "./ai-boundary.js";
import { checkForClarification } from "./clarification.js";
import { packIntoBudget } from "./context-budget.js";
import { buildSystemPrompt } from "./prompts/system-prompt.js";
import { runReActLoop, type ReActStep } from "./react-agent.js";
import { isRelevant, queryTerms, scoreText } from "./text-match.js";
import { stagesFromTrace, type AgentFlowRecord } from "./llm/flow-log.js";

/** One retrievable passage of a knowledge document (see lib/knowledge-index.ts) — not the whole document. */
export interface AiKnowledgeInput {
  /** The owning document's id. Several passages can share one. */
  id: string;
  title: string;
  content: string;
  page?: number;
  heading?: string;
  /** Cosine similarity to the query when semantic search matched this passage (lib/embeddings.ts). */
  semanticScore?: number;
}

export interface AiRequestInput {
  id: string;
  title: string;
  status: string;
}

export interface AiAccountInput {
  role: string;
  status: string;
  organizationName: string | null;
  city: string | null;
  country: string;
  memberSince: string;
}

export interface AiAnswer {
  text: string;
  sources: { id: string; title: string; score?: number; pages?: number[] }[];
  suggestions: string[];
  steps: string[];
  /** Model that wrote this answer; unset for keyword-fallback/canned answers. */
  model?: string;
  /** Path this answer took through providers and ReAct stages, for the flow diagram. */
  flow?: AgentFlowRecord;
  /** Structured Plan/Act/Observe trace of the ReAct loop — `steps` above is
   * the same information flattened to display strings. */
  trace?: ReActStep[];
  /** Set when the model call failed and this answer came from the keyword
   * fallback instead — why it did, so the console can say so. */
  fallbackReason?: string;
  /** Set when the assistant drafted an escalation ticket this turn — the
   * caller (routes/chat.ts) persists it as an agent_approvals row so a human
   * can actually review it; it is never filed on the model's say-so. */
  escalationDraft?: EscalationDraft;
}

const DEFAULT_STEPS = [
  "Understanding your request",
  "Checking available information",
  "Finding relevant guidance",
  "Preparing your response",
];

function scoreArticle(query: string, haystack: string): number {
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

/**
 * The few sentences of a passage that actually speak to the question, in
 * their original order — what the keyword fallback returns instead of the
 * whole passage (the model path does this itself, guided by the prompt).
 */
export function bestSentences(query: string, passage: string, max = 3): string {
  const terms = queryTerms(query);
  const sentences = passage.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)?.map((x) => x.trim()) ?? [passage];
  const scored = sentences
    .map((sentence, index) => ({
      sentence,
      index,
      score: terms.filter((t) => sentence.toLowerCase().includes(t)).length,
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index);

  if (scored.length === 0) return passage.slice(0, 300);
  return scored.map((x) => x.sentence).join(" ");
}

export function answerQuestion(
  query: string,
  knowledge: AiKnowledgeInput[],
  activeRequests: AiRequestInput[],
): AiAnswer {
  const lower = query.toLowerCase();

  if (/\brequest\b|\bstatus\b/i.test(query) && activeRequests.length > 0) {
    const target = activeRequests[0];
    return {
      text: `Your request "${target.title}" is currently ${target.status}.`,
      sources: [{ id: "live", title: "Your request history" }],
      suggestions: [
        `What happens after "${target.title}" is reviewed?`,
        "How do I add more details to a request?",
      ],
      steps: [...DEFAULT_STEPS.slice(0, 2), "Checking your open requests", "Preparing your response"],
    };
  }

  const ranked = rankKnowledge(lower, knowledge);

  if (ranked.length > 0) {
    const top = ranked[0].doc;
    return {
      text: bestSentences(query, top.content),
      sources: toSources(ranked.slice(0, 1)).map(({ id, title, pages }) => ({ id, title, pages })),
      suggestions: ranked
        .slice(1, 3)
        .map((r) => r.doc.title)
        .concat(ranked.length === 1 ? ["How do I submit a request?"] : []),
      steps: DEFAULT_STEPS,
    };
  }

  return {
    text:
      "I couldn't find an exact match in our knowledge base, but I can create a request so a specialist can help directly. Want me to start one?",
    sources: [],
    suggestions: [
      "Create a request about this",
      "How do I submit a request?",
      "What's the status of my last request?",
    ],
    steps: DEFAULT_STEPS,
  };
}

/**
 * Real entry point for chat.ts: calls whichever agent_providers row is
 * active (with automatic fallback across providers) grounded in the
 * knowledge base and the caller's own requests, and falls back to the
 * deterministic answerQuestion() if no provider is configured or every
 * provider call fails.
 */
/** Knowledge documents that actually match the query, best first. Used for
 * both the prompt context and the reported sources, so what the model was
 * shown and what the UI says was retrieved are the same set. */
/** Collapses ranked passages into distinct source documents (best first), keeping which pages matched. */
function toSources(
  ranked: { doc: AiKnowledgeInput; score: number }[],
  limit = 3,
): { id: string; title: string; score: number; pages: number[] }[] {
  const byDoc = new Map<string, { id: string; title: string; score: number; pages: number[] }>();
  for (const { doc, score } of ranked) {
    const entry = byDoc.get(doc.id) ?? { id: doc.id, title: doc.title, score, pages: [] };
    if (doc.page && !entry.pages.includes(doc.page)) entry.pages.push(doc.page);
    byDoc.set(doc.id, entry);
  }
  return Array.from(byDoc.values())
    .slice(0, limit)
    .map((e) => ({ ...e, pages: e.pages.sort((a, b) => a - b) }));
}

function rankKnowledge(query: string, knowledge: AiKnowledgeInput[]): { doc: AiKnowledgeInput; score: number }[] {
  // Hybrid retrieval: a passage counts if it matches by keyword OR was a
  // semantic hit, and a semantic hit adds to its rank (similarity 0.5 is
  // worth ~5 keyword points) so paraphrased questions still find the passage.
  return knowledge
    .filter((doc) => doc.semanticScore !== undefined || isRelevant(query, `${doc.title} ${doc.content}`))
    .map((doc) => ({
      doc,
      score: scoreText(query, `${doc.title} ${doc.content}`) + (doc.semanticScore ?? 0) * 10,
    }))
    .sort((a, b) => b.score - a.score || a.doc.content.length - b.doc.content.length);
}

function bestKnowledgeScore(query: string, knowledge: AiKnowledgeInput[]): number {
  return knowledge.reduce((max, doc) => Math.max(max, scoreArticle(query, `${doc.title} ${doc.content}`)), 0);
}

export async function generateAssistantReply(
  query: string,
  knowledge: AiKnowledgeInput[],
  activeRequests: AiRequestInput[],
  account: AiAccountInput,
  isStaffCaller = false,
): Promise<AiAnswer> {
  // Clarification Prompting Logic: a deterministic gate, not a prompt
  // instruction — runs before the LLM (or the keyword fallback) ever sees
  // the query, so a vague message always gets exactly one targeted
  // clarifying question instead of a guess, regardless of what a model
  // would have done with it. Skipped when the query clearly wants a
  // request-status lookup, which is never ambiguous.
  const isRequestStatusQuery = /\brequest\b|\bstatus\b/i.test(query) && activeRequests.length > 0;
  if (!isRequestStatusQuery) {
    try {
      const clarification = await checkForClarification(query, bestKnowledgeScore(query, knowledge));
      if (clarification) {
        console.warn(`Clarification requested (matched: ${clarification.matchedPattern}) for query: "${query}"`);
        return {
          text: clarification.question,
          sources: [],
          suggestions: [],
          steps: [DEFAULT_STEPS[0], "This needs a bit more detail before I can help"],
        };
      }
    } catch (err) {
      console.error("Clarification check failed, continuing without it:", err);
    }
  }

  try {
    const ranked = rankKnowledge(query, knowledge);
    // Best-first passages packed into a size budget (lib/context-budget.ts)
    // rather than a fixed count and length, so context size stays predictable.
    const knowledgeContext = packIntoBudget(
      ranked.map(
        ({ doc: d }) =>
          `### ${d.title}${d.heading ? ` - ${d.heading}` : ""}${d.page ? ` (page ${d.page})` : ""}\n${d.content}`,
      ),
    );
    const requestContext = activeRequests
      .slice(0, 5)
      .map((r) => `- "${r.title}": ${r.status}`)
      .join("\n");

    const systemPrompt = buildSystemPrompt({ knowledgeContext, requestContext, isStaffCaller });

    // ReAct Loop Core Implementation (lib/react-agent.ts): Sense (query +
    // context, above) -> Plan -> Act -> Observe, repeated until the model
    // responds with a final answer instead of another tool call.
    const result = await runReActLoop(systemPrompt, query, knowledge, activeRequests, account);

    // Structural backstop: the prompt (lib/prompts/system-prompt.ts, rule 2)
    // already tells the model never to claim a fabricated action, but that's
    // an instruction, not a guarantee — this catches it independent of
    // whether the model complied.
    const violation = await detectBoundaryViolation(result.content);
    if (violation) {
      console.warn(
        `AI Boundary Matrix violation blocked (${violation.category}): "${violation.matchedText}" — original response discarded.`,
      );
    }

    const traceSteps = result.trace.map((step) => {
      switch (step.phase) {
        case "plan":
          return `Planning: ${step.detail}`;
        case "act":
          return `Acting: ${step.detail}`;
        case "observe":
          return `Observed: ${step.detail}`;
        case "respond":
          return step.detail;
      }
    });

    return {
      text: violation ? violation.fallbackMessage : result.content,
      sources: toSources(ranked),
      suggestions: [],
      steps: [
        DEFAULT_STEPS[0],
        result.cached ? "Found a cached answer" : `Calling ${result.providerName} (${result.model})`,
        ...traceSteps,
        violation ? "Blocked a boundary-matrix violation" : undefined,
      ].filter((s): s is string => Boolean(s)),
      trace: result.trace,
      escalationDraft: result.escalationDraft,
      model: violation ? undefined : result.model,
      flow: {
        kind: "model",
        provider: result.providerName,
        model: result.model,
        attempts: result.attempts,
        cached: result.cached,
        stages: stagesFromTrace(result.trace),
        outcome: violation ? "blocked" : result.escalationDraft ? "escalated" : "answered",
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`LLM gateway unavailable, falling back to keyword search: ${reason}`);
    return {
      ...answerQuestion(query, knowledge, activeRequests),
      fallbackReason: reason,
      flow: {
        kind: "fallback",
        provider: null,
        model: null,
        attempts: [],
        cached: false,
        stages: [],
        outcome: "fallback",
        failureReason: reason,
      },
    };
  }
}

// Re-exported for existing callers (routes/ai.ts, routes/requests.ts) — the
// implementation moved to lib/classify.ts so lib/agent-tools.ts (the
// draft_escalation_ticket tool) can reuse it without a circular import
// through ai.ts -> react-agent.ts -> agent-tools.ts -> ai.ts.
export { classifyRequest } from "./classify.js";
