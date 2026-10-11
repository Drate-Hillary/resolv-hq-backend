import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { authenticateAccessToken } from "./lib/auth.js";
import { createMcpServer } from "./lib/mcp-server.js";
import { prisma } from "./lib/prisma.js";

const accessToken = process.env.MCP_ACCESS_TOKEN;

if (!accessToken) {
  throw new Error("MCP_ACCESS_TOKEN is required to start the authenticated stdio MCP server");
}

try {
  await authenticateAccessToken(accessToken);
  const server = await createMcpServer(() => authenticateAccessToken(accessToken));
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await server.close();
    await prisma.$disconnect();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.stdin.once("end", () => void shutdown());
} catch (error) {
  console.error("Failed to start Resolv-HQ stdio MCP server:", error);
  await prisma.$disconnect();
  process.exitCode = 1;
}
