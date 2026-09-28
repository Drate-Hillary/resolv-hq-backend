import { createClient } from "@supabase/supabase-js";
import type { Database } from "../types/database.types.js";

const url = process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!url || !secretKey || !publishableKey) {
  throw new Error(
    "Missing SUPABASE_URL, SUPABASE_SECRET_KEY, or SUPABASE_PUBLISHABLE_KEY. Copy .env.example to .env and fill in your Supabase project credentials."
  );
}

/**
 * Service-role client, used only for what Prisma can't do: Supabase Storage
 * (lib/knowledge-storage.ts) and the Auth Admin API (routes/me.ts). All plain
 * table access goes through Prisma (lib/prisma.ts) instead.
 */
export const supabaseAdmin = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * A second, publishable-key client used only to verify caller-supplied
 * access tokens via `auth.getUser(token)`. Kept separate from
 * `supabaseAdmin` so the service-role key is never involved in token
 * verification.
 */
export const authClient = createClient<Database>(url, publishableKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
