/** Cuándo atiende una columna de la Agenda, para pintar el resto. */
export interface Disponibilidad {
  tramos: Array<{ startMinute: number; endMinute: number }>;
  cerrado: boolean;
  /** El texto de la excepción por fecha ("Día de la Independencia"), si la hay. */
  motivo: string | null;
}

/**
 * Las franjas en las que NO se atiende, dentro de los límites de la grilla.
 *
 * Es el complemento de los tramos de atención: el hueco del mediodía, lo de
 * antes de abrir y lo de después de cerrar. Un día entero sin tramos —un
 * feriado, o un día que la clínica no trabaja— devuelve una sola banda que
 * cubre toda la columna.
 *
 * Sin `disponibilidad` no se pinta nada: es mejor una grilla neutra que una
 * que diga "cerrado" porque el dato no llegó.
 *
 * Vive acá y no dentro del componente para poder testearla con el runner del
 * backend, que es el único que tiene el proyecto.
 */
export function bandasCerradas(
  disponibilidad: Disponibilidad | undefined,
  desdeMinuto: number,
  hastaMinuto: number
): Array<{ startMinute: number; endMinute: number }> {
  if (!disponibilidad) return [];
  if (disponibilidad.cerrado) return [{ startMinute: desdeMinuto, endMinute: hastaMinuto }];

  const abiertos = [...disponibilidad.tramos].sort((a, b) => a.startMinute - b.startMinute);
  const bandas: Array<{ startMinute: number; endMinute: number }> = [];
  let cursor = desdeMinuto;

  for (const tramo of abiertos) {
    if (tramo.startMinute > cursor) {
      bandas.push({ startMinute: cursor, endMinute: Math.min(tramo.startMinute, hastaMinuto) });
    }
    cursor = Math.max(cursor, tramo.endMinute);
  }
  if (cursor < hastaMinuto) bandas.push({ startMinute: cursor, endMinute: hastaMinuto });

  return bandas.filter((b) => b.endMinute > b.startMinute);
}

/**
 * La disponibilidad de varios profesionales juntos (la Agenda en "Todos"): **atiende quien tenga algún tramo**, así que los
 * tramos son la UNIÓN de los de cada uno y el día está cerrado solo si TODOS están cerrados. Un feriado de la clínica cierra a todos
 * y se pinta; la vacación de uno solo no pinta nada, porque los demás siguen atendiendo.
 *
 * `motivo` es el primero que haya (el de la excepción de la clínica es el mismo para todos). Sin ninguna disponibilidad devuelve
 * `undefined` (grilla neutra, como siempre que falta el dato).
 */
export function unirDisponibilidades(lista: Disponibilidad[]): Disponibilidad | undefined {
  if (lista.length === 0) return undefined;
  const ordenados = lista
    .flatMap((d) => d.tramos)
    .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
  const tramos: Array<{ startMinute: number; endMinute: number }> = [];
  for (const t of ordenados) {
    const ultimo = tramos[tramos.length - 1];
    if (ultimo && t.startMinute <= ultimo.endMinute) ultimo.endMinute = Math.max(ultimo.endMinute, t.endMinute);
    else tramos.push({ ...t });
  }
  return {
    tramos,
    cerrado: tramos.length === 0,
    motivo: lista.find((d) => d.motivo)?.motivo ?? null,
  };
}
