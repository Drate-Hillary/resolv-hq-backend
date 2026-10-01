import { normalizeToolArguments } from "../tool-arguments.js";
import type { LlmClient, LlmCompletionResult, LlmMessage, LlmToolCall, LlmToolDefinition } from "../types.js";

const DEFAULT_MODEL = "gemini-3.8-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

/** Gemini has no "tool" role or call ids: a tool result is a `functionResponse`
 * part (keyed by function *name*) in a user turn. Our LlmMessage tool results
 * carry the call id, so the id -> name mapping is rebuilt from the assistant
 * turns that issued the calls; consecutive results merge into one user turn. */
function toGeminiContents(messages: LlmMessage[]): GeminiContent[] {
  const nameByCallId = new Map<string, string>();
  const contents: GeminiContent[] = [];

  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "tool") {
      const part: GeminiPart = {
        functionResponse: { name: nameByCallId.get(m.toolCallId) ?? "unknown_tool", response: { result: m.content } },
      };
      const last = contents[contents.length - 1];
      if (last?.role === "user" && last.parts.every((p) => "functionResponse" in p)) last.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
      continue;
    }

    if (m.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const call of m.toolCalls ?? []) {
        nameByCallId.set(call.id, call.name);
        parts.push({
          functionCall: { name: call.name, args: call.arguments },
          ...(call.providerMeta && { thoughtSignature: call.providerMeta }),
        });
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }

    contents.push({ role: "user", parts: [{ text: m.content }] });
  }

  return contents;
}

/** Gemini accepts only an OpenAPI-style schema subset: drop keys it rejects
 * (additionalProperties, $schema), and omit `parameters` entirely for a
 * no-argument tool, since an object schema with empty `properties` is an error. */
function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "additionalProperties" || k === "$schema") continue;
    out[k] = cleanSchema(v);
  }
  return out;
}

function toGeminiTools(tools: LlmToolDefinition[]) {
  return [
    {
      functionDeclarations: tools.map((t) => {
        const params = cleanSchema(t.parameters) as { properties?: Record<string, unknown> };
        const hasArgs = params.properties && Object.keys(params.properties).length > 0;
        return { name: t.name, description: t.description, ...(hasArgs && { parameters: params }) };
      }),
    },
  ];
}

export class GoogleClient implements LlmClient {
  private readonly model: string;

  constructor(
    private readonly apiKey: string,
    model: string | null,
  ) {
    this.model = model ?? DEFAULT_MODEL;
  }

  async complete(messages: LlmMessage[], tools?: LlmToolDefinition[]): Promise<LlmCompletionResult> {
    const system = messages.find((m): m is Extract<LlmMessage, { role: "system" }> => m.role === "system")?.content;

    const res = await fetch(`${API_BASE}/${encodeURIComponent(this.model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        contents: toGeminiContents(messages),
        ...(system && { systemInstruction: { parts: [{ text: system }] } }),
        ...(tools && tools.length > 0 && { tools: toGeminiTools(tools) }),
        // Gemini counts internal "thinking" tokens against this limit, so
        // it needs more headroom than the other providers' 600.
        generationConfig: { maxOutputTokens: 2048 },
      }),
    });

    if (!res.ok) {
      // `status` lets retry.ts treat 429/5xx as transient, like the SDK errors.
      throw Object.assign(new Error(`Google ${res.status}: ${(await res.text()).slice(0, 500)}`), { status: res.status });
    }

    const data = (await res.json()) as GeminiResponse;
    if (data.promptFeedback?.blockReason) throw new Error(`Google blocked the prompt: ${data.promptFeedback.blockReason}`);
    const parts = data.candidates?.[0]?.content?.parts ?? [];

    const calls = parts.filter((p): p is Extract<GeminiPart, { functionCall: unknown }> => "functionCall" in p);
    if (calls.length > 0) {
      const toolCalls: LlmToolCall[] = calls.map((p, i) => {
        const { arguments: args, parseError } = normalizeToolArguments(p.functionCall.args ?? {});
        return {
          id: `gemini-call-${Date.now()}-${i}`,
          name: p.functionCall.name,
          arguments: args,
          argumentsParseError: parseError,
          providerMeta: p.thoughtSignature,
        };
      });
      const text = parts.filter((p): p is { text: string } => "text" in p).map((p) => p.text).join("").trim();
      return { content: text || null, model: this.model, toolCalls };
    }

    const text = parts.filter((p): p is { text: string } => "text" in p).map((p) => p.text).join("").trim();
    if (!text) throw new Error(`Google returned no text content (finishReason: ${data.candidates?.[0]?.finishReason ?? "none"})`);
    return { content: text, model: this.model };
  }
}
