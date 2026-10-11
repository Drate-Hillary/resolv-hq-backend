CREATE TABLE "agent_memory_records" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "staff_id" UUID NOT NULL,
    "memory_key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_memory_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_memory_records_staff_id_fkey"
      FOREIGN KEY ("staff_id") REFERENCES "profiles"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "agent_memory_records_staff_id_memory_key_key"
ON "agent_memory_records"("staff_id", "memory_key");

CREATE TABLE "customer_memory_access_logs" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "actor_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "memory_record_id" UUID,
    "action" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_memory_access_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customer_memory_access_logs_customer_id_created_at_idx"
ON "customer_memory_access_logs"("customer_id", "created_at");

CREATE INDEX "customer_memory_access_logs_actor_id_created_at_idx"
ON "customer_memory_access_logs"("actor_id", "created_at");
