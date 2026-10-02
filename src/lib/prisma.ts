import { PrismaClient } from "@prisma/client";

// Prisma's default connect timeout is 5s. Cold connections to the Supabase
// pooler (DNS + TLS + pgbouncer) can exceed that, so the first query after a
// start fails with P1001 and later ones succeed. Give the connect more room.
function withConnectTimeout(url: string | undefined, seconds: number): string | undefined {
  if (!url || /[?&]connect_timeout=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}connect_timeout=${seconds}`;
}

const url = withConnectTimeout(process.env.DATABASE_URL, 30);

export const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : new PrismaClient();

/** Opens the connection up front (with retries) so the first real request
 * doesn't pay the cold-connect cost or fail on a transient network blip. */
export async function warmUpDatabase(attempts = 4): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await prisma.$connect();
      return;
    } catch (err) {
      console.error(`database connect attempt ${i}/${attempts} failed:`, (err as Error).message.split("\n").pop());
      if (i < attempts) await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
  console.error("database still unreachable; requests will retry on demand");
}
