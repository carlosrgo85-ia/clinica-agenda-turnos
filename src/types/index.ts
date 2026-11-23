export type Intent =
  | "agendar"
  | "cancelar"
  | "reprogramar"
  | "consultar_horarios"
  | "consultar_info"
  | "confirmar"
  | "otro";

export type MotivoEscalar = "urgencia" | "consulta_clinica" | "otro" | null;

/** Salida estructurada que devuelve Claude por cada mensaje interpretado. */
export interface ClaudeAgentResponse {
  intent: Intent;
  servicio: string | null;
  fecha_solicitada: string | null; // YYYY-MM-DD
  hora_solicitada: string | null; // HH:MM
  /** Cómo se llama QUIEN ESCRIBE, si lo dijo. */
  nombre_paciente: string | null;
  /**
   * El apellido de QUIEN ESCRIBE, por separado. Es lo que garantiza que el nombre y el apellido
   * queden cada uno en su campo: partir un texto suelto es una heurística que se equivoca con
   * nombres compuestos ("Petra María Romero" → apellido "María Romero"). Opcional: si falta, la
   * ficha queda con el nombre completo y se parte al leer.
   */
  apellido_paciente?: string | null;
  /**
   * `true` cuando QUIEN ESCRIBE corrige el nombre o el apellido con que figura ("me anotó mal, es María"). Con él, el
   * código reemplaza el nombre de su ficha por `nombre_paciente` / `apellido_paciente`; sin él, un nombre ya cargado nunca
   * se pisa (ver `agent-turn.ts`). Opcional: que falte significa `false`.
   */
  corrige_nombre?: boolean;
  /**
   * A nombre de QUIÉN es el turno, si no es para quien escribe. Un mismo
   * WhatsApp suele ser de una familia; sin esto, el turno de la hija queda
   * a nombre del padre (pasó el 2026-09-14).
   */
  paciente_del_turno: string | null;
  /** El apellido de `paciente_del_turno`, por la misma razón que `apellido_paciente`. */
  apellido_paciente_del_turno?: string | null;
  /**
   * La promoción vigente de la clínica a la que se refiere la persona ("vengo por la promo de implantes"), con el nombre
   * EXACTO de la lista "Promociones vigentes de la clínica", o null. Es lo que reconoce una campaña cuando el mensaje no
   * trae ninguno de sus formatos: el código la resuelve a una campaña vigente (nunca confía en un nombre que no figure).
   */
  campana_mencionada?: string | null;
  turno_a_modificar: string | null; // id de Appointment, si aplica
  /**
   * El profesional que pidió el paciente, copiado de la lista de
   * profesionales de la clínica, o null si no pidió ninguno. El código lo
   * resuelve a un id (`services/professional-match.ts`) y recién ahí filtra
   * los horarios y agenda con esa persona.
   */
  profesional_solicitado: string | null;
  requiere_horarios_disponibles: boolean;
  confirmacion_explicita: boolean;
  /**
   * El/la paciente preguntó dónde queda. El código le adjunta la dirección y
   * el link de Maps exactos (`services/location.ts`) en un mensaje aparte,
   * en vez de que el modelo reescriba la URL.
   */
  pidio_ubicacion: boolean;
  /**
   * Solo al agendar para OTRA persona nueva: el WhatsApp con el que se registra a esa persona (sus avisos van ahí), si no es
   * el de quien escribe. Null = el mismo número. El código lo valida y solo lo aplica a una ficha sin citas.
   */
  telefono_registro?: string | null;
  /** Un WhatsApp adicional autorizado a consultar las citas de esa persona, o null. */
  telefono_autorizado?: string | null;
  escalar_a_humano: boolean;
  motivo_escalar: MotivoEscalar;
  /**
   * Por qué cancela (o canceló), en pocas palabras, si lo dijo. Se guarda en la cita y
   * en su evento: es lo que alimenta el reporte de motivos de cancelación y la calidad
   * de la clínica. Null si no lo dijo.
   */
  motivo_cancelacion: string | null;
  /**
   * El motivo es una queja o una molestia con la clínica (la atención, la espera, el
   * trato, el precio, el tratamiento, un profesional). Se registra aparte y se deriva
   * a una persona: es información de calidad que la clínica tiene que ver.
   */
  motivo_es_queja: boolean;
  /**
   * El id de una cita de "Citas canceladas recientemente" a la que se refiere el motivo,
   * cuando lo dio en un mensaje POSTERIOR a la cancelación. No cancela nada: solo le
   * pone el motivo a una cancelación que ya ocurrió.
   */
  turno_cancelado: string | null;
  respuesta_al_paciente: string;
}

/**
 * El modelo de datos de profesionales, espacios, equipos, pacientes y
 * turnos vive en prisma/schema.prisma — se importan como tipos de
 * @prisma/client (Professional, Room, Resource, Service, Package, Patient,
 * Appointment, CalendarBlock, PatientStage) en vez de redefinirlos acá,
 * para no duplicar la fuente de verdad.
 */

/**
 * Una fila de turno tal como la muestra el reporte diario. Es una vista
 * armada en jobs/daily-report.ts a partir del Appointment de Postgres, no
 * un modelo de la base: el reporte necesita los nombres ya resueltos
 * (paciente, profesional, espacio) y nada más.
 */
export interface DailyReportAppointment {
  appointmentId: string;
  startTime: Date;
  endTime: Date;
  patientName: string;
  service: string;
  professionalName: string;
  roomName: string | null;
}

/**
 * Un rato ocupado en la agenda de un profesional que NO es un turno de la
 * clínica. Aparece en el reporte solo como "tiempo bloqueado", sin título
 * ni detalle: es tiempo personal del profesional y la plataforma no guarda
 * de qué se trata (ver el comentario de CalendarBlock en el schema).
 */
export interface DailyReportBlock {
  startTime: Date;
  endTime: Date;
  isAllDay: boolean;
  professionalName: string;
}
