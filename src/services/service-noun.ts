/**
 * `Clinic.serviceNoun`: la palabra con que el asistente nombra, ante el paciente,
 * lo que se agenda ("tratamiento", "servicio", "atención"…).
 *
 * Va DENTRO del prompt, así que se acota: una sola línea y corta. Lo escribe el
 * super-admin, pero un salto de línea o un texto largo convertiría el campo en
 * una forma de meter instrucciones al modelo.
 */
export const SERVICE_NOUN_MAX_LENGTH = 30;

export function isValidServiceNoun(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= SERVICE_NOUN_MAX_LENGTH &&
    !/[\r\n\t]/.test(value)
  );
}
