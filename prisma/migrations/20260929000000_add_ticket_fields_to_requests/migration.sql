-- AlterTable
ALTER TABLE "requests" ADD COLUMN     "ai_handled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "closed_at" TIMESTAMPTZ(6),
ADD COLUMN     "ticket_number" BIGSERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "requests_ticket_number_key" ON "requests"("ticket_number");
