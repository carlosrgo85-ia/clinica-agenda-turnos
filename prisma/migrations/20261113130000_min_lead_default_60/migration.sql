-- El default pasa de 0 (sin mínimo) a 60 minutos: reservar para dentro de un
-- minuto no le sirve a nadie.
ALTER TABLE "Clinic" ALTER COLUMN "minLeadMinutes" SET DEFAULT 60;

-- La columna se agregó en la migración anterior con default 0, así que ninguna
-- clínica existente tiene un valor elegido a propósito: todas pasan al nuevo
-- default. Una que quiera otro valor lo cambia desde el detalle de la clínica.
UPDATE "Clinic" SET "minLeadMinutes" = 60 WHERE "minLeadMinutes" = 0;
