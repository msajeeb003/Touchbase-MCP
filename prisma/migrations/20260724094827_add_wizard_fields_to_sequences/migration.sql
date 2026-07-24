-- AlterTable
ALTER TABLE "sequences" ADD COLUMN     "cadence" TEXT,
ADD COLUMN     "channels" JSONB,
ADD COLUMN     "goal" TEXT,
ADD COLUMN     "intensity" TEXT,
ADD COLUMN     "situationPrompt" TEXT,
ADD COLUMN     "situationType" TEXT,
ADD COLUMN     "tone" TEXT;
