import { clinicDateKey, clinicMinutesFromMidnight } from "./time";

/**
 * Los límites verticales de la grilla de la Agenda (de qué hora a qué hora se dibuja).
 *
 * Salen del horario de la clínica: una agenda que arranca a las 00:00 son doce pantallas de nada antes de la primera cita. Pero **una
 * cita (o un bloqueo) fuera de ese horario tiene que verse igual**: la Agenda deja guardar una cita "fuera del horario" confirmando
 * (regla blanda), y si la grilla se queda en el horario de la clínica, esa cita se guarda y NO se ve (pasó el 2026-11-23: se
 * agendó una cita a una hora en que la clínica no atiende, se confirmó el aviso y no aparecía en la agenda). Por eso los límites se
 * estiran para abarcar lo que haya en el rango, redondeando a la hora.
 *
 * Los bloqueos de día completo no estiran nada (cubren todo el día de todos modos). Un evento que cruza la medianoche se corta en
 * las 24:00 de su día.
 */
export function gridLimits(params: {
  /** El horario de la clínica (tramos en minutos desde la medianoche). Vacío = jornada por defecto. */
  workingHours: Array<{ startMinute: number; endMinute: number }>;
  timezone: string;
  /** Citas y bloqueos con hora (los de día completo se omiten antes de llamar). */
  events: Array<{ startTime: Date; endTime: Date }>;
}): { desdeMinuto: number; hastaMinuto: number } {
  const { workingHours, timezone, events } = params;
  let desde = workingHours.length > 0 ? Math.min(...workingHours.map((w) => w.startMinute)) : 8 * 60;
  let hasta = workingHours.length > 0 ? Math.max(...workingHours.map((w) => w.endMinute)) : 20 * 60;

  for (const e of events) {
    const inicio = clinicMinutesFromMidnight(e.startTime, timezone);
    const mismoDia = clinicDateKey(e.startTime, timezone) === clinicDateKey(e.endTime, timezone);
    const fin = mismoDia ? clinicMinutesFromMidnight(e.endTime, timezone) : 24 * 60;
    desde = Math.min(desde, Math.floor(inicio / 60) * 60);
    hasta = Math.max(hasta, Math.ceil(Math.max(fin, inicio + 1) / 60) * 60);
  }
  return { desdeMinuto: Math.max(0, desde), hastaMinuto: Math.min(24 * 60, hasta) };
}
