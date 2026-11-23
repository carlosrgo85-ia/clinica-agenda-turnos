-- CreateEnum
CREATE TYPE "EscalationReason" AS ENUM ('urgencia', 'consulta_clinica', 'otro');

-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "urgencyNotifyEmail" TEXT,
ADD COLUMN     "urgencyNotifyPhone" TEXT;

-- CreateTable
CREATE TABLE "Escalation" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT,
    "patientPhone" TEXT NOT NULL,
    "patientName" TEXT,
    "reason" "EscalationReason" NOT NULL,
    "patientMessage" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "notifiedByEmail" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Escalation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Escalation_clinicId_resolvedAt_createdAt_idx" ON "Escalation"("clinicId", "resolvedAt", "createdAt");

-- AddForeignKey
ALTER TABLE "Escalation" ADD CONSTRAINT "Escalation_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Escalation" ADD CONSTRAINT "Escalation_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
