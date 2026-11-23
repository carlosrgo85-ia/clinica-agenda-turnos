/**
 * La línea de seguros que lee el prompt.
 *
 * El agente contesta **un solo hecho**: con qué obras sociales o prepagas
 * trabaja la clínica. Lo que cada plan cubre NO se informa nunca, y no es una
 * limitación de este archivo sino del problema: la cobertura depende del plan
 * del paciente y no de la aseguradora (OSDE 210 y OSDE 450 no cubren lo
 * mismo), así que cualquier dato cargado a nivel clínica sería falso para
 * alguien. Y equivocarse acá significa que el paciente llega y tiene que
 * pagar algo que le dijimos que estaba cubierto.
 */

/**
 * Lo que se le dice al modelo cuando la clínica no cargó ningún seguro.
 *
 * Es deliberadamente ambiguo, porque el dato es ambiguo: una lista vacía
 * puede significar "no trabajamos con seguros" o "todavía no lo cargamos", y
 * no hay forma de distinguirlas. Afirmar que no trabajan con ninguno le haría
 * perder un paciente que sí tenía cobertura; inventar que sí, un paciente que
 * llega y tiene que pagar. Mismo criterio que `SIN_HORARIO`.
 */
export const SIN_SEGUROS = "no está cargado — no afirmes ni niegues ninguno";

export function describeInsurers(nombres: string[]): string {
  return nombres.length > 0 ? nombres.join(", ") : SIN_SEGUROS;
}
