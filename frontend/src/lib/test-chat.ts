/** Lo que devuelven `GET` y `POST .../test-chat`. */
export interface DecisionDelAsistente {
  intent: string;
  servicio: string | null;
  fecha: string | null;
  hora: string | null;
  profesional: string | null;
  pacienteDelTurno: string | null;
  pideHorarios: boolean;
  confirmo: boolean;
  derivar: boolean;
  motivoDerivar: string | null;
  pidioUbicacion: boolean;
  turnoAModificar: string | null;
  motivoCancelacion: string | null;
  esQueja: boolean;
  campanaMencionada: string | null;
}

export interface CitaDePrueba {
  id: string;
  /** La persona del turno; null si todavía no dio su nombre. */
  patient: string | null;
  service: string;
  professional: string;
  room: string;
  cuando: string;
  status: string;
}

export interface ConversacionDePrueba {
  mensajes: Array<{ role: "patient" | "assistant"; content: string; at: string }>;
  citas: CitaDePrueba[];
  campana: { id: string; name: string } | null;
}

export interface TurnoDePrueba {
  respuestas: string[];
  notas: string[];
  decisiones: DecisionDelAsistente[];
  citas: CitaDePrueba[];
}

/** Una línea del chat: lo que escribió quien prueba, lo que contestó el asistente, o lo que el turno hizo por detrás. */
export type Entrada =
  | { tipo: "paciente"; texto: string }
  | { tipo: "asistente"; texto: string }
  | { tipo: "nota"; texto: string }
  | { tipo: "decisiones"; decisiones: DecisionDelAsistente[] };

export const INTENTS: Record<string, string> = {
  agendar: "Agendar",
  cancelar: "Cancelar",
  reprogramar: "Reprogramar",
  consultar_horarios: "Consultar horarios",
  consultar_info: "Consultar información",
  confirmar: "Confirmar",
  otro: "Otro",
};

/** Las decisiones de un turno en frases cortas, solo lo que el asistente efectivamente marcó. */
export function resumirDecision(d: DecisionDelAsistente): string[] {
  const out = [`Intención: ${INTENTS[d.intent] ?? d.intent}`];
  if (d.servicio) out.push(`Servicio: ${d.servicio}`);
  if (d.fecha || d.hora) out.push(`Cuándo: ${[d.fecha, d.hora].filter(Boolean).join(" ")}`);
  if (d.profesional) out.push(`Profesional pedido: ${d.profesional}`);
  if (d.pacienteDelTurno) out.push(`Cita para: ${d.pacienteDelTurno}`);
  if (d.pideHorarios) out.push("Pidió consultar la agenda");
  if (d.confirmo) out.push("Confirmación explícita");
  if (d.turnoAModificar) out.push("Sobre una cita existente");
  if (d.pidioUbicacion) out.push("Pidió la ubicación");
  if (d.derivar) out.push(`Derivó a una persona${d.motivoDerivar ? ` (${d.motivoDerivar})` : ""}`);
  if (d.motivoCancelacion) out.push(`Motivo de cancelación: ${d.motivoCancelacion}`);
  if (d.esQueja) out.push("Es una queja");
  if (d.campanaMencionada) out.push(`Reconoció la promoción: ${d.campanaMencionada}`);
  return out;
}
