-- CreateEnum
CREATE TYPE "MembershipPricing" AS ENUM ('lista', 'especial', 'exonerada');

-- CreateEnum
CREATE TYPE "MembershipPriceScope" AS ENUM ('lista', 'clinica');

-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "membershipCurrency" TEXT,
ADD COLUMN     "membershipPricedAt" TIMESTAMP(3),
ADD COLUMN     "membershipPricing" "MembershipPricing",
ADD COLUMN     "membershipReason" TEXT,
ALTER COLUMN "membershipCost" SET DATA TYPE DECIMAL(12,2);

-- CreateTable
CREATE TABLE "PlanPrice" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "countryId" TEXT NOT NULL,
    "billingPeriod" "BillingPeriod" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipPriceChange" (
    "id" TEXT NOT NULL,
    "scope" "MembershipPriceScope" NOT NULL,
    "planPriceId" TEXT,
    "clinicId" TEXT,
    "fromPricing" "MembershipPricing",
    "toPricing" "MembershipPricing",
    "fromAmount" DECIMAL(12,2),
    "toAmount" DECIMAL(12,2),
    "fromPeriod" "BillingPeriod",
    "toPeriod" "BillingPeriod",
    "currency" TEXT,
    "reason" TEXT,
    "changedById" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MembershipPriceChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlanPrice_countryId_idx" ON "PlanPrice"("countryId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanPrice_planId_countryId_billingPeriod_key" ON "PlanPrice"("planId", "countryId", "billingPeriod");

-- CreateIndex
CREATE INDEX "MembershipPriceChange_clinicId_changedAt_idx" ON "MembershipPriceChange"("clinicId", "changedAt");

-- CreateIndex
CREATE INDEX "MembershipPriceChange_planPriceId_changedAt_idx" ON "MembershipPriceChange"("planPriceId", "changedAt");

-- AddForeignKey
ALTER TABLE "PlanPrice" ADD CONSTRAINT "PlanPrice_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanPrice" ADD CONSTRAINT "PlanPrice_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipPriceChange" ADD CONSTRAINT "MembershipPriceChange_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Los CHECK van a mano: Prisma no los modela, y son la última línea si el
-- código se olvida. Están documentados en el comentario de `Clinic` en
-- schema.prisma para que la próxima migración no los pise sin querer.

-- Un precio de lista en cero o negativo no es un precio.
ALTER TABLE "PlanPrice" ADD CONSTRAINT "PlanPrice_amount_positivo" CHECK ("amount" > 0);

-- Las cuatro combinaciones válidas de membresía. Lo que esto impide, sobre
-- todo: una clínica exonerada con monto, un precio sin moneda o sin
-- periodicidad (no se podría facturar), y una exoneración sin motivo, que es
-- indistinguible de un error de carga.
ALTER TABLE "Clinic" ADD CONSTRAINT "Clinic_membresia_coherente" CHECK (
  ("membershipPricing" IS NULL AND "membershipCost" IS NULL)
  OR (
    "membershipPricing" = 'exonerada'
    AND "membershipCost" IS NULL
    AND "membershipReason" IS NOT NULL
  )
  OR (
    "membershipPricing" IN ('lista', 'especial')
    AND "membershipCost" > 0
    AND "membershipCurrency" IS NOT NULL
    AND "membershipBillingPeriod" IS NOT NULL
  )
);
