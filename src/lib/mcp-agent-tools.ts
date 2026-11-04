import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp-server.js";
import type { AuthenticatedUser } from "./auth.js";
import type { LlmToolDefinition } from "./llm/types.js";

function getTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string",
    )
    .map(({ text }) => text)
    .join("\n");
}

export interface McpAgentTools {
  listTools(): Promise<LlmToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export async function connectMcpAgentTools(server: Awaited<ReturnType<typeof createMcpServer>>): Promise<McpAgentTools> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "resolv-hq-ticket-agent", version: "1.0.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  } catch (error) {
    await client.close();
    await server.close();
    throw error;
  }

  return {
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema,
      }));
    },
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) {
        const detail = getTextContent(result.content);
        return `MCP tool "${name}" error: ${detail || "The tool returned an error."}`;
      }
      if ("structuredContent" in result && result.structuredContent !== undefined) {
        return JSON.stringify(result.structuredContent);
      }
      return getTextContent(result.content);
    },
    async close() {
      try {
        await client.close();
      } finally {
        await server.close();
      }
    },
  };
}

export async function createMcpAgentTools(user: AuthenticatedUser): Promise<McpAgentTools> {
  return connectMcpAgentTools(await createMcpServer(user));
}
