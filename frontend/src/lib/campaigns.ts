/** Lo que devuelve `GET .../campaigns` y `GET .../campaigns/leads`. */
export type EstadoCampana = "vigente" | "programada" | "vencida" | "inactiva";
export type TipoDeFormato = "texto" | "anuncio";

export interface FormatoDeCampana {
  kind: TipoDeFormato;
  value: string;
}

export interface Estadisticas {
  contacts: number;
  newContacts: number;
  converted: number;
  open: number;
  closedNoReply: number;
  followUpsSent: number;
  appointments: number;
  viaAd: number;
  viaText: number;
  viaAssistant: number;
}

export interface Campana {
  id: string;
  name: string;
  channel: string | null;
  description: string | null;
  active: boolean;
  startsOn: string | null;
  endsOn: string | null;
  serviceId: string | null;
  service: { id: string; name: string; active: boolean } | null;
  extraProfessionals: Array<{ id: string; name: string; active: boolean }>;
  triggers: FormatoDeCampana[];
  followUpMaxAttempts: number;
  followUpAfterHours: number;
  followUpIntervalHours: number;
  estado: EstadoCampana;
  estadisticas: Estadisticas;
}

export interface OpcionesDeCampana {
  servicios: Array<{ id: string; name: string; profesionalIds: string[] }>;
  profesionales: Array<{ id: string; name: string }>;
}

export interface RespuestaDeCampanas {
  seguimientoHabilitado: boolean;
  /** El plan de la clínica incluye el seguimiento (aunque esté apagado). */
  seguimientoEnPlan?: boolean;
  campanas: Campana[];
  opciones: OpcionesDeCampana;
}

export interface Contacto {
  id: string;
  campaignId: string;
  campaignName: string;
  patientName: string | null;
  patientPhone: string;
  status: "abierto" | "convertido" | "cerrado";
  closedReason: string | null;
  triggerKind: TipoDeFormato | "asistente";
  isNewContact: boolean;
  firstMessageAt: string;
  lastInboundAt: string;
  convertedAt: string | null;
  followUpCount: number;
  lastFollowUpAt: string | null;
}

export const ETIQUETA_ESTADO: Record<EstadoCampana, string> = {
  vigente: "Vigente",
  programada: "Programada",
  vencida: "Vencida",
  inactiva: "Desactivada",
};

export const MOTIVO_DE_CIERRE: Record<string, string> = {
  sin_respuesta: "No contestó",
  solicitud_del_paciente: "Pidió que no lo contacten",
  cerrado_por_la_clinica: "Lo cerró la clínica",
  campana_inactiva: "Se desactivó la campaña",
};

/** Qué es el contacto hoy, en una frase. */
export function estadoDelContacto(c: Pick<Contacto, "status" | "closedReason" | "followUpCount">): string {
  if (c.status === "convertido") return "Agendó";
  if (c.status === "cerrado") return `Cerrado: ${MOTIVO_DE_CIERRE[c.closedReason ?? ""] ?? "sin motivo"}`;
  return c.followUpCount > 0 ? `En seguimiento (${c.followUpCount} enviado${c.followUpCount === 1 ? "" : "s"})` : "Preguntó y no agendó";
}

export function porcentaje(parte: number, total: number): string {
  return total === 0 ? "—" : `${Math.round((parte / total) * 100)} %`;
}
