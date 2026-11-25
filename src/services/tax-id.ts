/**
 * Identificador fiscal de la clínica (RFC en México, CUIT en Argentina, RUT en Chile, NIT en
 * Colombia…). El formato varía por país, así que NO se valida acá; solo se normaliza lo que es
 * seguro para todos: quitar espacios de los extremos, colapsar los repetidos y pasar a mayúsculas.
 *
 * Por qué mayúsculas: el SAT trabaja el RFC en mayúsculas y una factura (CFDI) con el RFC en minúsculas
 * puede rechazarse. Para el resto de los países es inocuo: los identificadores son dígitos o letras que
 * ya se escriben en mayúscula (la K del RUT chileno, las letras del NIF español).
 *
 * Qué NO se toca: guiones, puntos y barras (`20-12345678-9`, `12.345.678-K`, `12.345.678/0001-90`) porque
 * así se escriben en otros países, ni se quitan espacios del medio de un identificador que los lleve.
 * Vacío = null (campo sin cargar).
 */
export function normalizeTaxId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const limpio = value.trim().replace(/\s+/g, " ").toLocaleUpperCase("es-MX");
  return limpio === "" ? null : limpio;
}
