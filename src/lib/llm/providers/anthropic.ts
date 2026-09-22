import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmCompletionResult, LlmMessage, LlmToolCall, LlmToolDefinition } from "../types.js";

const DEFAULT_MODEL = "claude-sonnet-4-5";

type AnthropicMessage = Anthropic.Messages.MessageParam;

/**
 * Anthropic has no "tool" role — a tool result is a `user` message whose
 * content is a `tool_result` block referencing the assistant's `tool_use`
 * id. Consecutive tool-role LlmMessages (one per call from the same Act
 * step) are merged into a single user message, matching how a real
 * multi-tool-call turn is represented.
 */
function toAnthropicMessages(messages: LlmMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "tool") {
      const block: Anthropic.Messages.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
      };
      const last = result[result.length - 1];
      if (last?.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        result.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (m.role === "assistant") {
      const blocks: Anthropic.Messages.ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const call of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
      }
      result.push({ role: "assistant", content: blocks });
      continue;
    }

    result.push({ role: "user", content: m.content });
  }

  return result;
}

function toAnthropicTools(tools: LlmToolDefinition[]): Anthropic.Messages.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Messages.Tool.InputSchema,
  }));
}

export class AnthropicClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string, model: string | null) {
    this.client = new Anthropic({ apiKey });
    this.model = model ?? DEFAULT_MODEL;
  }

  async complete(messages: LlmMessage[], tools?: LlmToolDefinition[]): Promise<LlmCompletionResult> {
    const systemMessage = messages.find((m): m is Extract<LlmMessage, { role: "system" }> => m.role === "system");
    const system = systemMessage?.content;

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 600,
      system,
      messages: toAnthropicMessages(messages),
      tools: tools && tools.length > 0 ? toAnthropicTools(tools) : undefined,
    });

    const toolUseBlocks = res.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use");
    if (toolUseBlocks.length > 0) {
      const toolCalls: LlmToolCall[] = toolUseBlocks.map((b) => ({
        id: b.id,
        name: b.name,
        arguments: (b.input ?? {}) as Record<string, unknown>,
      }));
      const textBlock = res.content.find((b) => b.type === "text");
      return { content: textBlock?.type === "text" ? textBlock.text : null, model: this.model, toolCalls };
    }

    const block = res.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error("Anthropic returned no text content");
    return { content: block.text.trim(), model: this.model };
  }
}
