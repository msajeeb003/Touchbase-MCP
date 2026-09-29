-- AutoDraft: per-user toggle plus the Fathom webhook registration it controls.
ALTER TABLE "user_settings"
ADD COLUMN     "autoDraftEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fathomWebhookId" TEXT,
ADD COLUMN     "fathomWebhookSecret" TEXT;
