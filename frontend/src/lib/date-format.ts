/**
 * Conversión entre la fecha que se muestra (DD/MM/AAAA) y la que viaja por
 * la API (`YYYY-MM-DD`).
 *
 * Vive aparte del componente `DateField` y sin ninguna dependencia a
 * propósito: es la parte donde se esconden los errores (fechas imposibles,
 * entradas a medias) y así se puede testear con el runner del backend, que
 * es el único que tiene el proyecto.
 */

/** "2026-09-15" → "15/09/2026". Cualquier cosa rara devuelve "". */
export function isoADisplay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/**
 * "15/09/2026" → "2026-09-15". Devuelve null si no es una fecha real.
 *
 * Valida que el día exista en ese mes en vez de solo mirar los rangos: sin
 * eso, un 31/02 se convertiría en "2026-02-31", y `new Date()` lo corre en
 * silencio al 3 de marzo — el mismo problema que ya está anotado para
 * `dateKeyToUtcMidnight()` en el backend.
 */
export function displayAIso(display: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(display);
  if (!m) return null;

  const [dia, mes, anio] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  if (
    fecha.getUTCFullYear() !== anio ||
    fecha.getUTCMonth() !== mes - 1 ||
    fecha.getUTCDate() !== dia
  ) {
    return null;
  }

  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Deja solo dígitos y va metiendo las barras mientras se escribe. */
export function enmascararFecha(texto: string): string {
  const digitos = texto.replace(/\D/g, "").slice(0, 8);
  const partes = [digitos.slice(0, 2), digitos.slice(2, 4), digitos.slice(4, 8)];
  return partes.filter((p) => p !== "").join("/");
}
