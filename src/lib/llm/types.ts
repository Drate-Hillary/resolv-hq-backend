// The one interface every provider implementation and every caller (chat.ts,
// future agent orchestration) depends on. Swapping or adding a provider means
// writing a new file under providers/ that implements this — nothing that
// calls completeWithFallback (see gateway.ts) ever changes.
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCompletionResult {
  content: string;
  model: string;
}

export interface LlmClient {
  complete(messages: LlmMessage[]): Promise<LlmCompletionResult>;
}
