import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HttpError } from "./errors.js";
import {
  accountStatusLookupResult,
  buildEscalationDraft,
  outageStatusCheckerResult,
  searchKnowledgeBaseResult,
} from "./agent-tools.js";
import { loadCallerAccount, loadCallerKnowledge, loadCallerRequests } from "./agent-tool-context.js";
import type { AuthenticatedUser } from "./auth.js";
import { prisma } from "./prisma.js";
import { syncBuiltInTools } from "./tool-registry.js";
import { z } from "zod";

const tools = {
  search_knowledge_base: {
    description:
      "Search published knowledge passages for a topic or question. Returns up to three short excerpts.",
    inputSchema: z.object({ query: z.string() }).strict(),
    outputSchema: z.object({
      matches: z.array(
        z.object({
          title: z.string(),
          page: z.number().int().nullable(),
          excerpt: z.string(),
        }).strict(),
      ),
      message: z.string(),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  account_status_lookup: {
    description: "Look up the authenticated caller's own account status and customer profile context.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({
      role: z.string(),
      status: z.string(),
      organizationName: z.string().nullable(),
      city: z.string().nullable(),
      country: z.string(),
      memberSince: z.string(),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  outage_status_checker: {
    description:
      "List unresolved support requests in the authenticated caller's permitted scope; staff scope includes all non-final requests.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({
      openIssues: z.array(
        z.object({
          title: z.string(),
          status: z.string(),
        }).strict(),
      ),
      message: z.string(),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  draft_escalation_ticket: {
    description:
      "Create an in-memory escalation proposal only. It does not submit a request or create an approval.",
    inputSchema: z.object({
      summary: z.string(),
      keyFacts: z.string().optional(),
      suggestedAction: z.string().optional(),
    }).strict(),
    outputSchema: z.object({
      title: z.string(),
      description: z.string(),
      category: z.string(),
      priority: z.enum(["low", "normal", "high"]),
      keyFacts: z.string().nullable(),
      suggestedAction: z.string().nullable(),
      submitted: z.literal(false),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
} as const;

type ToolName = keyof typeof tools;

async function loadActiveTools(): Promise<Set<string>> {
  await syncBuiltInTools();
  const rows = await prisma.agent_tools.findMany({
    where: { is_active: true },
    select: { name: true },
  });
  return new Set(rows.map(({ name }) => name));
}

function asText(value: unknown): string {
  return JSON.stringify(value);
}

function createToolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

/** Collaborators the server needs; overridable so the protocol can be tested without a database. */
export interface McpServerDeps {
  getActiveTools: () => Promise<Set<string>>;
  loadCallerAccount: typeof loadCallerAccount;
  loadCallerRequests: typeof loadCallerRequests;
  loadCallerKnowledge: typeof loadCallerKnowledge;
}

const defaultDeps: McpServerDeps = {
  getActiveTools: loadActiveTools,
  loadCallerAccount,
  loadCallerRequests,
  loadCallerKnowledge,
};

export async function createMcpServer(
  userProvider: AuthenticatedUser | (() => Promise<AuthenticatedUser>),
  deps: McpServerDeps = defaultDeps,
): Promise<McpServer> {
  const resolveUser = typeof userProvider === "function" ? userProvider : async () => userProvider;
  const active = await deps.getActiveTools();
  const server = new McpServer(
    { name: "resolv-hq-agent-tools", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // Rechecks activation on every call and converts any failure (inactive tool,
  // auth, database, provider) into an explicit MCP tool error. Never returns a
  // success-shaped fallback.
  const guarded =
    <A, R>(name: ToolName, handler: (args: A) => Promise<R>) =>
    async (args: A) => {
      try {
        if (!(await deps.getActiveTools()).has(name)) {
          return createToolError(`MCP tool "${name}" is inactive`);
        }
        return await handler(args);
      } catch (error) {
        if (error instanceof HttpError) return createToolError(error.message);
        console.error(`MCP tool "${name}" failed:`, error);
        return createToolError(`MCP tool "${name}" failed`);
      }
    };

  if (active.has("search_knowledge_base")) {
    server.registerTool("search_knowledge_base", tools.search_knowledge_base, guarded("search_knowledge_base", async ({ query }: { query: string }) => {
      await resolveUser();
      const knowledge = await deps.loadCallerKnowledge(query);
      const result = searchKnowledgeBaseResult({ query }, knowledge);
      return { content: [{ type: "text" as const, text: asText(result) }], structuredContent: { ...result } };
    }));
  }

  if (active.has("account_status_lookup")) {
    server.registerTool("account_status_lookup", tools.account_status_lookup, guarded("account_status_lookup", async () => {
      const result = accountStatusLookupResult(await deps.loadCallerAccount(await resolveUser()));
      return {
        content: [{ type: "text" as const, text: asText(result) }],
        structuredContent: { ...result },
      };
    }));
  }

  if (active.has("outage_status_checker")) {
    server.registerTool("outage_status_checker", tools.outage_status_checker, guarded("outage_status_checker", async () => {
      const result = outageStatusCheckerResult(await deps.loadCallerRequests(await resolveUser()));
      return { content: [{ type: "text" as const, text: asText(result) }], structuredContent: { ...result } };
    }));
  }

  if (active.has("draft_escalation_ticket")) {
    server.registerTool("draft_escalation_ticket", tools.draft_escalation_ticket, guarded("draft_escalation_ticket", async (args: { summary: string; keyFacts?: string; suggestedAction?: string }) => {
      await resolveUser();
      const draft = buildEscalationDraft(args);
      if (!draft) return createToolError("summary must contain a non-empty issue description");
      const result = { ...draft, submitted: false as const };
      return {
        content: [{ type: "text" as const, text: `Draft prepared for human review; it has not been submitted.\n${asText(draft)}` }],
        structuredContent: result,
      };
    }));
  }

  return server;
}
