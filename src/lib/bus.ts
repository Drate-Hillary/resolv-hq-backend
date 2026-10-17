// Message bus between the services in the system, on RabbitMQ.
//
// Producers (the customer-facing routes and the agent pipeline) publish a
// domain event to a topic exchange; a durable queue holds it until the console
// relay consumes it and pushes it to every connected staff browser through
// lib/realtime.ts. That is what puts a ticket or task created in the customer
// app on the scheduler board without the board having to poll.
//
// Same stance as Redis here: the bus is a convenience on top of the database
// write, never part of it. With RABBITMQ_URL unset or the broker down, events
// are handed to realtime directly and publishing never throws.
import amqp from "amqplib";
import { publish as pushToStaff } from "./realtime.js";

export type BusTopic = "request.created" | "agent.run.completed" | "approval.requested" | "approval.decided";

export interface BusEvent {
  topic: BusTopic;
  at: string;
  payload: Record<string, unknown>;
}

const EXCHANGE = "resolv.events";
const CONSOLE_QUEUE = "resolv.console";
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

type Connection = Awaited<ReturnType<typeof amqp.connect>>;
type Channel = Awaited<ReturnType<Connection["createChannel"]>>;

let channel: Channel | null = null;
let started = false;
let attempts = 0;

function relayToConsole(event: BusEvent): void {
  void pushToStaff({ staff: true }, { type: "scheduler", topic: event.topic, event });
}

/** Called once at boot. A no-op without RABBITMQ_URL. */
export function startBus(): void {
  const url = process.env.RABBITMQ_URL;
  if (started || !url) {
    if (!url) console.warn("RABBITMQ_URL is not set: events go straight to the console, with no queue in between.");
    return;
  }
  started = true;
  void connect(url);
}

async function connect(url: string): Promise<void> {
  try {
    const connection = await amqp.connect(url);
    const ch = await connection.createChannel();
    await ch.assertExchange(EXCHANGE, "topic", { durable: true });
    await ch.assertQueue(CONSOLE_QUEUE, { durable: true });
    await ch.bindQueue(CONSOLE_QUEUE, EXCHANGE, "#");
    await ch.consume(CONSOLE_QUEUE, (msg) => {
      if (!msg) return;
      try {
        relayToConsole(JSON.parse(msg.content.toString()) as BusEvent);
        ch.ack(msg);
      } catch (err) {
        console.error("Bus: dropping a malformed event:", err);
        ch.nack(msg, false, false);
      }
    });

    attempts = 0;
    channel = ch;
    console.log("Bus: connected to RabbitMQ");

    const lost = (err?: Error) => {
      if (channel !== ch) return;
      channel = null;
      if (err) console.error("Bus: connection lost, events go straight to the console until it returns:", err.message);
      scheduleReconnect(url);
    };
    connection.on("error", lost);
    connection.on("close", () => lost());
  } catch (err) {
    console.error(`Bus: could not reach RabbitMQ (${(err as Error).message}); retrying.`);
    scheduleReconnect(url);
  }
}

function scheduleReconnect(url: string): void {
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** attempts);
  attempts += 1;
  setTimeout(() => void connect(url), delay).unref();
}

/** Fire-and-forget; never throws. */
export function publishEvent(topic: BusTopic, payload: Record<string, unknown>): void {
  const event: BusEvent = { topic, at: new Date().toISOString(), payload };
  if (channel) {
    try {
      channel.publish(EXCHANGE, topic, Buffer.from(JSON.stringify(event)), { persistent: true, contentType: "application/json" });
      return;
    } catch (err) {
      console.error("Bus: publish failed, delivering directly:", err);
    }
  }
  relayToConsole(event);
}

export function busStatus(): "connected" | "offline" | "disabled" {
  if (!process.env.RABBITMQ_URL) return "disabled";
  return channel ? "connected" : "offline";
}
