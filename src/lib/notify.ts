// The one place notifications are written. Every producer (request
// lifecycle, messages, AI escalations, approval decisions) goes through
// here so the type vocabulary and the "never notify yourself" rule live in
// one spot, and so a failed notification can never fail the action that
// triggered it — they are a side effect, not part of the transaction.
import { mapNotificationRow } from "./mappers.js";
import { prisma } from "./prisma.js";
import { publish } from "./realtime.js";
import type { NotificationType } from "../types/api.js";
import type { NotificationRow } from "../types/database.types.js";

export interface NotificationInput {
  type: NotificationType;
  title: string;
  message: string;
  requestId?: string | null;
}

async function insertFor(userIds: string[], input: NotificationInput) {
  if (userIds.length === 0) return;
  const rows = await prisma.notifications.createManyAndReturn({
    data: userIds.map((user_id) => ({
      user_id,
      request_id: input.requestId ?? null,
      type: input.type,
      title: input.title,
      message: input.message,
    })),
  });
  // Push each saved row to its recipient so the bell updates instantly.
  // A failed push never fails the notification itself.
  for (const row of rows) {
    void publish(
      { userIds: [row.user_id] },
      {
        type: "notification",
        notification: mapNotificationRow({
          ...row,
          is_read: row.is_read ?? false,
          created_at: (row.created_at ?? new Date()).toISOString(),
        } as unknown as NotificationRow),
      },
    );
  }
}

/** Notify specific users. `exceptUserId` is the actor — people aren't told about their own actions. */
export async function notifyUsers(
  userIds: (string | null | undefined)[],
  input: NotificationInput,
  exceptUserId?: string,
): Promise<void> {
  const targets = Array.from(new Set(userIds.filter((id): id is string => Boolean(id) && id !== exceptUserId)));
  try {
    await insertFor(targets, input);
  } catch (err) {
    console.error("Failed to create notification:", err);
  }
}

/** Notify every active admin/agent (the shared staff queue). */
export async function notifyStaff(input: NotificationInput, exceptUserId?: string): Promise<void> {
  try {
    const staff = await prisma.profiles.findMany({
      where: { role: { in: ["admin", "agent"] }, status: "active" },
      select: { id: true },
    });
    await notifyUsers(
      staff.map((s) => s.id),
      input,
      exceptUserId,
    );
  } catch (err) {
    console.error("Failed to notify staff:", err);
  }
}
