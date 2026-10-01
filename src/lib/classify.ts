// Split out of ai.ts so lib/agent-tools.ts (the draft_escalation_ticket
// tool) can reuse this without importing ai.ts and creating a circular
// import (ai.ts -> react-agent.ts -> agent-tools.ts -> ai.ts).
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
