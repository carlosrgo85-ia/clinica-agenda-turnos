-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "adminPhone" TEXT,
ADD COLUMN     "configAlertTemplateName" TEXT NOT NULL DEFAULT 'aviso_configuracion',
ADD COLUMN     "country" TEXT,
ADD COLUMN     "holidayAlertSentAt" TIMESTAMP(3);
