import { Router, type Request, type Response } from "express";
import { addClient } from "../lib/realtime.js";

const router = Router();

const HEARTBEAT_MS = 25_000;

/**
 * Long-lived Server-Sent Events stream for the caller. Identity comes from
 * requireAuth (req.user) — never from a query string — so a user only ever
 * receives events addressed to them (see lib/realtime.ts). The heartbeat
 * comment keeps proxies from closing an idle connection.
 */
router.get("/", (req: Request, res: Response) => {
  const user = req.user!;

  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Tell nginx not to buffer the stream, or events would arrive in bursts.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  res.write(`event: ready\ndata: {}\n\n`);

  const removeClient = addClient({
    userId: user.id,
    isStaff: user.role === "admin" || user.role === "agent",
    send: (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
  });

  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeClient();
  });
});

export default router;
