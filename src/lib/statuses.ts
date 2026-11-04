// requests.status_id replaced the old plain-enum requests.status column —
// every route that needs to filter or display a request's status now
// resolves it through request_statuses first.
import { prisma } from "./prisma.js";
import { getOrLoadRedisCache } from "./redis-cache.js";
import type { RequestStatusRow } from "../types/database.types.js";

const REQUEST_STATUSES_CACHE_KEY = "db-cache:request-statuses:v1";
const REQUEST_STATUSES_CACHE_TTL_SECONDS = 3600;

/** All request_statuses rows, shared through Redis as static reference data. */
export async function loadStatuses(): Promise<RequestStatusRow[]> {
  return getOrLoadRedisCache(REQUEST_STATUSES_CACHE_KEY, REQUEST_STATUSES_CACHE_TTL_SECONDS, async () =>
    (await prisma.request_statuses.findMany({ orderBy: { sequence: "asc" } })) as RequestStatusRow[],
  );
}

export async function statusIdByName(name: string): Promise<string | null> {
  const statuses = await loadStatuses();
  return statuses.find((s) => s.name === name)?.id ?? null;
}

export async function finalStatusIds(): Promise<string[]> {
  const statuses = await loadStatuses();
  return statuses.filter((s) => s.is_final).map((s) => s.id);
}
