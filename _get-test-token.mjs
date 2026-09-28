import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

const admin = createClient(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
const anon = createClient(url, publishableKey, { auth: { autoRefreshToken: false, persistSession: false } });

const userId = "1cecdecf-d8ef-4483-941c-82529f57af7f";
const email = "claude-migration-test+1790603325513@example.com";
const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;

const { error: updateErr } = await admin.auth.admin.updateUserById(userId, { password });
if (updateErr) {
  console.error("updateUserById failed:", updateErr);
  process.exit(1);
}

const { data: signedIn, error: signInErr } = await anon.auth.signInWithPassword({ email, password });
if (signInErr || !signedIn.session) {
  console.error("signInWithPassword failed:", signInErr);
  process.exit(1);
}

console.log("ACCESS_TOKEN=" + signedIn.session.access_token);
console.log("USER_ID=" + userId);
