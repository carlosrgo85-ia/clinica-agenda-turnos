/**
 * Un número de WhatsApp tal como lo dicta una persona ("+52 55 1234 5678", "(55) 1234-5678") a su forma de guardarlo: solo
 * dígitos, con el código de país. Devuelve null si no parece un número (menos de 8 o más de 15 dígitos, el máximo de E.164).
 * No adivina el código de país: si falta, el número se guarda como vino, y el asistente le pide a la persona que lo incluya.
 */
export function normalizeWhatsAppNumber(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}
