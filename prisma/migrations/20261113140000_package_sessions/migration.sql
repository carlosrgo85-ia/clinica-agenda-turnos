-- AlterTable: el paquete puede atarse a un servicio del catálogo y llevar notas.
ALTER TABLE "Package" ADD COLUMN "serviceId" TEXT,
ADD COLUMN "notes" TEXT,
ADD COLUMN "createdByUserId" TEXT;

-- AlterTable: la confirmación humana de que la cita se cumplió. Es lo que
-- descuenta la sesión; no es lo mismo que status = 'atendido' (automático).
ALTER TABLE "Appointment" ADD COLUMN "attendedAt" TIMESTAMP(3),
ADD COLUMN "attendedByUserId" TEXT;

-- CreateIndex
CREATE INDEX "Package_serviceId_idx" ON "Package"("serviceId");

-- AddForeignKey
ALTER TABLE "Package" ADD CONSTRAINT "Package_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Prisma no modela los CHECK: nunca más sesiones usadas que compradas, y un
-- paquete tiene que tener al menos una sesión.
ALTER TABLE "Package" ADD CONSTRAINT "Package_sessions_range"
  CHECK ("totalSessions" > 0 AND "usedSessions" >= 0 AND "usedSessions" <= "totalSessions");
