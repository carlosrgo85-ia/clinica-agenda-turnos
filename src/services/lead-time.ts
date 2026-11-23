/**
 * Anticipación mínima para reservar (`Clinic.minLeadMinutes`).
 *
 * Una sola función para los tres caminos que deciden un horario: ofrecerlo
 * (`availability-slots.ts`), agendarlo (`booking.ts`) y la Agenda editable
 * (`appointment-admin.ts`). Si cada uno hiciera la cuenta por su cuenta, tarde
 * o temprano uno ofrecería un horario que otro rechaza.
 */

/** El máximo que acepta la base (CHECK de la migración) y la API: una semana. */
export const MAX_LEAD_MINUTES = 7 * 24 * 60;

/**
 * ¿El inicio cae dentro del margen mínimo?
 *
 * Es sobre el **instante** de inicio, no sobre la hora de pared: "dentro de 2
 * horas" son 2 horas transcurridas aunque en el medio cambie el huso. Un
 * margen de 0 nunca se viola (lo del pasado lo decide quien llama, aparte).
 */
export function violatesLeadTime(start: Date, now: Date, minLeadMinutes: number): boolean {
  if (minLeadMinutes <= 0) return false;
  return start.getTime() < now.getTime() + minLeadMinutes * 60_000;
}

/** "30 minutos", "2 horas", "1 día": para explicárselo al paciente o a la asistente. */
export function describeLeadTime(minutes: number): string {
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return d === 1 ? "1 día" : `${d} días`;
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1 ? "1 hora" : `${h} horas`;
  }
  return `${minutes} minutos`;
}

/** ¿Es un valor válido para guardar? Entero entre 0 y una semana. */
export function isValidLeadMinutes(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_LEAD_MINUTES;
}
