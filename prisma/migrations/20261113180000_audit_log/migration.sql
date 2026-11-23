-- Appointment: cómo y cuándo se canceló, y de cuál cita se reagendó.
ALTER TABLE "Appointment"
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelledByKind" TEXT,
  ADD COLUMN "cancelledByUserId" TEXT,
  ADD COLUMN "cancelReason" TEXT,
  ADD COLUMN "rescheduledFromId" TEXT;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_rescheduledFromId_fkey"
  FOREIGN KEY ("rescheduledFromId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Eventos de cada cita: la fuente de los reportes de canceladas, reagendadas y atendidas.
CREATE TABLE "AppointmentEvent" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorKind" TEXT NOT NULL,
    "actorUserId" TEXT,
    "reason" TEXT,
    "fromStartTime" TIMESTAMP(3),
    "toStartTime" TIMESTAMP(3),
    "fromProfessionalId" TEXT,
    "toProfessionalId" TEXT,
    "relatedAppointmentId" TEXT,
    "details" JSONB,
    CONSTRAINT "AppointmentEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AppointmentEvent_clinicId_type_occurredAt_idx" ON "AppointmentEvent"("clinicId", "type", "occurredAt");
CREATE INDEX "AppointmentEvent_appointmentId_occurredAt_idx" ON "AppointmentEvent"("appointmentId", "occurredAt");
ALTER TABLE "AppointmentEvent" ADD CONSTRAINT "AppointmentEvent_clinicId_fkey"
  FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AppointmentEvent" ADD CONSTRAINT "AppointmentEvent_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Registro de auditoría de toda la aplicación.
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "userEmail" TEXT,
    "userName" TEXT,
    "clinicId" TEXT,
    "action" TEXT NOT NULL,
    "method" TEXT,
    "route" TEXT,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "outcome" TEXT NOT NULL,
    "statusCode" INTEGER,
    "ip" TEXT,
    "userAgent" TEXT,
    "details" JSONB,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditLog_occurredAt_idx" ON "AuditLog"("occurredAt");
CREATE INDEX "AuditLog_clinicId_occurredAt_idx" ON "AuditLog"("clinicId", "occurredAt");
CREATE INDEX "AuditLog_userId_occurredAt_idx" ON "AuditLog"("userId", "occurredAt");
CREATE INDEX "AuditLog_action_occurredAt_idx" ON "AuditLog"("action", "occurredAt");
CREATE INDEX "AuditLog_resourceType_resourceId_idx" ON "AuditLog"("resourceType", "resourceId");

-- El registro de auditoría SOLO se agrega: ni se edita ni se borra. Un código con un
-- bug, o alguien con acceso a la base, no puede reescribir la historia por
-- accidente. El único camino es una sesión que declare que está haciendo
-- mantenimiento (`SET LOCAL app.audit_maintenance = 'on'`), que es lo que va a usar la
-- futura política de retención y la limpieza de los tests; queda a la vista en
-- cualquier revisión del código.
CREATE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.audit_maintenance', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'AuditLog es de solo escritura: no se puede % un registro de auditoría', lower(TG_OP);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
