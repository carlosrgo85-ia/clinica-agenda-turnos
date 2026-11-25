/**
 * Código postal del domicilio fiscal de la clínica. Va aparte de `billingAddress` (texto libre) porque
 * el CFDI 4.0 exige el código postal del domicilio fiscal como dato propio, y mezclado con la dirección
 * no se puede validar ni usar.
 *
 * El formato varía por país: en México son 5 dígitos; en el resto solo se exige que tenga forma de
 * código postal (3 a 12 letras, dígitos, espacios o guiones: CEP brasileño, ZIP+4, CPA argentino).
 */
export function normalizePostalCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const limpio = value.trim().replace(/\s+/g, " ").toLocaleUpperCase("es-MX");
  return limpio === "" ? null : limpio;
}

/** null = válido. El texto del error sale tal cual para el super-admin. */
export function postalCodeError(value: unknown, country: string | null | undefined): string | null {
  const cp = normalizePostalCode(value);
  if (cp === null) return null;
  if (country?.toUpperCase() === "MX") {
    return /^\d{5}$/.test(cp) ? null : "El código postal de México tiene 5 dígitos (ej. 06700).";
  }
  return /^[A-Z0-9][A-Z0-9 -]{1,10}[A-Z0-9]$/.test(cp)
    ? null
    : "El código postal tiene que tener entre 3 y 12 caracteres: letras, números, espacios o guiones.";
}
