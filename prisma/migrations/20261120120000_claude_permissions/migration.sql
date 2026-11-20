-- AI harness: workspace switches for new Claude actions (all OFF by default),
-- soft delete of leads, who released a sequence, and SMS replies.
-- Additive: new columns with defaults or NULL. One constraint is relaxed:
-- lead_inbound_emails."fromEmail" may be NULL (an SMS reply has no email).
-- Every statement is guarded, so running this file twice is safe.

ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "claudeCanActivate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "claudeCanResume" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "claudeCanEditSettings" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "claudeCanDeleteLeads" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "claudeCanClearDoNotContact" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "claudeDailyActivationCap" INTEGER NOT NULL DEFAULT 50;

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "deletedReason" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "deletedBy" TEXT;

ALTER TABLE "sequences" ADD COLUMN IF NOT EXISTS "approvedByActor" TEXT;

ALTER TABLE "lead_inbound_emails" ADD COLUMN IF NOT EXISTS "channel" TEXT NOT NULL DEFAULT 'email';
ALTER TABLE "lead_inbound_emails" ADD COLUMN IF NOT EXISTS "fromPhone" TEXT;
ALTER TABLE "lead_inbound_emails" ALTER COLUMN "fromEmail" DROP NOT NULL;
