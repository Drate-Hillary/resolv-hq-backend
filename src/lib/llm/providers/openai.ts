import OpenAI from "openai";
import type { LlmClient, LlmCompletionResult, LlmMessage } from "../types.js";

const DEFAULT_MODEL = "gpt-4o-mini";

export class OpenAiClient implements LlmClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey: string, model: string | null) {
    this.client = new OpenAI({ apiKey });
    this.model = model ?? DEFAULT_MODEL;
  }

  async complete(messages: LlmMessage[]): Promise<LlmCompletionResult> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: 600,
    });
    const content = res.choices[0]?.message?.content?.trim();
    if (!content) throw new Error("OpenAI returned no content");
    return { content, model: this.model };
  }
}
