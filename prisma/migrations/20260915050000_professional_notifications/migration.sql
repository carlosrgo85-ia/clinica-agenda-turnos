-- Contacto del profesional y sus avisos al asignarle un turno.
--
-- Los dos avisos arrancan APAGADOS: mandarle mensajes a alguien que no los
-- pidió es la forma más rápida de que la clínica apague el bot entero.
--
-- El de WhatsApp además exige una plantilla aprobada por Meta
-- (`cita_asignada_profesional`), porque el profesional no escribió primero y
-- la ventana de 24hs está cerrada. Mismo caso que `Clinic.urgencyNotifyPhone`.
ALTER TABLE "Professional" ADD COLUMN "contactEmail" TEXT;
ALTER TABLE "Professional" ADD COLUMN "whatsappPhone" TEXT;
ALTER TABLE "Professional" ADD COLUMN "notifyByEmail" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Professional" ADD COLUMN "notifyByWhatsapp" BOOLEAN NOT NULL DEFAULT false;
