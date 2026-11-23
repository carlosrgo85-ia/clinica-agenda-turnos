-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "firstVisit" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "_ProfessionalServices" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "_ProfessionalServices_AB_unique" ON "_ProfessionalServices"("A", "B");

-- CreateIndex
CREATE INDEX "_ProfessionalServices_B_index" ON "_ProfessionalServices"("B");

-- AddForeignKey
ALTER TABLE "_ProfessionalServices" ADD CONSTRAINT "_ProfessionalServices_A_fkey" FOREIGN KEY ("A") REFERENCES "Professional"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProfessionalServices" ADD CONSTRAINT "_ProfessionalServices_B_fkey" FOREIGN KEY ("B") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: hasta ahora cualquier profesional podía dar cualquier servicio, así
-- que las clínicas existentes arrancan con ese mismo comportamiento explícito
-- (todos × todos, dentro de la misma clínica). Después cada clínica lo ajusta
-- desde la pantalla. Sin esto, la regla nueva ("sin servicios no hace nada")
-- dejaría sin turnos a todas las clínicas ya cargadas.
INSERT INTO "_ProfessionalServices" ("A", "B")
SELECT p."id", s."id"
FROM "Professional" p
JOIN "Service" s ON s."clinicId" = p."clinicId";
