-- AlterTable
ALTER TABLE "AgentRequest" ADD COLUMN     "costUsd" DECIMAL(16,8);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clinicId" TEXT,
    "patientId" TEXT,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "category" TEXT,
    "templateName" TEXT,
    "country" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "costUsd" DECIMAL(16,8),

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostRate" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "priceUsd" DECIMAL(16,8) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FxRate" (
    "id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "unitsPerUsd" DECIMAL(16,6) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FxRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageEvent_clinicId_occurredAt_idx" ON "UsageEvent"("clinicId", "occurredAt");

-- CreateIndex
CREATE INDEX "UsageEvent_provider_occurredAt_idx" ON "UsageEvent"("provider", "occurredAt");

-- CreateIndex
CREATE INDEX "CostRate_provider_item_effectiveFrom_idx" ON "CostRate"("provider", "item", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "CostRate_item_effectiveFrom_key" ON "CostRate"("item", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "FxRate_currency_effectiveFrom_key" ON "FxRate"("currency", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
