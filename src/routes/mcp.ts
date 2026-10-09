import { Router, type Request, type Response } from "express";
import { createMcpServer } from "../lib/mcp-server.js";
import { asyncRoute } from "../middleware/error-handler.js";

const router = Router();

router.all(
  "/",
  asyncRoute(async (req: Request, res: Response) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const server = await createMcpServer(user);
    const { StreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    transport.onerror = (error) => {
      console.error("MCP HTTP transport error:", error);
    };

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }),
);

export default router;
