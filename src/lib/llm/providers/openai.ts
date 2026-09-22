import OpenAI from "openai";
import type { LlmClient, LlmCompletionResult, LlmMessage, LlmToolCall, LlmToolDefinition } from "../types.js";

const DEFAULT_MODEL = "gpt-4o-mini";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function toOpenAiMessages(messages: LlmMessage[]): ChatMessage[] {
  return messages.map((m): ChatMessage => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls?.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

function toOpenAiTools(tools: LlmToolDefinition[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export class OpenAiClient implements LlmClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey: string, model: string | null) {
    this.client = new OpenAI({ apiKey });
    this.model = model ?? DEFAULT_MODEL;
  }

  async complete(messages: LlmMessage[], tools?: LlmToolDefinition[]): Promise<LlmCompletionResult> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAiMessages(messages),
      max_tokens: 600,
      tools: tools && tools.length > 0 ? toOpenAiTools(tools) : undefined,
    });

    const message = res.choices[0]?.message;
    if (!message) throw new Error("OpenAI returned no message");

    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCalls: LlmToolCall[] = message.tool_calls
        .filter((call): call is typeof call & { type: "function" } => call.type === "function")
        .map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: safeParseArguments(call.function.arguments),
        }));
      return { content: null, model: this.model, toolCalls };
    }

    const content = message.content?.trim();
    if (!content) throw new Error("OpenAI returned no content");
    return { content, model: this.model };
  }
}

function safeParseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
