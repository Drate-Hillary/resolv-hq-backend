// Shared by every provider adapter that turns a model's raw tool-call
// payload into LlmToolCall["arguments"] (providers/openai.ts today;
// providers/anthropic.ts uses normalizeToolArguments directly since the SDK
// hands back already-parsed JSON). Centralized so a new provider can't
// reinvent — or forget — this validation.
export interface ParsedToolArguments {
  arguments: Record<string, unknown>;
  /** Set when the model's payload wasn't a usable arguments object — the
   * caller should report this back to the model as an observation instead
   * of executing the tool with a guessed-at (empty) arguments object. */
  parseError?: string;
}

/** Validates an already-parsed value (e.g. Anthropic's `tool_use.input`). */
export function normalizeToolArguments(value: unknown): ParsedToolArguments {
  if (Array.isArray(value)) {
    return { arguments: {}, parseError: "expected a JSON object, got an array" };
  }
  if (typeof value !== "object" || value === null) {
    return { arguments: {}, parseError: `expected a JSON object, got ${typeof value}` };
  }
  return { arguments: value as Record<string, unknown> };
}

/** Parses a raw JSON string (e.g. OpenAI's `function.arguments`). */
export function parseToolArguments(raw: string): ParsedToolArguments {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { arguments: {}, parseError: `invalid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  return normalizeToolArguments(parsed);
}
