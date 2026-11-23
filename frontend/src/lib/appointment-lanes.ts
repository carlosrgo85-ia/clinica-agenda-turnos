/**
 * Reparte en carriles las citas que se pisan en una misma columna.
 *
 * Un profesional puede tener dos citas a la misma hora (un sobreturno que una
 * persona confirmó). La grilla posiciona cada cita en absoluto, así que sin
 * esto la segunda quedaba exactamente encima de la primera y no se veía.
 *
 * Las citas que se tocan —directa o encadenadamente— forman un grupo y se
 * reparten el ancho en partes iguales; las que no se pisan con nadie siguen
 * ocupando todo el ancho. Dos citas que solo se rozan (una termina cuando
 * empieza la otra) no se pisan.
 */

export interface TramoCita {
  id: string;
  inicio: number;
  fin: number;
}

export interface Carril {
  /** 0 = el primero de izquierda a derecha. */
  carril: number;
  /** Cuántos carriles tiene el grupo al que pertenece la cita. */
  carriles: number;
}

export function repartirEnCarriles(tramos: TramoCita[]): Map<string, Carril> {
  const orden = [...tramos].sort((a, b) => a.inicio - b.inicio || a.fin - b.fin || a.id.localeCompare(b.id));
  const resultado = new Map<string, Carril>();

  let grupo: Array<{ id: string; carril: number }> = [];
  let finDelGrupo = -Infinity;
  let finPorCarril: number[] = [];

  const cerrarGrupo = () => {
    for (const miembro of grupo) {
      resultado.set(miembro.id, { carril: miembro.carril, carriles: finPorCarril.length });
    }
    grupo = [];
    finPorCarril = [];
    finDelGrupo = -Infinity;
  };

  for (const tramo of orden) {
    if (grupo.length > 0 && tramo.inicio >= finDelGrupo) cerrarGrupo();

    // El primer carril que ya terminó; si ninguno, uno nuevo a la derecha.
    let carril = finPorCarril.findIndex((fin) => fin <= tramo.inicio);
    if (carril === -1) {
      carril = finPorCarril.length;
      finPorCarril.push(tramo.fin);
    } else {
      finPorCarril[carril] = tramo.fin;
    }
    grupo.push({ id: tramo.id, carril });
    finDelGrupo = Math.max(finDelGrupo, tramo.fin);
  }
  cerrarGrupo();

  return resultado;
}
