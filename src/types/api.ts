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

export interface RequestMessage {
  id: string;
  sender: MessageSenderType;
  text: string;
  timestamp: string;
}

export interface ServiceRequest {
  id: string;
  title: string;
  category: string;
  categoryId?: string | null;
  description: string;
  status: string;
  priority: AppRequestPriority;
  createdAt: string;
  updatedAt: string;
  messages: RequestMessage[];
  timeline: TimelineStep[];
  customerId?: string;
  customerName?: string | null;
  assignedAgentId?: string | null;
  assignedAgentName?: string | null;
}

export interface RequestCategoryOption {
  id: string;
  name: string;
  description?: string | null;
}

export interface AppNotification {
  id: string;
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
  createdAt: string;
}

export interface ChatConversationOut {
  id: string;
  title: string | null;
  status: string;
  startedAt: string;
  messageCount: number;
}
