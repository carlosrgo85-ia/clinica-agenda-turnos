/**
 * Heurística de zona horaria → país, para sugerir un valor al dar de alta
 * una clínica. El catálogo de feriados en sí (qué países existen, qué
 * reglas tiene cada uno) ya NO vive acá — se mudó a las tablas `Country` /
 * `HolidayRule` (ver `repositories/countries.repository.ts`), editable
 * desde la pantalla de plataforma "Países". Antes de esa migración, este
 * archivo tenía `HOLIDAYS_BY_COUNTRY` hardcodeado con AR y MX — esos
 * mismos datos ahora son el seed inicial en `prisma/seed.ts`.
 */

/**
 * Propone un país a partir de la zona horaria, solo como ayuda al dar de
 * alta una clínica. No se usa para decidir nada en runtime: `Clinic.country`
 * es explícito porque la inferencia no alcanza (un país puede tener varias
 * zonas, y una zona puede abarcar varios países).
 */
export function suggestCountryFromTimezone(timezone: string): string | null {
  const mapa: Record<string, string> = {
    "America/Argentina": "AR",
    "America/Mexico_City": "MX",
    "America/Cancun": "MX",
    "America/Monterrey": "MX",
    "America/Tijuana": "MX",
  };

  for (const [prefijo, country] of Object.entries(mapa)) {
    if (timezone === prefijo || timezone.startsWith(`${prefijo}/`)) return country;
  }
  return null;
}
