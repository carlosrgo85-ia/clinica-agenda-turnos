-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "sharedCalendarAccountId" TEXT;

-- AlterTable
ALTER TABLE "Professional" ADD COLUMN     "googleAccountId" TEXT;

-- CreateTable
CREATE TABLE "GoogleAccount" (
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

    CONSTRAINT "GoogleAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoogleAccount_clinicId_idx" ON "GoogleAccount"("clinicId");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleAccount_clinicId_email_key" ON "GoogleAccount"("clinicId", "email");

-- AddForeignKey
ALTER TABLE "Clinic" ADD CONSTRAINT "Clinic_sharedCalendarAccountId_fkey" FOREIGN KEY ("sharedCalendarAccountId") REFERENCES "GoogleAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleAccount" ADD CONSTRAINT "GoogleAccount_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Professional" ADD CONSTRAINT "Professional_googleAccountId_fkey" FOREIGN KEY ("googleAccountId") REFERENCES "GoogleAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
