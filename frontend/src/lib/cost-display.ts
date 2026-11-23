/**
 * Cómo se muestra un costo cuando parte del consumo no tiene tarifa cargada.
 *
 * **Sin tarifa no es cero** (regla de la pantalla de Costos): el backend no suma lo que no tiene tarifa, así que el total de un
 * consumo SIN ninguna tarifa llega como 0, y mostrarlo como "US$ 0,00" hace creer que no cuesta nada (pasó el 2026-11-23: 127 llamadas
 * al modelo y 245.202 tokens figuraban en US$ 0,00 porque no había tarifas cargadas).
 *
 * - todo sin tarifa → "Sin tarifa";
 * - una parte sin tarifa → el costo conocido más cuántas faltan: "US$ 0,12 + 40 sin tarifa";
 * - nada sin tarifa (o sin consumo) → el costo normal.
 *
 * Vive aparte de la pantalla para poder probarlo con el runner del backend.
 */
export interface CostoMostrado {
  /** Lo que se escribe en la celda. */
  texto: string;
  /** Hay consumo sin tarifa: la pantalla lo resalta. */
  incompleto: boolean;
}

export function mostrarCosto(params: {
  /** Suma de lo que SÍ tiene tarifa, en USD. */
  costoUsd: number;
  /** Cuántos eventos hubo (llamadas, mensajes…). */
  total: number;
  /** Cuántos de esos no tenían tarifa. */
  sinTarifa: number;
  formatear: (n: number) => string;
}): CostoMostrado {
  const { costoUsd, total, sinTarifa, formatear } = params;
  if (total <= 0 || sinTarifa <= 0) return { texto: formatear(costoUsd), incompleto: false };
  if (sinTarifa >= total) return { texto: "Sin tarifa", incompleto: true };
  return { texto: `${formatear(costoUsd)} + ${sinTarifa.toLocaleString("es")} sin tarifa`, incompleto: true };
}
