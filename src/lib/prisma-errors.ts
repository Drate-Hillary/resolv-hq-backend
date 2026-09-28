import { Prisma } from "@prisma/client";

/** Prisma's `update()`/`delete()` throw when the row doesn't exist (unlike
 * Supabase's non-throwing `{ data, error }`) — used to translate that back
 * into the app's `notFound()` HttpError at the call site. */
export function isNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

/** Unique-constraint violation — replaces the old `error.code === "23505"` checks. */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
