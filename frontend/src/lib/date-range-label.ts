/**
 * El título del período que muestra la Agenda: "Sábado 21 de noviembre de 2026" (día) o "16 – 22 de noviembre de 2026" (semana).
 *
 * Sin dependencias a propósito, como `date-format.ts`: es la parte donde se esconden los errores (semana que cruza de mes o de
 * año) y así se prueba con el runner del backend. Trabaja con "YYYY-MM-DD" y no con `Date` local, para no correrse un día por la
 * zona horaria del navegador.
 */

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const DIAS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

function partes(iso: string): { y: number; m: number; d: number } | null {
  const r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return r ? { y: Number(r[1]), m: Number(r[2]), d: Number(r[3]) } : null;
}

/** "Sábado 21 de noviembre de 2026". Cualquier cosa rara devuelve "". */
export function tituloDeDia(iso: string): string {
  const p = partes(iso);
  if (!p) return "";
  const dia = DIAS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
  return `${dia} ${p.d} de ${MESES[p.m - 1]} de ${p.y}`;
}

/**
 * "16 – 22 de noviembre de 2026", "26 de octubre – 1 de noviembre de 2026" o "28 de diciembre de 2026 – 3 de enero de 2027":
 * no repite el mes ni el año cuando son los mismos.
 */
export function tituloDeRango(desdeIso: string, hastaIso: string): string {
  const a = partes(desdeIso);
  const b = partes(hastaIso);
  if (!a || !b) return "";
  if (a.y === b.y && a.m === b.m) return `${a.d} – ${b.d} de ${MESES[b.m - 1]} de ${b.y}`;
  if (a.y === b.y) return `${a.d} de ${MESES[a.m - 1]} – ${b.d} de ${MESES[b.m - 1]} de ${b.y}`;
  return `${a.d} de ${MESES[a.m - 1]} de ${a.y} – ${b.d} de ${MESES[b.m - 1]} de ${b.y}`;
}

/** "0 citas", "1 cita", "12 citas". */
export function etiquetaDeCitas(n: number): string {
  return `${n} ${n === 1 ? "cita" : "citas"}`;
}
