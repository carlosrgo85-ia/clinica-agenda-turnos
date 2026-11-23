-- Retira la regla vieja de "primera vez con el profesional principal"
-- (Clinic.firstVisitToLeadProfessionalEnabled / leadProfessionalId). La
-- reemplaza Service.firstVisit: el servicio de primera vez, que solo hacen
-- los profesionales asignados.
--
-- No migra datos solo: crear un servicio y asignarlo es una decisión de la
-- clínica. Si alguna todavía depende de la regla vieja, frena acá en vez de
-- cambiarle el comportamiento en silencio.
DO $$
DECLARE
  pendientes text;
BEGIN
  SELECT string_agg(c."name", ', ') INTO pendientes
  FROM "Clinic" c
  WHERE c."firstVisitToLeadProfessionalEnabled" = true
    AND c."leadProfessionalId" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "Service" s
      WHERE s."clinicId" = c."id" AND s."firstVisit" = true AND s."active" = true
    );
  IF pendientes IS NOT NULL THEN
    RAISE EXCEPTION 'Estas clinicas usan la regla vieja del profesional principal y no tienen servicio de primera vez: %. Marcar un servicio como "primera vez" y asignarlo al profesional antes de migrar.', pendientes;
  END IF;
END $$;

ALTER TABLE "Clinic" DROP CONSTRAINT "Clinic_leadProfessionalId_fkey";
ALTER TABLE "Clinic" DROP COLUMN "firstVisitToLeadProfessionalEnabled";
ALTER TABLE "Clinic" DROP COLUMN "leadProfessionalId";
