import { Badge, type BadgeVariant } from "./badge";

export type Status =
  | "active"
  | "inactive"
  | "system"
  // Appointment.status
  | "confirmado"
  | "cancelado"
  | "atendido"
  // PatientStage
  | "nuevo_contacto"
  | "interesado"
  | "turno_agendado"
  | "turno_confirmado"
  | "yaCargado"
  | "pendiente";

const STATUS_CONFIG: Record<Status, { label: string; variant: BadgeVariant }> = {
  active: { label: "Activo", variant: "default" },
  inactive: { label: "Desactivado", variant: "outline" },
  system: { label: "Sistema", variant: "secondary" },

  confirmado: { label: "Confirmado", variant: "default" },
  cancelado: { label: "Cancelado", variant: "destructive" },
  atendido: { label: "Cita cumplida (automático)", variant: "secondary" },

  nuevo_contacto: { label: "Nuevo contacto", variant: "outline" },
  interesado: { label: "Interesado", variant: "secondary" },
  turno_agendado: { label: "Cita agendada", variant: "default" },
  turno_confirmado: { label: "Cita confirmada", variant: "default" },

  yaCargado: { label: "Cargado", variant: "default" },
  pendiente: { label: "Pendiente", variant: "outline" },
};

/**
 * Un status como pill de color, no como texto suelto — para que el estado
 * de una fila se lea de un vistazo en una tabla larga. Cubre los estados
 * de `User.active`, `Appointment.status`, `PatientStage` y el `yaCargado`
 * de feriados/roles de sistema.
 */
export function StatusBadge({ status }: { status: Status }) {
  const config = STATUS_CONFIG[status];
  return <Badge variant={config.variant}>{config.label}</Badge>;
}
