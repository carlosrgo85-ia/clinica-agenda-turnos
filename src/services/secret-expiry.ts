import { addDaysToDateKey, clinicDateKey, dateKeyToUtcMidnight } from "./time";

/**
 * Reglas puras del recordatorio de vencimiento de un secreto.
 *
 * Todo trabaja con fechas de calendario ("YYYY-MM-DD") y no con instantes: el
 * secreto vence un DÍA, y comparar instantes haría depender el aviso de la
 * hora a la que corre el worker.
 */

/** Desde cuántos días antes se empieza a avisar, todos los días. */
export const REMINDER_WINDOW_DAYS = 7;

/** Cuánto a futuro se acepta una fecha: más que eso es casi seguro un typo y apagaría los avisos. */
export const MAX_YEARS_AHEAD = 3;

export type ExpiryState = "ok" | "por_vencer" | "vencido";

/**
 * Una fecha real "YYYY-MM-DD", o null. `new Date("2030-02-31")` no falla:
 * devuelve el 3 de marzo, y un vencimiento corrido en silencio es justo lo que
 * esto tiene que evitar. Por eso se compara contra la fecha reconstruida.
 */
export function parseExpiryDate(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const key = input.trim();
  const midnight = dateKeyToUtcMidnight(key);
  if (!midnight) return null;
  return clinicDateKey(midnight, "UTC") === key ? key : null;
}

/** Días de calendario entre dos fechas. Negativo = ya pasó. */
export function daysUntil(expiresOn: string, today: string): number | null {
  const a = dateKeyToUtcMidnight(expiresOn);
  const b = dateKeyToUtcMidnight(today);
  if (!a || !b) return null;
  return Math.round((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000));
}

/** ¿Está el vencimiento demasiado lejos para ser creíble? */
export function isTooFarAhead(expiresOn: string, today: string): boolean {
  const limit = addDaysToDateKey(today, MAX_YEARS_AHEAD * 366);
  return limit !== null && expiresOn > limit;
}

export function expiryState(days: number): ExpiryState {
  if (days < 0) return "vencido";
  if (days <= REMINDER_WINDOW_DAYS) return "por_vencer";
  return "ok";
}

/**
 * ¿Toca mandar el recordatorio hoy?
 *
 * Todos los días desde `REMINDER_WINDOW_DAYS` antes, UNA vez por día, y
 * **también después de vencido**: el aviso no se apaga solo cuando el secreto
 * deja de servir, sino cuando alguien registra la fecha del nuevo.
 */
export function shouldRemindToday(days: number, lastReminderOn: string | null, today: string): boolean {
  if (days > REMINDER_WINDOW_DAYS) return false;
  return lastReminderOn !== today;
}

/** "vence en 3 días", "vence mañana", "vence HOY", "venció hace 2 días". */
export function describeDays(days: number): string {
  if (days > 1) return `vence en ${days} días`;
  if (days === 1) return "vence mañana";
  if (days === 0) return "vence HOY";
  if (days === -1) return "venció ayer";
  return `venció hace ${-days} días`;
}
