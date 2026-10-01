// Shared keyword matching for knowledge retrieval (the assistant's passage
// ranking, the search_knowledge_base tool and the keyword fallback), so they
// all agree on what "relevant" means.

export const STOPWORDS = new Set([
  "the", "and", "for", "are", "how", "what", "when", "where", "who", "why", "can", "does", "did", "you", "your",
  "with", "this", "that", "from", "have", "has", "was", "were", "will", "about", "into", "there", "their", "them",
  "work", "works", "get", "got", "need", "want", "please", "tell", "show", "give", "any", "not", "but", "all",
]);

/** Strips a plural / verb ending so "refunds" matches "refund" and "invoices" matches "invoice". */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 3 && word.endsWith("es") && /(ss|sh|ch|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Distinct meaningful words in a query (lowercase, 3+ letters, no filler, lightly stemmed). */
export function queryTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w))
        .map(stem),
    ),
  );
}

/**
 * Relevance of a passage to a query: one point per distinct query term it
 * contains, plus a small bonus for repeats — so a passage that is actually
 * about "refunds" beats one that merely mentions it once alongside filler.
 */
export function scoreText(query: string, text: string): number {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of queryTerms(query)) {
    let count = 0;
    let from = haystack.indexOf(term);
    while (from !== -1 && count < 4) {
      count += 1;
      from = haystack.indexOf(term, from + term.length);
    }
    if (count > 0) score += 1 + (count - 1) * 0.15;
  }
  return score;
}
