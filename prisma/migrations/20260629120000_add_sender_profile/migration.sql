-- AlterTable (applied directly on production — local file recreated for history sync)
ALTER TABLE "user_settings" ADD COLUMN     "bookingLink" TEXT,
ADD COLUMN     "senderCompany" TEXT,
ADD COLUMN     "senderName" TEXT,
ADD COLUMN     "senderPosition" TEXT,
ADD COLUMN     "serviceDescription" TEXT;
