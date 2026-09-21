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
import { completeWithFallback, GatewayUnavailableError } from "./llm/gateway.js";
import type { LlmMessage } from "./llm/types.js";

export interface AiKnowledgeInput {
  id: string;
  title: string;
  content: string;
}

export interface AiRequestInput {
  id: string;
  title: string;
  status: string;
}

export interface AiAnswer {
  text: string;
  sources: { id: string; title: string }[];
  suggestions: string[];
  steps: string[];
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

  const ranked = knowledge
    .map((doc) => ({
      doc,
      score: scoreArticle(lower, `${doc.title} ${doc.content}`),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length > 0) {
    const top = ranked[0].doc;
    return {
      text: top.content.slice(0, 500),
      sources: [{ id: top.id, title: top.title }],
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
export async function generateAssistantReply(
  query: string,
  knowledge: AiKnowledgeInput[],
  activeRequests: AiRequestInput[],
): Promise<AiAnswer> {
  try {
    const knowledgeContext = knowledge
      .slice(0, 5)
      .map((d) => `### ${d.title}\n${d.content.slice(0, 800)}`)
      .join("\n\n");
    const requestContext = activeRequests
      .slice(0, 5)
      .map((r) => `- "${r.title}": ${r.status}`)
      .join("\n");

    const messages: LlmMessage[] = [
      {
        role: "system",
        content: [
          "You are the Resolv-HQ customer support assistant. Answer briefly and helpfully using only the context below.",
          "If the answer isn't in the context, say so and offer to create a support request instead.",
          knowledgeContext ? `Knowledge base:\n${knowledgeContext}` : "",
          requestContext ? `Customer's requests:\n${requestContext}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      { role: "user", content: query },
    ];

    const result = await completeWithFallback(messages);
    return {
      text: result.content,
      sources: knowledge.slice(0, 3).map((d) => ({ id: d.id, title: d.title })),
      suggestions: [],
      steps: [
        ...DEFAULT_STEPS.slice(0, 2),
        result.cached ? "Found a cached answer" : `Calling ${result.providerName} (${result.model})`,
        "Preparing your response",
      ],
    };
  } catch (err) {
    if (!(err instanceof GatewayUnavailableError)) {
      console.error("LLM gateway call failed unexpectedly, falling back to keyword search:", err);
    }
    return answerQuestion(query, knowledge, activeRequests);
  }
}

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  Billing: ["invoice", "charge", "payment", "bill", "refund", "price"],
  "Account support": ["password", "login", "account", "email", "profile", "access"],
  "Service assistance": ["sync", "integration", "error", "bug", "broken", "not working", "issue"],
  "Product question": ["how", "what", "can i", "does", "feature"],
};

export function classifyRequest(description: string): {
  category: string;
  priority: "low" | "normal" | "high";
} {
  const lower = description.toLowerCase();
  let best = "Service assistance";
  let bestScore = 0;
  for (const [category, words] of Object.entries(CATEGORY_KEYWORDS)) {
    const score = words.reduce((acc, w) => acc + (lower.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = category;
    }
  }
  const urgentWords = ["urgent", "asap", "immediately", "broken", "down", "can't", "cannot"];
  const priority: "low" | "normal" | "high" = urgentWords.some((w) => lower.includes(w))
    ? "high"
    : description.length < 40
      ? "low"
      : "normal";
  return { category: best, priority };
}
