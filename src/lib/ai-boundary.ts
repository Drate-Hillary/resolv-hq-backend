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
import { prisma } from "./prisma.js";
import { getOrLoadRedisCache, invalidateRedisCache } from "./redis-cache.js";

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

const BOUNDARY_RULES_CACHE_KEY = "db-cache:guardrails:boundary-rules:v1";
const CACHE_TTL_SECONDS = 60;

/** Called by routes/admin/boundary-rules.ts after any create/update/delete
 * so a change takes effect on the next message instead of waiting out the
 * cache TTL. */
export async function invalidateBoundaryRulesCache(): Promise<void> {
  await invalidateRedisCache(BOUNDARY_RULES_CACHE_KEY);
}

async function loadCompiledRules(): Promise<CompiledRule[]> {
  const rows = await getOrLoadRedisCache(BOUNDARY_RULES_CACHE_KEY, CACHE_TTL_SECONDS, () =>
    prisma.boundary_rules.findMany({
      where: { is_active: true },
      orderBy: { created_at: "asc" },
    }),
  );

  const rules: CompiledRule[] = [];
  for (const row of rows) {
    try {
      rules.push({ category: row.category, regex: new RegExp(row.pattern, "i"), fallbackMessage: row.fallback_message });
    } catch (err) {
      console.error(`boundary_rules row ${row.id} ("${row.category}") has an invalid pattern, skipping:`, err);
    }
  }

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
