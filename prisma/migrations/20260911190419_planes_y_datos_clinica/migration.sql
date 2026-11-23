-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('mensual', 'anual');

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_name_key" ON "Plan"("name");

-- Seed inicial: Base y Plus. IDs fijos y legibles (no hace falta que sean
-- cuids) — el seed de la app los referencia por `name`, no por id, así
-- que esto es solo el punto de partida para un ambiente que corre esta
-- migración por primera vez.
INSERT INTO "Plan" ("id", "name", "description", "isSystem", "features") VALUES
  ('plan_base', 'Base', 'Agendar, recordatorios de 24hs, multi-profesional, dashboard, CRM.', true, ARRAY[]::TEXT[]),
  ('plan_plus', 'Plus', 'Todo lo de Base más recordatorio a 2hs, cobro de seña y seguimiento post-visita.', true, ARRAY['deposito_sena', 'recordatorio_2h', 'seguimiento_post_visita']::TEXT[]);

-- AlterTable: se agregan las columnas nuevas de Clinic, pero los tres
-- booleanos viejos (depositEnabled, reminder2hEnabled,
-- postVisitFollowUpEnabled) TODAVÍA no se borran — hacen falta para el
-- backfill de `planId` de abajo.
ALTER TABLE "Clinic"
  ADD COLUMN     "billingAddress" TEXT,
  ADD COLUMN     "billingEmail" TEXT,
  ADD COLUMN     "billingLegalName" TEXT,
  ADD COLUMN     "billingTaxId" TEXT,
  ADD COLUMN     "contactPhone" TEXT,
  ADD COLUMN     "facebookUrl" TEXT,
  ADD COLUMN     "instagramUrl" TEXT,
  ADD COLUMN     "membershipBillingPeriod" "BillingPeriod",
  ADD COLUMN     "membershipCost" INTEGER,
  ADD COLUMN     "planId" TEXT,
  ADD COLUMN     "tiktokUrl" TEXT,
  ADD COLUMN     "website" TEXT;

-- Backfill: una clínica con cualquiera de los tres flags viejos en true
-- pasa a "Plus", el resto a "Base".
UPDATE "Clinic"
SET "planId" = CASE
  WHEN "depositEnabled" OR "reminder2hEnabled" OR "postVisitFollowUpEnabled" THEN 'plan_plus'
  ELSE 'plan_base'
END;

-- Recién ahora se borran los booleanos viejos, ya reemplazados por
-- `planId` + `Plan.features`.
ALTER TABLE "Clinic"
  DROP COLUMN "depositEnabled",
  DROP COLUMN "postVisitFollowUpEnabled",
  DROP COLUMN "reminder2hEnabled";

-- AddForeignKey
ALTER TABLE "Clinic" ADD CONSTRAINT "Clinic_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: Country.currency nullable primero, para poder backfillear
-- los países que ya existen antes de exigirlo.
ALTER TABLE "Country" ADD COLUMN "currency" TEXT;

UPDATE "Country" SET "currency" = 'ARS' WHERE "id" = 'AR';
UPDATE "Country" SET "currency" = 'MXN' WHERE "id" = 'MX';
-- Cualquier otro país que ya exista sin moneda conocida: placeholder
-- explícito en vez de adivinar, para que se note que hay que corregirlo.
UPDATE "Country" SET "currency" = 'USD' WHERE "currency" IS NULL;

ALTER TABLE "Country" ALTER COLUMN "currency" SET NOT NULL;
