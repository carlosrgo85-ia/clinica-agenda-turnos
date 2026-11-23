-- Patient: nombre y apellido por separado, observaciones, próxima cita sugerida
-- y control del contacto por iniciativa de la clínica.
ALTER TABLE "Patient"
  ADD COLUMN "firstName" TEXT,
  ADD COLUMN "lastName" TEXT,
  ADD COLUMN "observations" TEXT,
  ADD COLUMN "suggestedNextVisitDate" DATE,
  ADD COLUMN "suggestedNextVisitNote" TEXT,
  ADD COLUMN "outreachOptOut" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "nextVisitOutreachSentAt" TIMESTAMP(3);

-- Se parte el nombre existente: la primera palabra es el nombre y el resto el
-- apellido. Es una heurística y se equivoca con nombres compuestos ("Ana María
-- García"); el personal lo corrige desde el módulo de pacientes. `name` NO se
-- toca: sigue siendo el nombre completo que usa todo el sistema.
UPDATE "Patient"
SET "firstName" = split_part(trim("name"), ' ', 1),
    "lastName" = NULLIF(trim(substr(trim("name"), length(split_part(trim("name"), ' ', 1)) + 1)), '')
WHERE "name" IS NOT NULL AND trim("name") <> '';

-- Comentarios con fecha del personal sobre un paciente.
CREATE TABLE "PatientComment" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "authorName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PatientComment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PatientComment_patientId_createdAt_idx" ON "PatientComment"("patientId", "createdAt");
CREATE INDEX "PatientComment_clinicId_idx" ON "PatientComment"("clinicId");
ALTER TABLE "PatientComment" ADD CONSTRAINT "PatientComment_patientId_fkey"
  FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Catálogo de paquetes de la clínica.
CREATE TABLE "PackageTemplate" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "totalSessions" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PackageTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PackageTemplate_clinicId_name_key" ON "PackageTemplate"("clinicId", "name");
CREATE INDEX "PackageTemplate_clinicId_idx" ON "PackageTemplate"("clinicId");
ALTER TABLE "PackageTemplate" ADD CONSTRAINT "PackageTemplate_clinicId_fkey"
  FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PackageTemplate" ADD CONSTRAINT "PackageTemplate_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PackageTemplate" ADD CONSTRAINT "PackageTemplate_sessions_range"
  CHECK ("totalSessions" > 0 AND "totalSessions" <= 200);

-- Package: de qué plantilla se asignó (informativo: los valores se copian).
ALTER TABLE "Package" ADD COLUMN "templateId" TEXT;
ALTER TABLE "Package" ADD CONSTRAINT "Package_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "PackageTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Clinic: contacto por iniciativa de la clínica. Apagado por defecto.
ALTER TABLE "Clinic"
  ADD COLUMN "nextVisitOutreachEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "nextVisitOutreachLeadDays" INTEGER NOT NULL DEFAULT 14,
  ADD COLUMN "nextVisitTemplateName" TEXT NOT NULL DEFAULT 'proximo_control';
ALTER TABLE "Clinic" ADD CONSTRAINT "Clinic_nextVisitOutreachLeadDays_range"
  CHECK ("nextVisitOutreachLeadDays" >= 0 AND "nextVisitOutreachLeadDays" <= 90);
