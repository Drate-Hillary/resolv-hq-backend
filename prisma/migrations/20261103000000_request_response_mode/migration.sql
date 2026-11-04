ALTER TABLE "requests"
ADD COLUMN "response_mode" TEXT NOT NULL DEFAULT 'human';

ALTER TABLE "requests"
ADD CONSTRAINT "requests_response_mode_check"
CHECK ("response_mode" IN ('human', 'ai'));
