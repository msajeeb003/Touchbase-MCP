-- AI harness, Phase 3 (run tracking and access tokens).
-- Additive only: three new tables, three new columns, new indexes and foreign keys.
-- Nothing is dropped or renamed. Every statement is guarded, so running this
-- file twice is safe.

-- What each message was based on (filled by the write tools in Phase 4).
ALTER TABLE "sequence_steps"
ADD COLUMN IF NOT EXISTS "basis" TEXT,
ADD COLUMN IF NOT EXISTS "basedOnTranscriptIds" JSONB,
ADD COLUMN IF NOT EXISTS "basedOnNote" TEXT;

-- One run per instruction the user typed in Claude.
CREATE TABLE IF NOT EXISTS "agent_runs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "summary" TEXT,
    "clientName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- One row per tool call made inside a run.
CREATE TABLE IF NOT EXISTS "agent_run_events" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "toolName" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "errorCode" TEXT,
    "touched" JSONB NOT NULL DEFAULT '[]',
    "detail" JSONB,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_events_pkey" PRIMARY KEY ("id")
);

-- Access tokens for Claude. Only the SHA-256 hash of a token is stored.
CREATE TABLE IF NOT EXISTS "api_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "agent_runs_userId_createdAt_idx" ON "agent_runs"("userId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "agent_run_events_runId_seq_key" ON "agent_run_events"("runId", "seq");

CREATE UNIQUE INDEX IF NOT EXISTS "api_tokens_tokenHash_key" ON "api_tokens"("tokenHash");

CREATE INDEX IF NOT EXISTS "api_tokens_userId_idx" ON "api_tokens"("userId");

DO $$
BEGIN
    -- A sequence made in a run points at that run. Rows made by the app have a
    -- NULL "runId" and are not affected. A run that still has sequences cannot
    -- be deleted on its own (NO ACTION), so a sequence can never lose its run
    -- and with it the approval and send-window checks.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sequences_runId_fkey') THEN
        ALTER TABLE "sequences"
        ADD CONSTRAINT "sequences_runId_fkey"
        FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_userId_fkey') THEN
        ALTER TABLE "agent_runs"
        ADD CONSTRAINT "agent_runs_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_run_events_runId_fkey') THEN
        ALTER TABLE "agent_run_events"
        ADD CONSTRAINT "agent_run_events_runId_fkey"
        FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_tokens_userId_fkey') THEN
        ALTER TABLE "api_tokens"
        ADD CONSTRAINT "api_tokens_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
