import { createClient } from "@supabase/supabase-js";
import type { Database } from "../types/database.types.js";

const url = process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!url || !secretKey || !anonKey) {
  throw new Error(
    "Missing SUPABASE_URL, SUPABASE_SECRET_KEY, or SUPABASE_ANON_KEY. Copy .env.example to .env and fill in your Supabase project credentials."
  );
}

/**
 * The only Supabase client in this service. Uses the service-role key, so it
 * bypasses RLS entirely — every route handler is responsible for enforcing
 * the authorization rules that RLS used to (see lib/auth.ts, lib/ownership.ts).
 */
export const db = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * A second, anon-key client used only to verify caller-supplied access
 * tokens via `auth.getUser(token)`. Kept separate from `db` so the
 * service-role key is never involved in token verification.
 */
export const authClient = createClient<Database>(url, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
