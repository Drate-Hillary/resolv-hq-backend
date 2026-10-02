// Bridges the agent_tools table (what admins see and toggle) to the tools the
// ReAct loop can actually run (lib/agent-tools.ts). Handlers live in code, so
// the table controls *availability* of built-in tools; a row with no matching
// built-in is catalogue-only and is never offered to the model.
import { AGENT_TOOL_DEFINITIONS } from "./agent-tools.js";
import type { LlmToolDefinition } from "./llm/types.js";
import { prisma } from "./prisma.js";

export const BUILT_IN_TOOL_NAMES = new Set(AGENT_TOOL_DEFINITIONS.map((t) => t.name));

/** Built-in tools that must go through human approval — none today, since all
 * of them are read-only (AI Boundary Matrix). */
const BUILT_IN_REQUIRES_APPROVAL = new Set<string>();

let seeded = false;

/** Inserts any built-in tool missing from agent_tools. Never touches existing
 * rows, so an admin's is_active / requires_approval choices survive restarts. */
export async function syncBuiltInTools(): Promise<void> {
  if (seeded) return;
  await prisma.agent_tools.createMany({
    data: AGENT_TOOL_DEFINITIONS.map((t) => ({
      name: t.name,
      description: t.description,
      requires_approval: BUILT_IN_REQUIRES_APPROVAL.has(t.name),
      is_active: true,
    })),
    skipDuplicates: true,
  });
  seeded = true;
}

/** The tool definitions the model may use this turn: built-ins whose registry
 * row is active. If the registry can't be read, fails open to all built-ins
 * (logged) so a DB hiccup doesn't take the agent's tools away. */
export async function getActiveToolDefinitions(): Promise<LlmToolDefinition[]> {
  try {
    await syncBuiltInTools();
    const rows = await prisma.agent_tools.findMany({ where: { is_active: true }, select: { name: true } });
    const active = new Set(rows.map((r) => r.name));
    return AGENT_TOOL_DEFINITIONS.filter((t) => active.has(t.name));
  } catch (err) {
    console.error("tool registry unavailable, offering all built-in tools:", err);
    return AGENT_TOOL_DEFINITIONS;
  }
}
