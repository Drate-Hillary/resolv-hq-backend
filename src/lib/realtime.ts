// Server-push hub for the dashboard: new messages, typing indicators and
// notifications reach connected browsers the moment they happen, instead of
// waiting for the next poll. Transport is Server-Sent Events (routes/events.ts)
// — one long-lived GET per signed-in tab, authenticated by the same bearer
// token as every other route, so what a user is pushed is decided here on the
// server and can never be chosen by a client.
//
// Fan-out across API instances goes through Redis pub/sub; if Redis isn't
// reachable the event is delivered to this instance's own clients directly,
// so realtime degrades to single-instance rather than breaking (the same
// fail-open stance as rate limiting and the LLM cache).
import { Redis } from "ioredis";
import { redis } from "./redis.js";

export type RealtimeEvent =
  | { type: "notification"; notification: unknown }
  | { type: "message"; requestId: string; message: unknown }
  | { type: "typing"; requestId: string; userId: string; senderType: "customer" | "admin" | "agent"; typing: boolean };

/** Who an event is for: specific users and/or every connected staff member. */
export interface Audience {
  userIds?: string[];
  staff?: boolean;
}

interface Client {
  userId: string;
  isStaff: boolean;
  send: (event: RealtimeEvent) => void;
}

const CHANNEL = "resolv:realtime";
const clients = new Set<Client>();

export function addClient(client: Client): () => void {
  clients.add(client);
  return () => clients.delete(client);
}

function deliverLocally(audience: Audience, event: RealtimeEvent): void {
  const userIds = audience.userIds ? new Set(audience.userIds) : null;
  for (const client of clients) {
    if ((userIds && userIds.has(client.userId)) || (audience.staff && client.isStaff)) {
      try {
        client.send(event);
      } catch (err) {
        console.error("Realtime: failed to write to a client, dropping it:", err);
        clients.delete(client);
      }
    }
  }
}

let subscriber: Redis | null = null;

/** Called once at boot. Safe if Redis is down: ioredis keeps retrying in the background. */
export function startRealtime(): void {
  if (subscriber) return;
  subscriber = redis.duplicate();
  subscriber.on("error", (err) => console.error("Realtime subscriber error (falling back to local delivery):", err.message));
  subscriber.subscribe(CHANNEL).catch((err) => console.error("Realtime: could not subscribe:", err.message));
  subscriber.on("message", (_channel, raw) => {
    try {
      const { audience, event } = JSON.parse(raw) as { audience: Audience; event: RealtimeEvent };
      deliverLocally(audience, event);
    } catch (err) {
      console.error("Realtime: ignoring malformed pub/sub payload:", err);
    }
  });
}

/** Fire-and-forget: a push is a convenience on top of the database write, never part of it. */
export async function publish(audience: Audience, event: RealtimeEvent): Promise<void> {
  try {
    if (subscriber && subscriber.status === "ready" && redis.status === "ready") {
      await redis.publish(CHANNEL, JSON.stringify({ audience, event }));
      return;
    }
  } catch (err) {
    console.error("Realtime: Redis publish failed, delivering locally:", err);
  }
  deliverLocally(audience, event);
}
