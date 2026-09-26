// The one interface every provider implementation and every caller (chat.ts,
// lib/react-agent.ts) depends on. Swapping or adding a provider means
// writing a new file under providers/ that implements this — nothing that
// calls completeWithFallback (see gateway.ts) ever changes.
//
// Tool-calling support (LlmToolDefinition/LlmToolCall, the "tool" role, and
// the optional `toolCalls` on both an assistant message and a completion
// result) is what lets lib/react-agent.ts's Act step be a REAL model
// decision — the model chooses whether to call a tool and with what
// arguments; the loop just executes whatever it asks for.
export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments object. */
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Set when the provider's raw tool-call payload wasn't a usable JSON
   * object (see llm/tool-arguments.ts) — `arguments` is `{}` in that case
   * and the caller (lib/react-agent.ts) should report the failure back to
   * the model rather than execute the tool with guessed-at arguments. */
  argumentsParseError?: string;
}

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface LlmCompletionResult {
  /** Null when the model chose to call tools instead of answering. */
  content: string | null;
  model: string;
  toolCalls?: LlmToolCall[];
}

export interface LlmClient {
  complete(messages: LlmMessage[], tools?: LlmToolDefinition[]): Promise<LlmCompletionResult>;
}
