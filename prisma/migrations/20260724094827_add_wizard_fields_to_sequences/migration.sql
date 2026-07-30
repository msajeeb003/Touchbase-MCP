-- AlterTable
-- channels/goal/intensity/tone already exist from 20260625000000_add_sequence_configurator
ALTER TABLE "sequences" ADD COLUMN     "cadence" TEXT,
ADD COLUMN     "situationPrompt" TEXT,
ADD COLUMN     "situationType" TEXT;
