-- AI harness, Phase 2 (safeguards).
-- Additive only: new columns, one new table, new indexes. Nothing is dropped or renamed.
-- Every statement is guarded, so running this file twice is safe.

-- Do-not-contact flag on the lead (fast flag for lists; the checks use suppressed_contacts).
ALTER TABLE "leads"
ADD COLUMN IF NOT EXISTS "doNotContact" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "doNotContactAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "doNotContactReason" TEXT,
ADD COLUMN IF NOT EXISTS "doNotContactSource" TEXT;

-- Approval record, pause reason, and the run that made the sequence.
ALTER TABLE "sequences"
ADD COLUMN IF NOT EXISTS "runId" TEXT,
ADD COLUMN IF NOT EXISTS "approvalStatus" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN IF NOT EXISTS "approvalRequestedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "approvedByUserId" TEXT,
ADD COLUMN IF NOT EXISTS "approvedContentHash" TEXT,
ADD COLUMN IF NOT EXISTS "pausedReason" TEXT,
ADD COLUMN IF NOT EXISTS "pausedAt" TIMESTAMP(3);

-- Claim-before-send, delivery mode (live or mock), and the delay used at approval.
ALTER TABLE "sequence_steps"
ADD COLUMN IF NOT EXISTS "runId" TEXT,
ADD COLUMN IF NOT EXISTS "delayMinutes" INTEGER,
ADD COLUMN IF NOT EXISTS "sendingStartedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "deliveryMode" TEXT;

-- Send window. "sendTimezone" has no default on purpose: the user must choose it.
ALTER TABLE "user_settings"
ADD COLUMN IF NOT EXISTS "sendWindowStart" TEXT NOT NULL DEFAULT '09:00',
ADD COLUMN IF NOT EXISTS "sendWindowEnd" TEXT NOT NULL DEFAULT '18:00',
ADD COLUMN IF NOT EXISTS "sendOnWeekends" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "sendTimezone" TEXT;

-- One row per blocked email address or phone number. Kept when the lead is deleted.
CREATE TABLE IF NOT EXISTS "suppressed_contacts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT,
    "source" TEXT NOT NULL,
    "runId" TEXT,
    "leadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" TIMESTAMP(3),
    "clearedByUserId" TEXT,
    "clearReason" TEXT,

    CONSTRAINT "suppressed_contacts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "suppressed_contacts_userId_idx" ON "suppressed_contacts"("userId");

CREATE UNIQUE INDEX IF NOT EXISTS "suppressed_contacts_userId_kind_value_key" ON "suppressed_contacts"("userId", "kind", "value");

CREATE INDEX IF NOT EXISTS "sequences_runId_idx" ON "sequences"("runId");

-- One sequence per lead per run: a repeated tool call cannot create a duplicate.
-- Rows made by the app have a NULL "runId" and are not affected.
CREATE UNIQUE INDEX IF NOT EXISTS "sequences_runId_leadId_key" ON "sequences"("runId", "leadId");

CREATE INDEX IF NOT EXISTS "sequence_steps_runId_idx" ON "sequence_steps"("runId");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'suppressed_contacts_userId_fkey'
    ) THEN
        ALTER TABLE "suppressed_contacts"
        ADD CONSTRAINT "suppressed_contacts_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
