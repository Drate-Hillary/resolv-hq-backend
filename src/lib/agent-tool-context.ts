import type { AiAccountInput, AiKnowledgeInput, AiRequestInput } from "./ai.js";
import { attachSemanticScores } from "./embeddings.js";
import { formatMemberSince } from "./mappers.js";
import { loadPublishedPassages } from "./knowledge-index.js";
import { prisma } from "./prisma.js";
import { loadStatuses } from "./statuses.js";
import type { AuthenticatedUser } from "./auth.js";
import type { RequestRow } from "../types/database.types.js";

export function isStaffRole(role: string): boolean {
  return role === "admin" || role === "agent";
}

export async function loadCallerAccount(user: AuthenticatedUser): Promise<AiAccountInput> {
  const profile = await prisma.profiles.findUnique({ where: { id: user.id } });
  let customerProfile: {
    organization_name: string | null;
    city: string | null;
    country: string | null;
  } | null = null;

  if (user.role === "customer") {
    customerProfile = await prisma.customer_profiles.findUnique({ where: { user_id: user.id } });
  }

  return {
    role: user.role,
    status: profile?.status ?? "active",
    organizationName: customerProfile?.organization_name ?? null,
    city: customerProfile?.city ?? null,
    country: customerProfile?.country ?? "Uganda",
    memberSince: profile ? formatMemberSince(profile.created_at as unknown as string) : "unknown",
  };
}

export async function loadCallerRequests(user: AuthenticatedUser): Promise<AiRequestInput[]> {
  const statuses = await loadStatuses();
  const finalIds = statuses.filter((status) => status.is_final).map((status) => status.id);
  const statusNameById = new Map(statuses.map((status) => [status.id, status.name]));
  const rows = (await prisma.requests.findMany({
    where: isStaffRole(user.role)
      ? finalIds.length > 0
        ? { status_id: { notIn: finalIds } }
        : undefined
      : { customer_id: user.id },
  })) as unknown as RequestRow[];

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status_id ? statusNameById.get(row.status_id) ?? "unknown" : "unknown",
  }));
}

export async function loadCallerKnowledge(query: string): Promise<AiKnowledgeInput[]> {
  const passages = await loadPublishedPassages();
  return attachSemanticScores(query, passages);
}
