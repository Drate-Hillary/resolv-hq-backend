// Structural backstop for the AI Boundary Matrix, complementing the
// prompt-level constraint in lib/prompts/system-prompt.ts (rule 2: "No
// fabricated actions" — see docs/system-prompt-spec.md §4/§5). A prompt is
// an instruction, not a guarantee: this is a deterministic check on the
// model's actual output that catches a fabricated-action claim independent
// of whether the model followed the prompt.
//
// Every category, detection pattern, and fallback message is data, not
// code — it all comes from the boundary_rules table (see
// routes/admin/boundary-rules.ts for the CRUD that manages it), so adding,
// retiring, or tuning a rule never requires a code change or a redeploy.
import { db } from "./supabase.js";

export interface BoundaryViolation {
  category: string;
  matchedText: string;
  fallbackMessage: string;
}

interface CompiledRule {
  category: string;
  regex: RegExp;
  fallbackMessage: string;
}

let cache: { rules: CompiledRule[]; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

/** Called by routes/admin/boundary-rules.ts after any create/update/delete
 * so a change takes effect on the next message instead of waiting out the
 * cache TTL. */
export function invalidateBoundaryRulesCache(): void {
  cache = null;
}

async function loadCompiledRules(): Promise<CompiledRule[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.rules;

  const { data, error } = await db
    .from("boundary_rules")
    .select("*")
    .eq("is_active", true)
    .order("created_at", { ascending: true });
  if (error) throw error;

  const rules: CompiledRule[] = [];
  for (const row of data ?? []) {
    try {
      rules.push({ category: row.category, regex: new RegExp(row.pattern, "i"), fallbackMessage: row.fallback_message });
    } catch (err) {
      console.error(`boundary_rules row ${row.id} ("${row.category}") has an invalid pattern, skipping:`, err);
    }
  }

  cache = { rules, expiresAt: Date.now() + CACHE_TTL_MS };
  return rules;
}

/** Returns the first matched active rule, or null if the text trips none
 * of them. */
export async function detectBoundaryViolation(text: string): Promise<BoundaryViolation | null> {
  const rules = await loadCompiledRules();
  for (const rule of rules) {
    const match = text.match(rule.regex);
    if (match) return { category: rule.category, matchedText: match[0], fallbackMessage: rule.fallbackMessage };
  }
  return null;
}
