import { prisma } from "./prisma.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionPolicy {
  /** Customer memory facts not changed for this many days are deleted. */
  memoryIdleDays: number;
  /** Staff access-audit rows older than this many days are deleted. */
  auditLogDays: number;
  /** Conversations idle this long are deleted, but only if no agent run references them. */
  conversationDays: number;
}

function days(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** 0 disables the corresponding purge. Agent runs, steps and approvals are never auto-deleted (audit trail). */
export function loadRetentionPolicy(): RetentionPolicy {
  return {
    memoryIdleDays: days("MEMORY_RETENTION_DAYS", 365),
    auditLogDays: days("AUDIT_LOG_RETENTION_DAYS", 730),
    conversationDays: days("CONVERSATION_RETENTION_DAYS", 365),
  };
}

export interface RetentionResult {
  dryRun: boolean;
  memoryFacts: number;
  auditLogs: number;
  conversations: number;
}

export async function purgeExpired(
  options: { dryRun?: boolean; now?: Date; policy?: RetentionPolicy } = {},
): Promise<RetentionResult> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();
  const policy = options.policy ?? loadRetentionPolicy();
  const cutoff = (n: number) => new Date(now.getTime() - n * DAY_MS);

  const memoryWhere = { updated_at: { lt: cutoff(policy.memoryIdleDays) } };
  const auditWhere = { created_at: { lt: cutoff(policy.auditLogDays) } };
  const conversationWhere = { updated_at: { lt: cutoff(policy.conversationDays) }, agent_runs: { none: {} } };

  const run = async <W>(
    enabled: number,
    count: (where: W) => Promise<number>,
    remove: (where: W) => Promise<{ count: number }>,
    where: W,
  ) => {
    if (enabled <= 0) return 0;
    return dryRun ? count(where) : (await remove(where)).count;
  };

  return {
    dryRun,
    memoryFacts: await run(
      policy.memoryIdleDays,
      (where) => prisma.customer_memory.count({ where }),
      (where) => prisma.customer_memory.deleteMany({ where }),
      memoryWhere,
    ),
    auditLogs: await run(
      policy.auditLogDays,
      (where) => prisma.customer_memory_access_logs.count({ where }),
      (where) => prisma.customer_memory_access_logs.deleteMany({ where }),
      auditWhere,
    ),
    conversations: await run(
      policy.conversationDays,
      (where) => prisma.ai_conversations.count({ where }),
      (where) => prisma.ai_conversations.deleteMany({ where }),
      conversationWhere,
    ),
  };
}

/** Runs the purge once at startup and then daily. Off unless RETENTION_ENABLED=true. */
export function startRetentionJob(): void {
  if (process.env.RETENTION_ENABLED !== "true") return;
  const tick = () =>
    purgeExpired()
      .then((r) => console.log(`Retention purge: ${r.memoryFacts} memory facts, ${r.auditLogs} audit rows, ${r.conversations} conversations`))
      .catch((error) => console.error("Retention purge failed:", error));
  void tick();
  setInterval(tick, DAY_MS).unref();
}
