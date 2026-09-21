import cors from "cors";
import express from "express";
import { requireAuth } from "./lib/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { rateLimit } from "./middleware/rate-limit.js";

import meRouter from "./routes/me.js";
import requestsRouter from "./routes/requests.js";
import notificationsRouter from "./routes/notifications.js";
import categoriesRouter from "./routes/categories.js";
import memoryRouter from "./routes/memory.js";
import chatRouter from "./routes/chat.js";
import aiRouter from "./routes/ai.js";

import adminDashboardRouter from "./routes/admin/dashboard.js";
import adminKnowledgeRouter from "./routes/admin/knowledge.js";
import adminToolsRouter from "./routes/admin/tools.js";
import adminTracesRouter from "./routes/admin/traces.js";
import adminAgentRunsRouter from "./routes/admin/agent-runs.js";
import adminApprovalsRouter from "./routes/admin/approvals.js";
import adminAgentProvidersRouter from "./routes/admin/agent-providers.js";

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export function createApp() {
  const app = express();

  app.use(cors({ origin: allowedOrigins.length > 0 ? allowedOrigins : true }));

  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Every route below requires a verified Supabase session.
  app.use(requireAuth);

  // General ceiling for every authenticated route.
  app.use(rateLimit({ keyPrefix: "api", max: 300, windowMs: 5 * 60 * 1000 }));

  app.use("/me", meRouter);
  app.use("/requests", requestsRouter);
  app.use("/notifications", notificationsRouter);
  app.use("/categories", categoriesRouter);
  // memory-facts: the customer's own customer_memory rows.
  app.use("/memory-facts", memoryRouter);
  // Tighter limit here specifically: this is the route that calls the LLM
  // gateway, so it's the one actually exposed to provider rate limits/cost.
  app.use("/chat", rateLimit({ keyPrefix: "chat", max: 20, windowMs: 60 * 1000 }), chatRouter);
  app.use("/ai", aiRouter);

  app.use("/admin/dashboard", adminDashboardRouter);
  app.use("/admin/knowledge", adminKnowledgeRouter);
  app.use("/admin/tools", adminToolsRouter);
  app.use("/admin/traces", adminTracesRouter);
  app.use("/admin/agent-runs", adminAgentRunsRouter);
  app.use("/admin/approvals", adminApprovalsRouter);
  app.use("/admin/agent-providers", adminAgentProvidersRouter);

  app.use(errorHandler);

  return app;
}
