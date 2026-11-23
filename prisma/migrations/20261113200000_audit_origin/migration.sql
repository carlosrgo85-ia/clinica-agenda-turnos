-- AuditLog: desde dónde se originó la operación (panel, whatsapp o sistema).
ALTER TABLE "AuditLog" ADD COLUMN "origin" TEXT;

-- Todo lo registrado hasta ahora salió del middleware de la API, o sea de una persona en el
-- panel. El trigger de solo escritura impide el UPDATE, así que se declara mantenimiento
-- para esta sola pasada (a nivel de sesión, porque la migración no corre en un bloque de
-- transacción explícito) y se vuelve a apagar enseguida.
SELECT set_config('app.audit_maintenance', 'on', false);
UPDATE "AuditLog" SET "origin" = 'panel' WHERE "origin" IS NULL;
SELECT set_config('app.audit_maintenance', 'off', false);

CREATE INDEX "AuditLog_origin_occurredAt_idx" ON "AuditLog"("origin", "occurredAt");
