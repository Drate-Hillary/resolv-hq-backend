// Model Abstraction Layer: this is the one place agent/chat code calls into
// an LLM. Which provider actually runs is decided entirely by the
// agent_providers table (see routes/admin/agent-providers.ts) — registering
// a new provider or flipping active/disabled never touches this file or its
// callers, satisfying "swap providers without rewriting agent code."
import { db } from "../supabase.js";
import { AnthropicClient } from "./providers/anthropic.js";
import { OpenAiClient } from "./providers/openai.js";
import type { LlmClient, LlmMessage } from "./types.js";

export class GatewayUnavailableError extends Error {}

export interface GatewayResult {
  content: string;
  model: string;
  providerName: string;
}

function buildClient(row: { provider: string; model: string | null; api_key: string }): LlmClient | null {
  switch (row.provider) {
    case "openai":
      return new OpenAiClient(row.api_key, row.model);
    case "anthropic":
      return new AnthropicClient(row.api_key, row.model);
    default:
      // "google" / "custom" are registerable today but have no client
      // implementation yet — add a providers/<name>.ts and a case here.
      return null;
  }
}

/**
 * Tries every active agent_providers row, oldest-registered first, until
 * one succeeds. Throws GatewayUnavailableError if none are configured or
 * every one of them fails — callers decide how to degrade from there.
 */
export async function completeWithFallback(messages: LlmMessage[]): Promise<GatewayResult> {
  const { data, error } = await db
    .from("agent_providers")
    .select("id, name, provider, model, api_key")
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error) throw error;

  const providers = data ?? [];
  if (providers.length === 0) {
    throw new GatewayUnavailableError("No active model providers registered");
  }

  const failures: string[] = [];
  for (const row of providers) {
    const client = buildClient(row);
    if (!client) {
      failures.push(`${row.name}: provider "${row.provider}" has no client implementation yet`);
      continue;
    }
    try {
      const result = await client.complete(messages);
      return { ...result, providerName: row.name };
    } catch (err) {
      failures.push(`${row.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new GatewayUnavailableError(`All registered providers failed: ${failures.join("; ")}`);
}
