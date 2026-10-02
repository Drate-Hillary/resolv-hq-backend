import "dotenv/config";
import { createApp } from "./app.js";
import { warmUpDatabase } from "./lib/prisma.js";
import { startRealtime } from "./lib/realtime.js";

const port = Number(process.env.PORT ?? 4000);
const app = createApp();
startRealtime();
void warmUpDatabase();

app.listen(port, () => {
  console.log(`resolv-hq-backend listening on :${port}`);
});
