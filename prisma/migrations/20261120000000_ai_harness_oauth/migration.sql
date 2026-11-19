-- AI harness: OAuth 2.1 sign-in, so each customer connects Claude with their own Touchbase account.
-- Additive only: four new tables, their indexes and foreign keys. Nothing is dropped or renamed.
-- Every statement is guarded, so running this file twice is safe.

-- CreateTable
CREATE TABLE IF NOT EXISTS "oauth_clients" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "redirectUris" JSONB NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "oauth_auth_codes" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "grantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_auth_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "oauth_grants" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "oauth_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "oauth_tokens" (
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_clients_clientId_key" ON "oauth_clients"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_auth_codes_codeHash_key" ON "oauth_auth_codes"("codeHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "oauth_auth_codes_userId_idx" ON "oauth_auth_codes"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "oauth_grants_userId_idx" ON "oauth_grants"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_tokens_tokenHash_key" ON "oauth_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "oauth_tokens_grantId_idx" ON "oauth_tokens"("grantId");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_auth_codes_userId_fkey') THEN
        ALTER TABLE "oauth_auth_codes" ADD CONSTRAINT "oauth_auth_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_grants_userId_fkey') THEN
        ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_tokens_grantId_fkey') THEN
        ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "oauth_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
