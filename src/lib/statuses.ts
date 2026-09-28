// requests.status_id replaced the old plain-enum requests.status column —
// every route that needs to filter or display a request's status now
// resolves it through request_statuses first.
import { prisma } from "./prisma.js";
import type { RequestStatusRow } from "../types/database.types.js";

let cache: RequestStatusRow[] | null = null;

/** All request_statuses rows, ordered by workflow sequence. Cached for the
 * life of the process — this table is effectively static reference data. */
export async function loadStatuses(): Promise<RequestStatusRow[]> {
  if (cache) return cache;
  cache = (await prisma.request_statuses.findMany({ orderBy: { sequence: "asc" } })) as RequestStatusRow[];
  return cache;
}

export async function statusIdByName(name: string): Promise<string | null> {
  const statuses = await loadStatuses();
  return statuses.find((s) => s.name === name)?.id ?? null;
}

export async function finalStatusIds(): Promise<string[]> {
  const statuses = await loadStatuses();
  return statuses.filter((s) => s.is_final).map((s) => s.id);
}
