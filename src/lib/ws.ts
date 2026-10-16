// WebSocket transport for the realtime hub (lib/realtime.ts). One socket per
// signed-in tab or app, at /ws on the API's own port. It carries exactly the
// events the SSE stream (routes/events.ts, kept as a fallback) carries, to
// exactly the same audience, because both register with the same hub.
//
// Browsers and React Native cannot set an Authorization header on a WebSocket,
// and a token in the URL ends up in logs, so the client sends its Supabase
// access token as the first message instead. A socket that has not
// authenticated within AUTH_TIMEOUT_MS is closed, and nothing is delivered to
// it before then.
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { authenticateAccessToken } from "./auth.js";
import { addClient } from "./realtime.js";

const PATH = "/ws";
const AUTH_TIMEOUT_MS = 5_000;
const HEARTBEAT_MS = 25_000;
const MAX_PAYLOAD_BYTES = 8 * 1024;

/** Close codes the clients act on: 4401 means "sign in again", do not just retry. */
const CLOSE_UNAUTHORIZED = 4401;

export function attachWebSocketServer(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  // Drop sockets whose peer vanished without closing (laptop lid, dead network).
  const sweep = setInterval(() => {
    for (const ws of wss.clients) {
      const alive = (ws as WebSocket & { alive?: boolean }).alive;
      if (alive === false) {
        ws.terminate();
        continue;
      }
      (ws as WebSocket & { alive?: boolean }).alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  sweep.unref();
  wss.on("close", () => clearInterval(sweep));

  return wss;
}

function onConnection(ws: WebSocket & { alive?: boolean }): void {
  ws.alive = true;
  ws.on("pong", () => {
    ws.alive = true;
  });

  let removeClient: (() => void) | null = null;
  let authenticating = false;
  const timer = setTimeout(() => {
    if (!removeClient) ws.close(CLOSE_UNAUTHORIZED, "auth timeout");
  }, AUTH_TIMEOUT_MS);

  ws.on("message", (raw) => {
    let message: { type?: string; token?: string };
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Application-level ping, for clients that cannot see protocol pings (browsers).
    if (message.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (message.type !== "auth" || removeClient || authenticating) return;
    if (typeof message.token !== "string") {
      ws.close(CLOSE_UNAUTHORIZED, "token required");
      return;
    }

    authenticating = true;
    authenticateAccessToken(message.token)
      .then((user) => {
        if (ws.readyState !== ws.OPEN) return;
        clearTimeout(timer);
        removeClient = addClient({
          userId: user.id,
          isStaff: user.role === "admin" || user.role === "agent",
          send: (event) => ws.send(JSON.stringify(event)),
        });
        ws.send(JSON.stringify({ type: "ready" }));
      })
      .catch(() => ws.close(CLOSE_UNAUTHORIZED, "invalid token"));
  });

  ws.on("close", () => {
    clearTimeout(timer);
    removeClient?.();
  });
  ws.on("error", () => ws.terminate());
}
