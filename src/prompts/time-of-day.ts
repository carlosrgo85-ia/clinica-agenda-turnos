/**
 * En qué momento del día está escribiendo el paciente, para que el saludo y la
 * despedida le queden bien: un "que tengas un excelente día" a las 21:00 suena
 * a que el asistente no sabe qué hora es (pasó el 2026-11-05).
 *
 * Se calcula en CÓDIGO y con la zona horaria de la clínica, y el modelo solo lo
 * lee: darle la hora cruda y esperar que decida el umbral es dejarlo a su
 * criterio, y el servidor corre en UTC. Va en el mensaje de cada turno y no en
 * el system prompt, que se cachea y no puede cambiar de un mensaje a otro.
 */

export type MomentoDelDia = "mañana" | "tarde" | "noche";

/**
 * Mañana de 05:00 a 11:59, tarde de 12:00 a 19:59, noche el resto (20:00 a
 * 04:59). Los cortes son los de uso corriente en español de América: "buenas
 * tardes" desde el mediodía y "buenas noches" cuando ya oscureció.
 */
export function momentoDelDia(minutosDesdeMedianoche: number): MomentoDelDia {
  const m = ((minutosDesdeMedianoche % 1440) + 1440) % 1440;
  if (m >= 5 * 60 && m < 12 * 60) return "mañana";
  if (m >= 12 * 60 && m < 20 * 60) return "tarde";
  return "noche";
}
