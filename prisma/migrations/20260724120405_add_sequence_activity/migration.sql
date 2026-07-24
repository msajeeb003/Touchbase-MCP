-- CreateTable
CREATE TABLE "sequence_activities" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "stepId" TEXT,
    "eventType" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sequence_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sequence_activities_sequenceId_idx" ON "sequence_activities"("sequenceId");

-- CreateIndex
CREATE INDEX "sequence_activities_sequenceId_createdAt_idx" ON "sequence_activities"("sequenceId", "createdAt");

-- AddForeignKey
ALTER TABLE "sequence_activities" ADD CONSTRAINT "sequence_activities_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_activities" ADD CONSTRAINT "sequence_activities_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "sequence_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;
