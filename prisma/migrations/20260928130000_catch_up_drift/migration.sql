-- Catches up migration history with drift that landed directly on the
-- database outside Prisma (ai_messages.feedback + its check constraint,
-- and the boundary_rules/clarification_triggers tables). Resolved as
-- --applied, never executed, against the real database, where all of this
-- already exists; it only runs for real on a from-scratch database.
--
-- The 9 "auth"."*" enum types `migrate diff` proposed here are omitted —
-- same reasoning as the init migration: Supabase's auth schema is
-- external and already has them on any real project.

-- AlterTable
ALTER TABLE "ai_messages" ADD COLUMN "feedback" TEXT;
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_feedback_check"
  CHECK (feedback IS NULL OR feedback IN ('up', 'down'));

-- CreateTable
CREATE TABLE "boundary_rules" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "category" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "fallback_message" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "boundary_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clarification_triggers" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "pattern" TEXT,
    "question" TEXT NOT NULL,
    "is_fallback" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clarification_triggers_pkey" PRIMARY KEY ("id")
);
