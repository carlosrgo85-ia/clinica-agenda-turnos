import { WEEKDAYS, type Weekday } from "./weekdays";

/**
 * Aritmética sobre "dateKeys" (`YYYY-MM-DD`), que son fechas puras: sin hora
 * y sin huso.
 *
 * Todo se hace en UTC a propósito. Usar `new Date(dateKey)` y métodos
 * locales corre la fecha un día para cualquier huso negativo —el mismo
 * problema que ya está documentado en `lib/format.ts` y en
 * `services/time.ts` del backend—, y acá eso serían citas apareciendo en el
 * día equivocado.
 */

/** Suma (o resta) días a un `YYYY-MM-DD`. */
export function addDaysToDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const fecha = new Date(Date.UTC(year, month - 1, day));
  fecha.setUTCDate(fecha.getUTCDate() + days);
  return fecha.toISOString().slice(0, 10);
}

/** El día de la semana de un `YYYY-MM-DD`, con el mismo vocabulario que el backend. */
export function weekdayDeDateKey(dateKey: string): Weekday {
  const [year, month, day] = dateKey.split("-").map(Number);
  const indice = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  // `getUTCDay()` arranca en domingo; WEEKDAYS arranca en lunes.
  return WEEKDAYS[(indice + 6) % 7];
}

/**
 * Hoy como `YYYY-MM-DD` en una zona dada (por default, la del navegador).
 *
 * Se arma con `Intl` y no con `toISOString()`: ese devuelve el día UTC, que
 * en México ya es el día siguiente desde las 18:00.
 */
export function hoyEnZona(timeZone?: string): string {
  const partes = new Intl.DateTimeFormat("en-CA", {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  // en-CA ya formatea como YYYY-MM-DD.
  return partes;
}
