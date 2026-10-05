// Keeps what we send to a model inside a predictable size. Retrieved
// passages and tool observations are packed into a character budget
// (~4 chars per token) instead of being cut at an arbitrary offset, and
// anything oversized is trimmed at a sentence boundary so the model never
// sees a half-sentence.

export const KNOWLEDGE_CONTEXT_BUDGET_CHARS = Number(process.env.KNOWLEDGE_CONTEXT_BUDGET_CHARS) || 4000;
export const TOOL_OBSERVATION_BUDGET_CHARS = Number(process.env.TOOL_OBSERVATION_BUDGET_CHARS) || 3000;

/** Trims text to at most `max` characters, ending on a sentence (or word) boundary with an ellipsis. */
export function truncateAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("\n"));
  const end = sentenceEnd > max * 0.5 ? sentenceEnd + 1 : cut.lastIndexOf(" ");
  return `${cut.slice(0, end > 0 ? end : max).trimEnd()}…`;
}

/**
 * Greedily packs already-ranked blocks (best first) into the budget. A block
 * that doesn't fit whole is trimmed to the space left if that's still
 * useful (>=200 chars); otherwise packing stops.
 */
export function packIntoBudget(blocks: string[], budget = KNOWLEDGE_CONTEXT_BUDGET_CHARS, separator = "\n\n"): string {
  const out: string[] = [];
  let used = 0;
  for (const block of blocks) {
    const cost = block.length + (out.length > 0 ? separator.length : 0);
    if (used + cost <= budget) {
      out.push(block);
      used += cost;
    } else {
      const remaining = budget - used - (out.length > 0 ? separator.length : 0);
      if (remaining >= 200) out.push(truncateAtBoundary(block, remaining));
      break;
    }
  }
  return out.join(separator);
}
