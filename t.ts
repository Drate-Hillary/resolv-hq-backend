import "dotenv/config";
import { prisma } from "./src/lib/prisma.js";
import { loadPublishedPassages } from "./src/lib/knowledge-index.js";
import { answerQuestion } from "./src/lib/ai.js";
try {
const passages = await loadPublishedPassages();
for (const q of ["how do refunds work", "when are invoices due", "what does a refund request need"]) {
  const a = answerQuestion(q, passages, []);
  console.log("\nQ:", q, "\nA:", a.text);
}
} catch (e) { console.log("ERR:", String((e as Error).message).slice(0, 300)); }
await prisma.$disconnect();
