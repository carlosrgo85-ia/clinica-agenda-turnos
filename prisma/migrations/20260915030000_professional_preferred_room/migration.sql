-- El espacio habitual de cada profesional, como PREFERENCIA.
--
-- Si está ocupado a esa hora se le asigna otro libre y el turno queda
-- marcado con `preferredRoomUnavailable`: sin esa marca, ver al profesional
-- en un consultorio que no es el suyo parece un error de carga en vez de lo
-- que es — que el suyo ya estaba tomado.
--
-- Al ser preferencia y no restricción NO cambia la disponibilidad: se
-- ofrecen y se aceptan los mismos horarios que antes, solo cambia qué
-- espacio se asigna.
ALTER TABLE "Professional" ADD COLUMN "preferredRoomId" TEXT;

ALTER TABLE "Appointment" ADD COLUMN "preferredRoomUnavailable" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Professional"
  ADD CONSTRAINT "Professional_preferredRoomId_fkey"
  FOREIGN KEY ("preferredRoomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;
