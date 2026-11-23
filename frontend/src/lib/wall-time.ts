/**
 * Un instante (ISO UTC) como fecha y hora de pared **de la clínica**.
 *
 * Nunca con `getHours()` ni `toISOString().slice(0, 10)`: el primero usa la
 * zona del navegador y el segundo el día UTC, que en México ya es el siguiente
 * desde las 18:00. Es lo que el backend espera de vuelta (`date` + `time`) al
 * mover o editar una cita.
 */
export function fechaYHoraEnZona(iso: string, timeZone: string): { date: string; time: string } {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const v = (type: string) => partes.find((p) => p.type === type)?.value ?? "00";
  // A medianoche en punto `hour` puede venir como "24" en algunos entornos.
  const hora = String(Number(v("hour")) % 24).padStart(2, "0");
  return { date: `${v("year")}-${v("month")}-${v("day")}`, time: `${hora}:${v("minute")}` };
}

/** Minutos entre dos instantes ISO. */
export function minutosEntre(inicioIso: string, finIso: string): number {
  return Math.round((new Date(finIso).getTime() - new Date(inicioIso).getTime()) / 60000);
}
