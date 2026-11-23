/** Mismo orden y valores que el enum `Weekday` de prisma/schema.prisma. */
export const WEEKDAYS = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  lunes: "Lunes",
  martes: "Martes",
  miercoles: "Miércoles",
  jueves: "Jueves",
  viernes: "Viernes",
  sabado: "Sábado",
  domingo: "Domingo",
};

/** "09:30" -> 570. Minutos desde la medianoche, igual que `startMinute`/`endMinute` en el backend. */
export function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

/** 570 -> "09:30". */
export function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60)
    .toString()
    .padStart(2, "0");
  const mins = (minutes % 60).toString().padStart(2, "0");
  return `${hours}:${mins}`;
}

export interface Tramo {
  weekday: string;
  startMinute: number;
  endMinute: number;
}

/**
 * "Lunes 09:00 a 13:00 y 14:00 a 18:00" por día, para mostrar un horario sin
 * editarlo. Espejo de `describeWorkingHours()` del backend, que es lo que lee
 * el prompt — si alguna vez se separan, lo que el bot dice deja de coincidir
 * con lo que muestra la pantalla.
 */
export function describirTramos(tramos: Tramo[]): Array<{ dia: string; horario: string }> {
  return WEEKDAYS.map((weekday) => {
    const delDia = tramos
      .filter((t) => t.weekday === weekday)
      .sort((a, b) => a.startMinute - b.startMinute)
      .map((t) => `${minutesToTime(t.startMinute)} a ${minutesToTime(t.endMinute)}`);
    if (delDia.length === 0) return null;
    return { dia: WEEKDAY_LABELS[weekday], horario: delDia.join(" y ") };
  }).filter((x): x is { dia: string; horario: string } => x !== null);
}
