import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import type { LlmClient, LlmCompletionResult, LlmMessage, LlmToolCall, LlmToolDefinition } from "../types.js";

const DEFAULT_MODEL = "gpt-4o-mini";

type LangChainToolCall = {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
};

const toLangChainMessages = (messages: LlmMessage[]) =>
  messages.map((message) => {
    if (message.role === "system") return new SystemMessage(message.content);
    if (message.role === "user") return new HumanMessage(message.content);
    if (message.role === "assistant") {
      return new AIMessage({
        content: message.content ?? "",
        tool_calls: (message.toolCalls ?? []).map((call) => ({
          id: call.id,
          name: call.name,
          args: call.arguments,
        })),
      });
    }
    return new ToolMessage({
      content: message.content,
      tool_call_id: message.toolCallId,
    });
  });

const toLangChainTools = (tools: LlmToolDefinition[]) =>
  tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));

const extractTextContent = (content: unknown): string => {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
        return "";
      })
      .join(" ")
      .trim();
  }
  return "";
};

export class LangChainClient implements LlmClient {
  private readonly client: ChatOpenAI | ChatAnthropic | ChatGoogleGenerativeAI;
  private readonly model: string;

  constructor(apiKey: string, model: string | null) {
    const resolvedModel = model?.trim() || DEFAULT_MODEL;
    this.model = resolvedModel;

    if (/claude/i.test(resolvedModel)) {
      this.client = new ChatAnthropic({ apiKey, model: resolvedModel, temperature: 0 });
      return;
    }

    if (/gemini|google/i.test(resolvedModel)) {
      this.client = new ChatGoogleGenerativeAI({ apiKey, model: resolvedModel, temperature: 0 });
      return;
    }

    this.client = new ChatOpenAI({ apiKey, model: resolvedModel, temperature: 0 });
  }

  async complete(messages: LlmMessage[], tools?: LlmToolDefinition[]): Promise<LlmCompletionResult> {
    const langchainMessages = toLangChainMessages(messages);
    const modelWithTools = tools && tools.length > 0 ? this.client.bindTools(toLangChainTools(tools)) : this.client;
    const response = await modelWithTools.invoke(langchainMessages);

    const rawToolCalls = (response as unknown as { tool_calls?: LangChainToolCall[] }).tool_calls ?? [];
    const toolCalls: LlmToolCall[] = rawToolCalls.map((call, index) => ({
      id: call.id ?? `langchain-call-${Date.now()}-${index}`,
      name: call.name ?? "unknown_tool",
      arguments: call.args ?? {},
    }));

    const text = extractTextContent(response.content);
    if (toolCalls.length > 0) {
      return { content: text || null, model: this.model, toolCalls };
    }

    if (!text) {
      throw new Error("LangChain returned no content");
    }

    return { content: text, model: this.model };
  }
}
