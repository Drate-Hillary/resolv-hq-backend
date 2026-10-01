import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data, error } = await db
  .from("agent_providers")
  .select("id, name, provider, model, status, created_at, api_key")
  .order("created_at", { ascending: false });

if (error) {
  console.error("Query error:", error);
  process.exit(1);
}

for (const row of data ?? []) {
  console.log({
    id: row.id,
    name: row.name,
    provider: row.provider,
    model: row.model,
    status: row.status,
    created_at: row.created_at,
    api_key_last4: row.api_key ? row.api_key.slice(-4) : null,
    api_key_len: row.api_key ? row.api_key.length : 0,
  });
}
console.log(`Total rows: ${(data ?? []).length}`);
