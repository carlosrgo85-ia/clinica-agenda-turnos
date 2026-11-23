-- CreateEnum
CREATE TYPE "CalendarProviderKind" AS ENUM ('google', 'microsoft');

-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "sharedCalendarMicrosoftAccountId" TEXT,
ADD COLUMN     "sharedCalendarProvider" "CalendarProviderKind" NOT NULL DEFAULT 'google';

-- AlterTable
ALTER TABLE "Professional" ADD COLUMN     "calendarProvider" "CalendarProviderKind" NOT NULL DEFAULT 'google',
ADD COLUMN     "microsoftAccountId" TEXT;

-- CreateTable
CREATE TABLE "MicrosoftAccount" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "refreshTokenEncrypted" TEXT NOT NULL,
    "accessTokenEncrypted" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MicrosoftAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MicrosoftAccount_clinicId_idx" ON "MicrosoftAccount"("clinicId");

-- CreateIndex
CREATE UNIQUE INDEX "MicrosoftAccount_clinicId_email_key" ON "MicrosoftAccount"("clinicId", "email");

-- AddForeignKey
ALTER TABLE "Clinic" ADD CONSTRAINT "Clinic_sharedCalendarMicrosoftAccountId_fkey" FOREIGN KEY ("sharedCalendarMicrosoftAccountId") REFERENCES "MicrosoftAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MicrosoftAccount" ADD CONSTRAINT "MicrosoftAccount_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Professional" ADD CONSTRAINT "Professional_microsoftAccountId_fkey" FOREIGN KEY ("microsoftAccountId") REFERENCES "MicrosoftAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
