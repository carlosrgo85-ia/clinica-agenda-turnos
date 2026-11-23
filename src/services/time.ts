/**
 * Conversión de "hora de pared" a instante UTC.
 *
 * Claude devuelve `fecha_solicitada` (YYYY-MM-DD) y `hora_solicitada`
 * (HH:MM), que es lo que dijo el paciente: "el martes a las 10". Eso son
 * las 10 en la zona de LA CLÍNICA, no en la del servidor. Como
 * `Appointment.startTime` es un instante absoluto, hay que convertir usando
 * `Clinic.timezone`.
 *
 * Sin esto, un servidor en UTC y una clínica en America/Mexico_City
 * guardarían el turno con 6 horas de corrimiento.
 *
 * Se resuelve con `Intl` en vez de agregar una dependencia de fechas: es lo
 * único que se necesita, y la zona ya viene como IANA en `Clinic.timezone`.
 */

/**
 * Cuánto hay que sumarle a un instante para obtener la hora de pared de esa
 * zona, en milisegundos.
 */
function timezoneOffsetMs(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = formatter.formatToParts(instant);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  // Intl puede devolver la hora 24 para la medianoche según el entorno.
  const hour = get("hour") % 24;

  const wallClockAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second")
  );

  return wallClockAsUtc - instant.getTime();
}

/**
 * Convierte una fecha y hora locales de la clínica al instante UTC
 * correspondiente. Devuelve null si el formato no es el esperado.
 *
 * El offset se aplica en dos pasadas porque el offset mismo depende del
 * instante: en un cambio de horario de verano, la primera estimación puede
 * caer del lado equivocado. La segunda pasada corrige usando el offset
 * vigente en el instante ya ajustado.
 */
export function clinicWallTimeToUtc(
  date: string,
  time: string,
  timeZone: string
): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!dateMatch || !timeMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59) return null;

  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute);

  const firstGuess = new Date(naiveUtc - timezoneOffsetMs(new Date(naiveUtc), timeZone));
  const secondOffset = timezoneOffsetMs(firstGuess, timeZone);
  const result = new Date(naiveUtc - secondOffset);

  if (Number.isNaN(result.getTime())) return null;

  // Se valida que el resultado realmente represente la hora pedida. Puede
  // no coincidir si la hora no existe en esa zona — la madrugada que se
  // saltea cuando arranca el horario de verano.
  if (formatWallTime(result, timeZone) !== `${pad(hour)}:${pad(minute)}`) return null;

  return result;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** La hora de pared (HH:MM) de un instante en una zona dada. */
export function formatWallTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(instant);
}

/** Suma minutos a un instante. */
export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}

/**
 * Minutos transcurridos desde la medianoche local de la clínica.
 * Es la unidad en la que se guardan los tramos de `WorkingHours`.
 */
export function clinicMinutesFromMidnight(instant: Date, timeZone: string): number {
  const [hour, minute] = formatWallTime(instant, timeZone).split(":").map(Number);
  return hour * 60 + minute;
}

const WEEKDAYS = [
  "domingo",
  "lunes",
  "martes",
  "miercoles",
  "jueves",
  "viernes",
  "sabado",
] as const;

export type WeekdayName = (typeof WEEKDAYS)[number];

/**
 * Día de la semana de un instante, en la zona de la clínica.
 *
 * Tiene que calcularse en la zona de la clínica y no en la del servidor: un
 * turno a las 02:00 UTC del martes es todavía lunes por la noche para una
 * clínica en UTC-6, y validarlo contra el horario del martes daría mal.
 */
export function clinicWeekday(instant: Date, timeZone: string): WeekdayName {
  // "short" en en-US devuelve Sun/Mon/...; se mapea por índice para no
  // depender del idioma del entorno.
  const short = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(
    instant
  );
  const index = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(short);
  // El índice no puede ser -1 con locale en-US, pero si lo fuera preferimos
  // un valor definido antes que undefined corriendo por el resto del código.
  return WEEKDAYS[index === -1 ? 0 : index];
}

/**
 * La fecha local de la clínica como "YYYY-MM-DD".
 *
 * Es la clave con la que se buscan las excepciones de horario. Tiene que
 * salir de la zona de la clínica y no del instante UTC: un turno a las
 * 02:00 UTC del 26 de diciembre es todavía el 25 para una clínica en
 * UTC-6, y ese día era feriado.
 */
export function clinicDateKey(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Convierte "YYYY-MM-DD" a la medianoche UTC de ese día.
 *
 * Las columnas `@db.Date` se guardan y se consultan SIEMPRE así, para que
 * la fecha no se corra según la zona del servidor. Devuelve `null` para un texto
 * que no es una fecha o para un día que no existe (`2030-02-31`).
 */
export function dateKeyToUtcMidnight(dateKey: string): Date | null {
  const key = dateKey.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const date = new Date(`${key}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  // `new Date("2030-02-31")` no falla: devuelve el 3 de marzo. Un día que no existe en su mes se
  // rechaza comprobando que la fecha vuelva a dar el mismo texto; si no, un feriado mal tipeado
  // cerraría otro día en silencio.
  return date.toISOString().slice(0, 10) === key ? date : null;
}

/**
 * Avanza (o retrocede, con `days` negativo) días de calendario sobre una
 * fecha local "YYYY-MM-DD".
 *
 * Opera sobre la medianoche UTC y no sobre un instante de la clínica a
 * propósito: en UTC no hay horario de verano, así que sumar 24hs siempre cae
 * en el día siguiente. Hacer esta misma cuenta sobre un instante local daría
 * mal el día del cambio de hora, que dura 23 o 25 horas.
 */
export function addDaysToDateKey(dateKey: string, days: number): string | null {
  const base = dateKeyToUtcMidnight(dateKey);
  if (!base || !Number.isInteger(days)) return null;
  return clinicDateKey(new Date(base.getTime() + days * 24 * 60 * 60_000), "UTC");
}

/**
 * Día de la semana de una fecha local, sin necesitar un instante.
 *
 * Coincide con `clinicWeekday(start, tz)` para cualquier `start` construido
 * con `clinicWallTimeToUtc(dateKey, ..., tz)`, que es lo que garantiza que la
 * enumeración de huecos y la validación de `checkWorkingHours` miren el mismo
 * día de la semana.
 */
export function weekdayFromDateKey(dateKey: string): WeekdayName | null {
  const midnight = dateKeyToUtcMidnight(dateKey);
  return midnight ? clinicWeekday(midnight, "UTC") : null;
}

/** "09:30" a partir de minutos desde medianoche. Para mensajes y reportes. */
export function minutesToWallTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${pad(hours)}:${pad(mins)}`;
}
