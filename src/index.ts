import "dotenv/config";
import { createApp } from "./app.js";
import { warmUpDatabase } from "./lib/prisma.js";
import { startRealtime } from "./lib/realtime.js";
import { startRetentionJob } from "./lib/retention.js";

const port = Number(process.env.PORT ?? 4000);
const app = createApp();
startRealtime();
startRetentionJob();
void warmUpDatabase();

app.listen(port, () => {
  console.log(`resolv-hq-backend listening on :${port}`);
});
