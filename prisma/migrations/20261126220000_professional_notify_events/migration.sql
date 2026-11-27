-- Qué tipo de aviso quiere recibir cada profesional (citas nuevas, cambios, cancelaciones).
ALTER TABLE "Professional" ADD COLUMN "notifyOnCreate" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Professional" ADD COLUMN "notifyOnChange" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Professional" ADD COLUMN "notifyOnCancel" BOOLEAN NOT NULL DEFAULT true;
