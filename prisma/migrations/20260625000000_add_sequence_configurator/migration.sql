-- AlterTable (applied directly on production — local file recreated for history sync)
ALTER TABLE "sequences" ADD COLUMN     "channels" JSONB,
ADD COLUMN     "goal" TEXT,
ADD COLUMN     "intensity" TEXT,
ADD COLUMN     "intervalDays" INTEGER,
ADD COLUMN     "situation" TEXT,
ADD COLUMN     "tone" TEXT;
