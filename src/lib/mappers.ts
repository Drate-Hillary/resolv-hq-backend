// Row -> app-shape mapping. Keeping these in one place is what lets route
// handlers stay mostly unaware of DB column names.
import type {
  AiConversationRow,
  AiMessageRow,
  CustomerMemoryRow,
  KnowledgeDocumentRow,
  NotificationRow,
  RequestCategory,
  RequestPriority as DbRequestPriority,
  RequestMessageRow,
  RequestRow,
  RequestStatusHistoryRow,
} from "../types/database.types.js";
import type {
  AppNotification,
  AppRequestPriority,
  ChatConversationOut,
  ChatMessageOut,
  HelpArticleOut,
  MemoryFact,
  RequestCategoryOption,
  RequestMessage,
  ServiceRequest,
  TimelineStep,
} from "../types/api.js";

export function priorityToDb(priority: AppRequestPriority): DbRequestPriority {
  return priority === "normal" ? "medium" : priority;
}

export function priorityFromDb(priority: DbRequestPriority): AppRequestPriority {
  return priority === "medium" ? "normal" : priority;
}

export function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function formatMemberSince(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

/** Builds the request_status_history timeline UI. `statusNameById` resolves
 * each history row's new_status_id to a display name (and workflow key). */
export function buildTimeline(
  history: RequestStatusHistoryRow[],
  createdAt: string,
  statusNameById: Map<string, string>,
): TimelineStep[] {
  const sorted = [...history].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  const steps: TimelineStep[] = [{ key: "created", label: "Submitted", timestamp: createdAt }];
  for (const h of sorted) {
    if (!h.new_status_id) continue;
    const label = statusNameById.get(h.new_status_id) ?? "Unknown";
    steps.push({ key: h.new_status_id, label, timestamp: h.created_at });
  }
  return steps;
}

export function mapRequestRow(
  row: RequestRow,
  categoryName: string | null,
  statusName: string,
  /** Only populated for a staff (agent/admin) view. */
  staffExtra?: { customerName?: string | null; assignedAgentName?: string | null },
): ServiceRequest {
  return {
    id: row.id,
    title: row.title,
    category: categoryName ?? "General Inquiry",
    categoryId: row.category_id,
    description: row.description,
    status: statusName,
    priority: priorityFromDb(row.priority),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages: [],
    timeline: buildTimeline([], row.created_at, new Map()),
    customerId: row.customer_id,
    customerName: staffExtra?.customerName ?? null,
    assignedAgentId: row.assigned_agent_id,
    assignedAgentName: staffExtra?.assignedAgentName ?? null,
  };
}

export function mapMessageRow(row: RequestMessageRow): RequestMessage {
  return {
    id: row.id,
    sender: row.sender_type,
    text: row.message,
    timestamp: row.created_at,
  };
}

export function mapNotificationRow(row: NotificationRow): AppNotification {
  return {
    id: row.id,
    title: row.title,
    body: row.message,
    createdAt: row.created_at,
    read: row.is_read,
    requestId: row.request_id ?? undefined,
  };
}

export function mapMemoryRow(row: CustomerMemoryRow): MemoryFact {
  return {
    id: row.id,
    key: row.memory_key,
    value: row.memory_value,
  };
}

export function mapCategoryRow(row: RequestCategory): RequestCategoryOption {
  return { id: row.id, name: row.name, description: row.description };
}

/** Picks the best matching category id for the assistant's free-text suggestion. */
export function resolveCategoryId(categories: RequestCategoryOption[], suggestedName: string): string | null {
  if (categories.length === 0) return null;
  const exact = categories.find((c) => c.name.toLowerCase() === suggestedName.toLowerCase());
  if (exact) return exact.id;
  const fallback = categories.find((c) => c.name.toLowerCase() === "general inquiry");
  return (fallback ?? categories[0]).id;
}

export function mapChatMessageRow(row: AiMessageRow): ChatMessageOut {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderType: row.sender_type,
    content: row.content,
    feedback: row.feedback,
    createdAt: row.created_at,
  };
}

export function mapConversationRow(row: AiConversationRow, messageCount: number): ChatConversationOut {
  return { id: row.id, title: row.title, status: row.status, startedAt: row.created_at, messageCount };
}

/** `knowledge_documents` has no slug/summary/body/readMinutes columns — this app shape is
 * derived entirely from `title` and `content` at the boundary. */
export function mapKnowledgeDocumentToHelpArticle(
  row: KnowledgeDocumentRow,
  categoryName: string | null,
): HelpArticleOut {
  const flat = row.content?.replace(/\s+/g, " ").trim() ?? "";
  const words = flat.length > 0 ? flat.split(" ").length : 0;

  return {
    id: row.id,
    slug: slugifyTitle(row.title, row.id),
    title: row.title,
    category: categoryName ?? "General",
    summary: flat.length > 140 ? `${flat.slice(0, 137)}...` : flat || "Open this article for the full details.",
    body:
      row.content
        ?.split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean) ?? [
        "This article's full content is attached as a file — ask the AI assistant if you have questions.",
      ],
    source: "Resolv HQ Knowledge Base",
    readMinutes: Math.max(1, Math.round(words / 200)),
  };
}

function slugifyTitle(title: string, id: string): string {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return base ? `${base}-${id.slice(0, 8)}` : id;
}
