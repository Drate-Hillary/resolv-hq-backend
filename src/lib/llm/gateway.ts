// Model Abstraction Layer: this is the one place agent/chat code calls into
// an LLM. Which provider actually runs is decided entirely by the
// agent_providers table (see routes/admin/agent-providers.ts) — registering
// a new provider or flipping active/disabled never touches this file or its
// callers, satisfying "swap providers without rewriting agent code."
//
// Resilience is layered on top of that same call: an identical request
// within CACHE_TTL_SECONDS is served from Redis without touching a provider
// at all (only for a final text answer — a turn that asks for a tool call
// is never cached, since it's one step of a stateful loop, not a
// standalone answer); a live call that fails with a transient error (rate
// limit, timeout, 5xx) is retried with exponential backoff (see retry.ts)
// before this provider is given up on and the next one is tried.
import { createHash } from "node:crypto";
import { redis } from "../redis.js";
import { db } from "../supabase.js";
import { AnthropicClient } from "./providers/anthropic.js";
import { OpenAiClient } from "./providers/openai.js";
import { withRetry } from "./retry.js";
import type { LlmClient, LlmMessage, LlmToolCall, LlmToolDefinition } from "./types.js";

export class GatewayUnavailableError extends Error {}

export interface GatewayResult {
  content: string | null;
  model: string;
  providerName: string;
  toolCalls?: LlmToolCall[];
  cached?: boolean;
}

const CACHE_TTL_SECONDS = 600;

function cacheKey(messages: LlmMessage[], tools?: LlmToolDefinition[]): string {
  const hash = createHash("sha256").update(JSON.stringify({ messages, tools })).digest("hex");
  return `llm:cache:${hash}`;
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
 * one succeeds (each attempt itself retried with backoff — see retry.ts).
 * Throws GatewayUnavailableError if none are configured or every one of
 * them exhausts its retries — callers decide how to degrade from there.
 * A cache hit short-circuits all of this and never touches a provider.
 */
export async function completeWithFallback(messages: LlmMessage[], tools?: LlmToolDefinition[]): Promise<GatewayResult> {
  const key = cacheKey(messages, tools);
  try {
    const cached = await redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as GatewayResult;
      return { ...parsed, cached: true };
    }
  } catch (err) {
    console.error("LLM cache read failed, continuing without cache:", err);
  }

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
      const completion = await withRetry(() => client.complete(messages, tools));
      const result: GatewayResult = { ...completion, providerName: row.name };

      // Only a final answer (no pending tool calls) is a standalone,
      // reusable result — an intermediate "please call this tool" turn
      // depends on everything the loop has done so far and isn't
      // meaningfully cacheable on its own.
      if (!result.toolCalls || result.toolCalls.length === 0) {
        try {
          await redis.set(key, JSON.stringify(result), "EX", CACHE_TTL_SECONDS);
        } catch (err) {
          console.error("LLM cache write failed:", err);
        }
      }

      return result;
    } catch (err) {
      failures.push(`${row.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new GatewayUnavailableError(`All registered providers failed: ${failures.join("; ")}`);
}
