-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN "minLeadMinutes" INTEGER NOT NULL DEFAULT 0;

-- Prisma no modela los CHECK: 0 = sin mínimo, y como máximo una semana (un
-- valor mayor casi seguro es un typo y la clínica quedaría sin horarios).
ALTER TABLE "Clinic" ADD CONSTRAINT "Clinic_minLeadMinutes_range"
  CHECK ("minLeadMinutes" >= 0 AND "minLeadMinutes" <= 10080);
