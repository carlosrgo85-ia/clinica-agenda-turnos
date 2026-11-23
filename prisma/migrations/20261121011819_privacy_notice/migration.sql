-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "privacyNoticeUrl" TEXT;

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "privacyNoticeSentAt" TIMESTAMP(3);
