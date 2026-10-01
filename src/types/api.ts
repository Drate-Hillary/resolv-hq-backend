// App-facing response shapes (mirrors resolv-hq-customer/lib/types.ts), decoupled
// from the DB row shapes in database.types.ts. Route handlers map rows to these.
import type { MessageSenderType, UserRole } from "./database.types.js";

/** Customer app uses "normal", the DB enum uses "medium" — mapped at the boundary. */
export type AppRequestPriority = "low" | "normal" | "high" | "urgent";

export interface TimelineStep {
  key: string;
  label: string;
  timestamp?: string;
}

/** A file attached to a request. `fileUrl` is a short-lived signed URL — safe to render or open, not to store. */
export interface RequestAttachment {
  id: string;
  fileUrl: string;
  fileName: string;
  fileType: string | null;
  fileSizeBytes: number | null;
  createdAt: string;
  messageId?: string | null;
  uploadedBy?: string | null;
}

export interface RequestMessage {
  id: string;
  sender: MessageSenderType;
  text: string;
  timestamp: string;
  attachments?: RequestAttachment[];
}

export interface ServiceRequest {
  id: string;
  ticketNumber: number;
  /** resolv-hq-customer reads this directly (e.g. RequestCard, request/[id].tsx
   * render `#{request.code}`) — it typed the API response as its own
   * ServiceRequest with no mapping layer, so this field was silently always
   * undefined until now. */
  code: string;
  title: string;
  category: string;
  categoryId?: string | null;
  description: string;
  status: string;
  priority: AppRequestPriority;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string | null;
  closedAt?: string | null;
  aiHandled: boolean;
  messages: RequestMessage[];
  attachments?: RequestAttachment[];
  timeline: TimelineStep[];
  customerId?: string;
  customerName?: string | null;
  assignedAgentId?: string | null;
  assignedAgentName?: string | null;
  /** Aliases of the two fields above — resolv-hq-customer's (agent)/queue.tsx
   * and ticket/[id].tsx read assignedAdminId/assignedAdminName specifically
   * (isMine, "Assign to me" visibility), so those were silently always
   * undefined/broken until this was added. */
  assignedAdminId?: string | null;
  assignedAdminName?: string | null;
}

export interface RequestCategoryOption {
  id: string;
  name: string;
  description?: string | null;
}

export type NotificationType = "request_update" | "ai" | "support" | "completed" | "system";

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
  requestId?: string;
}

export interface MemoryFact {
  id: string;
  key: string;
  value: string;
}

export interface UserProfile {
  id: string;
  role: UserRole;
  name: string;
  email: string;
  phone: string;
  memberSince: string;
  avatarInitials: string;
  organizationName: string;
  city: string;
  country: string;
  preferredLanguage: string;
}

/** Neutral chat shapes shared by the customer app and the admin console's demo chat. */
export interface ChatMessageOut {
  id: string;
  conversationId: string;
  senderType: "customer" | "assistant" | "system";
  content: string;
  feedback: "up" | "down" | null;
  createdAt: string;
}

export interface ChatConversationOut {
  id: string;
  title: string | null;
  status: string;
  startedAt: string;
  messageCount: number;
}

/** Customer-facing view of a published knowledge_documents row. */
export interface HelpArticleOut {
  id: string;
  slug: string;
  title: string;
  category: string;
  summary: string;
  body: string[];
  source: string;
  readMinutes: number;
  /** True when the original file (PDF etc.) can be opened via GET /knowledge/:id/file. */
  hasFile: boolean;
  fileType: string | null;
}
