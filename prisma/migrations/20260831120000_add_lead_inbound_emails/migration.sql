-- CreateTable
CREATE TABLE "lead_inbound_emails" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "toEmail" TEXT,
    "subject" TEXT,
    "bodyText" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_inbound_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imap_sync_states" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastUid" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "imap_sync_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_inbound_emails_leadId_receivedAt_idx" ON "lead_inbound_emails"("leadId", "receivedAt");

-- CreateIndex
CREATE INDEX "lead_inbound_emails_userId_idx" ON "lead_inbound_emails"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "lead_inbound_emails_userId_messageId_key" ON "lead_inbound_emails"("userId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "imap_sync_states_userId_key" ON "imap_sync_states"("userId");

-- AddForeignKey
ALTER TABLE "lead_inbound_emails" ADD CONSTRAINT "lead_inbound_emails_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_inbound_emails" ADD CONSTRAINT "lead_inbound_emails_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imap_sync_states" ADD CONSTRAINT "imap_sync_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
