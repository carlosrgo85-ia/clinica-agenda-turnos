/**
 * Las reglas que una persona puede saltarse al guardar una cita desde la
 * Agenda, en palabras para mostrar. El texto de cada violación lo trae el
 * backend; esto es para rotular lo que ya quedó guardado (`forcedRules`).
 */
export const REGLAS_FORZADAS: Record<string, string> = {
  fecha_en_el_pasado: "horario en el pasado",
  anticipacion_minima: "menos anticipación de la que pide la clínica",
  clinica_cerrada: "fuera del horario de la clínica",
  profesional_fuera_de_horario: "fuera del horario del profesional",
  profesional_ocupado: "profesional con otra cita (sobreturno)",
  profesional_bloqueado: "profesional con la agenda bloqueada",
  // Ya no se puede forzar (es obligatorio desde el 2026-11-21), pero las citas anteriores pueden traerla guardada.
  profesional_no_hace_servicio: "profesional sin ese servicio asignado",
  primera_vez_sin_diagnostico: "paciente de primera vez sin empezar por el diagnóstico",
  paquete_sin_sesiones: "paquete sin sesiones libres (cita de más)",
};

export interface Violacion {
  rule: string;
  message: string;
}

export interface AgendaOpciones {
  servicios: Array<{
    id: string;
    name: string;
    durationMinutes: number;
    firstVisit: boolean;
    /** Quiénes lo realizan. */
    professionalIds: string[];
  }>;
  profesionales: Array<{ id: string; name: string; title: string | null }>;
  espacios: Array<{ id: string; name: string }>;
}

export function nombreProfesional(p: { name: string; title: string | null }): string {
  return p.title ? `${p.title} ${p.name}` : p.name;
}
