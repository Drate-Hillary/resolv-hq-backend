import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data, error } = await db
  .from("agent_providers")
  .update({ status: "disabled" })
  .eq("id", "5bdb228e-df39-4a1f-84c5-e9698f1a005b")
  .select("id, name, provider, model, status")
  .single();

if (error) {
  console.error("Update error:", error);
  process.exit(1);
}
console.log("Updated:", data);
