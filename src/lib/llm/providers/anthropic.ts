import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmCompletionResult, LlmMessage } from "../types.js";

const DEFAULT_MODEL = "claude-sonnet-4-5";

export class AnthropicClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string, model: string | null) {
    this.client = new Anthropic({ apiKey });
    this.model = model ?? DEFAULT_MODEL;
  }

  async complete(messages: LlmMessage[]): Promise<LlmCompletionResult> {
    const system = messages.find((m) => m.role === "system")?.content;
    const turns = messages
      .filter((m): m is LlmMessage & { role: "user" | "assistant" } => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 600,
      system,
      messages: turns,
    });
    const block = res.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error("Anthropic returned no text content");
    return { content: block.text.trim(), model: this.model };
  }
}
