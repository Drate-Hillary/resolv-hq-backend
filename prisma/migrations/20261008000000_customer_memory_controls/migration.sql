ALTER TABLE "customer_memory"
ADD COLUMN "is_enabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "customer_profiles"
ADD COLUMN "memory_enabled" BOOLEAN NOT NULL DEFAULT true;
