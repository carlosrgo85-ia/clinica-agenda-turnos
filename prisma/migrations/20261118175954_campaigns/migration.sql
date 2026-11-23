-- CreateEnum
CREATE TYPE "CampaignTriggerKind" AS ENUM ('texto', 'anuncio');

-- CreateEnum
CREATE TYPE "CampaignLeadStatus" AS ENUM ('abierto', 'convertido', 'cerrado');

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "campaignId" TEXT;

-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "campaignFollowUpEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startsOn" DATE,
    "endsOn" DATE,
    "serviceId" TEXT,
    "followUpMaxAttempts" INTEGER NOT NULL DEFAULT 2,
    "followUpAfterHours" INTEGER NOT NULL DEFAULT 24,
    "followUpIntervalHours" INTEGER NOT NULL DEFAULT 48,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignTrigger" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "kind" "CampaignTriggerKind" NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "CampaignTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignLead" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "patientPhone" TEXT NOT NULL,
    "triggerKind" "CampaignTriggerKind" NOT NULL,
    "isNewContact" BOOLEAN NOT NULL,
    "status" "CampaignLeadStatus" NOT NULL DEFAULT 'abierto',
    "closedReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "firstMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastInboundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "convertedAt" TIMESTAMP(3),
    "followUpCount" INTEGER NOT NULL DEFAULT 0,
    "lastFollowUpAt" TIMESTAMP(3),

    CONSTRAINT "CampaignLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_CampaignProfessionals" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "Campaign_clinicId_active_idx" ON "Campaign"("clinicId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_clinicId_name_key" ON "Campaign"("clinicId", "name");

-- CreateIndex
CREATE INDEX "CampaignTrigger_campaignId_idx" ON "CampaignTrigger"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignTrigger_clinicId_kind_value_key" ON "CampaignTrigger"("clinicId", "kind", "value");

-- CreateIndex
CREATE INDEX "CampaignLead_clinicId_patientPhone_firstMessageAt_idx" ON "CampaignLead"("clinicId", "patientPhone", "firstMessageAt");

-- CreateIndex
CREATE INDEX "CampaignLead_clinicId_status_lastInboundAt_idx" ON "CampaignLead"("clinicId", "status", "lastInboundAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignLead_clinicId_campaignId_patientPhone_key" ON "CampaignLead"("clinicId", "campaignId", "patientPhone");

-- CreateIndex
CREATE UNIQUE INDEX "_CampaignProfessionals_AB_unique" ON "_CampaignProfessionals"("A", "B");

-- CreateIndex
CREATE INDEX "_CampaignProfessionals_B_index" ON "_CampaignProfessionals"("B");

-- CreateIndex
CREATE INDEX "Appointment_campaignId_idx" ON "Appointment"("campaignId");

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTrigger" ADD CONSTRAINT "CampaignTrigger_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLead" ADD CONSTRAINT "CampaignLead_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLead" ADD CONSTRAINT "CampaignLead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CampaignProfessionals" ADD CONSTRAINT "_CampaignProfessionals_A_fkey" FOREIGN KEY ("A") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CampaignProfessionals" ADD CONSTRAINT "_CampaignProfessionals_B_fkey" FOREIGN KEY ("B") REFERENCES "Professional"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Los límites del seguimiento: sin esto una campaña podría insistir sin tope. 0 intentos = sin seguimiento.
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_followUpMaxAttempts_check" CHECK ("followUpMaxAttempts" BETWEEN 0 AND 5);
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_followUpAfterHours_check" CHECK ("followUpAfterHours" BETWEEN 1 AND 720);
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_followUpIntervalHours_check" CHECK ("followUpIntervalHours" BETWEEN 1 AND 720);
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_vigencia_check" CHECK ("startsOn" IS NULL OR "endsOn" IS NULL OR "endsOn" >= "startsOn");
ALTER TABLE "CampaignLead" ADD CONSTRAINT "CampaignLead_followUpCount_check" CHECK ("followUpCount" >= 0);
