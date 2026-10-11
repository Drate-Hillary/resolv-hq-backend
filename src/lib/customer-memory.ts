import type { AiMemoryInput } from "./ai.js";
import { prisma } from "./prisma.js";

/**
 * Memory facts the model may see for this caller. Customers only, and only
 * when their master switch is on; per-fact `is_enabled` is applied here too.
 * The owner always comes from the verified caller, never the request body.
 */
export async function loadCustomerMemory(userId: string, role: string): Promise<AiMemoryInput[]> {
  if (role !== "customer") return [];

  const preferences = await prisma.customer_profiles.findUnique({
    where: { user_id: userId },
    select: { memory_enabled: true },
  });
  if (!preferences?.memory_enabled) return [];

  const facts = await prisma.customer_memory.findMany({
    where: { customer_id: userId, is_enabled: true },
    select: { memory_key: true, memory_value: true },
    orderBy: { updated_at: "desc" },
  });

  return facts.map(({ memory_key, memory_value }) => ({ key: memory_key, value: memory_value }));
}
