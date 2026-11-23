import type { Weekday } from "@prisma/client";

/**
 * Convierte el horario que publica Google a tramos de `WorkingHours`.
 *
 * Se usa `regularOpeningHours.periods` y no `weekdayDescriptions`: los
 * periods vienen estructurados (día + hora + minuto), así que no hay que
 * parsear "Monday: 10:00 AM – 7:00 PM" en un idioma que además cambia según
 * el locale de la consulta.
 *
 * Es una SUGERENCIA para prellenar el formulario, igual que los feriados:
 * nunca escribe el horario de una clínica por su cuenta.
 */

/** `open`/`close` de un period de Places API (New). `day`: 0 = domingo. */
export interface GooglePeriodPoint {
  day?: number;
  hour?: number;
  minute?: number;
}

export interface GooglePeriod {
  open?: GooglePeriodPoint;
  close?: GooglePeriodPoint;
}

export interface TramoSugerido {
  weekday: Weekday;
  startMinute: number;
  endMinute: number;
}

/** Google numera desde el domingo; nuestro enum arranca en lunes. */
const DIAS: Weekday[] = [
  "domingo",
  "lunes",
  "martes",
  "miercoles",
  "jueves",
  "viernes",
  "sabado",
];

/** El orden en que se leen los días acá, que no es el de Google. */
const ORDEN_SEMANA: Weekday[] = [
  "lunes",
  "martes",
  "miercoles",
  "jueves",
  "viernes",
  "sabado",
  "domingo",
];

function aMinutos(punto: GooglePeriodPoint): number | null {
  const { hour, minute } = punto;
  if (typeof hour !== "number" || hour < 0 || hour > 23) return null;
  const min = typeof minute === "number" ? minute : 0;
  if (min < 0 || min > 59) return null;
  return hour * 60 + min;
}

export function periodsATramos(periods: GooglePeriod[] | undefined): TramoSugerido[] {
  if (!periods) return [];

  const tramos: TramoSugerido[] = [];

  for (const period of periods) {
    const { open, close } = period;
    if (!open || !close) continue; // Abierto 24hs: Google omite el `close`.

    // Un tramo que cruza la medianoche (abre el lunes, cierra el martes) no
    // se puede representar en un horario semanal por día, y partirlo en dos
    // inventaría un horario que el negocio no declaró. Se omite.
    if (open.day !== close.day) continue;

    const weekday = typeof open.day === "number" ? DIAS[open.day] : undefined;
    if (!weekday) continue;

    const startMinute = aMinutos(open);
    const endMinute = aMinutos(close);
    if (startMinute === null || endMinute === null) continue;
    if (endMinute <= startMinute) continue;

    tramos.push({ weekday, startMinute, endMinute });
  }

  // Ordenados como se leen en el editor de horarios: de lunes a domingo (no
  // en el orden de Google, que arranca en domingo) y por hora dentro del
  // día. El corte del mediodía sale solo — Google ya lo devuelve como dos
  // periods del mismo día, que es exactamente cómo lo modela `WorkingHours`.
  return tramos.sort(
    (a, b) =>
      ORDEN_SEMANA.indexOf(a.weekday) - ORDEN_SEMANA.indexOf(b.weekday) ||
      a.startMinute - b.startMinute
  );
}
