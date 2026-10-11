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
import { prisma } from "../prisma.js";
import { AnthropicClient } from "./providers/anthropic.js";
import { GoogleClient } from "./providers/google.js";
import { LangChainClient } from "./providers/langchain.js";
import { OpenAiClient } from "./providers/openai.js";
import { withRetry } from "./retry.js";
import type { LlmClient, LlmMessage, LlmToolCall, LlmToolDefinition } from "./types.js";

export interface ProviderHandoff {
  from: string;
  to: string;
  reason: "usage_limit" | "provider_error" | "unsupported";
}

export class GatewayUnavailableError extends Error {
  constructor(
    message: string,
    readonly attempts: string[] = [],
    readonly failedProviderIds: string[] = [],
    readonly handoffs: ProviderHandoff[] = [],
  ) {
    super(message);
    this.name = "GatewayUnavailableError";
  }
}

export interface GatewayResult {
  content: string | null;
  model: string;
  providerName: string;
  providerId?: string;
  toolCalls?: LlmToolCall[];
  cached?: boolean;
  /** Providers tried for this call, in order; the last one answered. */
  attempts?: string[];
  /** Providers that failed during this call and should not be retried this task. */
  failedProviderIds?: string[];
  /** Explicit task handoffs made before a provider answered. */
  handoffs?: ProviderHandoff[];
}

const CACHE_TTL_SECONDS = 600;

function cacheKey(messages: LlmMessage[], tools?: LlmToolDefinition[]): string {
  const hash = createHash("sha256").update(JSON.stringify({ messages, tools })).digest("hex");
  return `llm:cache:${hash}`;
}

function isUsageLimitError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  const message = err instanceof Error ? err.message : String(err);
  return status === 429 || /quota|rate.?limit|credit balance|insufficient credits|token limit|context length|usage limit|resource_exhausted/i.test(message);
}

export function buildClient(row: { provider: string; model: string | null; api_key: string }): LlmClient | null {
  switch (row.provider) {
    case "openai":
      return new OpenAiClient(row.api_key, row.model);
    case "anthropic":
      return new AnthropicClient(row.api_key, row.model);
    case "google":
      return new GoogleClient(row.api_key, row.model);
    case "langchain":
      return new LangChainClient(row.api_key, row.model);
    default:
      // "custom" is registerable today but has no client
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
export async function completeWithFallback(
  messages: LlmMessage[],
  tools?: LlmToolDefinition[],
  excludedProviderIds: string[] = [],
): Promise<GatewayResult> {
  const key = cacheKey(messages, tools);
  try {
    const cached = await redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as GatewayResult;
      return { ...parsed, cached: true, attempts: [], failedProviderIds: [], handoffs: [] };
    }
  } catch (err) {
    console.error("LLM cache read failed, continuing without cache:", err);
  }

  const registeredProviders = await prisma.agent_providers.findMany({
    where: { status: "active" },
    select: { id: true, name: true, provider: true, model: true, api_key: true },
    orderBy: { created_at: "asc" },
  });
  const excludedIds = new Set(excludedProviderIds);
  const providers = registeredProviders.filter((provider) => !excludedIds.has(provider.id));
  if (providers.length === 0) {
    const message = registeredProviders.length === 0
      ? "No active model providers registered"
      : "All active model providers have already failed during this task";
    throw new GatewayUnavailableError(message);
  }

  const failures: string[] = [];
  const attempts: string[] = [];
  const failedProviderIds: string[] = [];
  const handoffs: ProviderHandoff[] = [];
  for (const [index, row] of providers.entries()) {
    const client = buildClient(row);
    if (!client) {
      failures.push(`${row.name}: provider "${row.provider}" has no client implementation yet`);
      attempts.push(row.name);
      failedProviderIds.push(row.id);
      const next = providers[index + 1];
      if (next) handoffs.push({ from: row.name, to: next.name, reason: "unsupported" });
      continue;
    }
    try {
      const completion = await withRetry(() => client.complete(messages, tools));
      attempts.push(row.name);
      const result: GatewayResult = {
        ...completion,
        providerName: row.name,
        providerId: row.id,
        attempts,
        failedProviderIds,
        handoffs,
      };

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
      attempts.push(row.name);
      failedProviderIds.push(row.id);
      const next = providers[index + 1];
      if (next) {
        handoffs.push({
          from: row.name,
          to: next.name,
          reason: isUsageLimitError(err) ? "usage_limit" : "provider_error",
        });
      }
    }
  }

  throw new GatewayUnavailableError(
    `All registered providers failed: ${failures.join("; ")}`,
    attempts,
    failedProviderIds,
    handoffs,
  );
}
