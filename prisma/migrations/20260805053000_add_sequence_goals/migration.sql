-- CreateTable
CREATE TABLE "sequence_goals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequence_goals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sequence_goals_userId_idx" ON "sequence_goals"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "sequence_goals_userId_label_key" ON "sequence_goals"("userId", "label");

-- AddForeignKey
ALTER TABLE "sequence_goals" ADD CONSTRAINT "sequence_goals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
