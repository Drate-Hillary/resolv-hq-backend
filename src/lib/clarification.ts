// Clarification Prompting Logic: a deterministic gate that runs BEFORE the
// LLM (or the keyword-matching fallback) ever sees the query. When a
// message is too vague to route to either a knowledge-base answer or a
// request-status lookup, this returns exactly one targeted clarifying
// question instead of letting a model guess, hallucinate a category, or
// (worse) ask several questions at once. This is "structured logic," not a
// prompt instruction, so it can't be skipped by a model that decides to
// answer anyway.
//
// Every trigger phrase and its question is data (clarification_triggers
// table, see routes/admin/clarification-triggers.ts), not hardcoded in the
// app — same pattern as lib/ai-boundary.ts.
import { db } from "./supabase.js";

export interface ClarificationResult {
  question: string;
  matchedPattern: string;
}

interface CompiledTrigger {
  pattern: string;
  regex: RegExp;
  question: string;
}

interface CompiledFallback {
  question: string;
}

interface CompiledRules {
  triggers: CompiledTrigger[];
  fallback: CompiledFallback | null;
}

let cache: (CompiledRules & { expiresAt: number }) | null = null;
const CACHE_TTL_MS = 60_000;

/** A query shorter than this, with no knowledge-base signal at all, almost
 * never carries enough detail to route confidently — this is the one
 * numeric threshold that stays in code (a structural parameter, not
 * domain content, same as e.g. lib/llm/retry.ts's backoff settings). Gates
 * BOTH the specific trigger patterns and the fallback: a message that's
 * long or already knowledge-matched is never "too vague," even if it
 * happens to contain a phrase like "I have an issue" as part of something
 * more specific ("...with my invoice from March"). */
const MIN_MEANINGFUL_WORDS = 6;

/** Called by routes/admin/clarification-triggers.ts after any
 * create/update/delete so a change takes effect on the next message. */
export function invalidateClarificationCache(): void {
  cache = null;
}

async function loadCompiled(): Promise<CompiledRules> {
  if (cache && cache.expiresAt > Date.now()) return cache;

  const { data, error } = await db
    .from("clarification_triggers")
    .select("*")
    .eq("is_active", true)
    .order("created_at", { ascending: true });
  if (error) throw error;

  const triggers: CompiledTrigger[] = [];
  let fallback: CompiledFallback | null = null;

  for (const row of data ?? []) {
    if (row.is_fallback) {
      fallback = { question: row.question };
      continue;
    }
    if (!row.pattern) continue;
    try {
      triggers.push({ pattern: row.pattern, regex: new RegExp(row.pattern, "i"), question: row.question });
    } catch (err) {
      console.error(`clarification_triggers row ${row.id} has an invalid pattern, skipping:`, err);
    }
  }

  cache = { triggers, fallback, expiresAt: Date.now() + CACHE_TTL_MS };
  return cache;
}

/**
 * Returns exactly one clarifying question if `query` is too vague to route,
 * or null if it carries enough signal to answer normally.
 * `knowledgeScore` is the caller's best keyword-match score against the
 * knowledge base (0 means nothing grounded was found) — see lib/ai.ts's
 * bestKnowledgeScore, the only other caller of this function.
 */
export async function checkForClarification(query: string, knowledgeScore: number): Promise<ClarificationResult | null> {
  const trimmed = query.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;

  // A long or already knowledge-matched message is never "too vague to
  // route" — checked first so a specific trigger phrase can't misfire on
  // a message that merely contains it as part of something more detailed.
  if (wordCount >= MIN_MEANINGFUL_WORDS || knowledgeScore > 0) return null;

  const { triggers, fallback } = await loadCompiled();

  for (const t of triggers) {
    if (t.regex.test(trimmed)) {
      return { question: t.question, matchedPattern: t.pattern };
    }
  }

  if (fallback) {
    return { question: fallback.question, matchedPattern: "(fallback: short query, no knowledge-base match)" };
  }

  return null;
}
