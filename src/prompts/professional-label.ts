/**
 * Cómo se nombra a un profesional en los mensajes que ve el paciente:
 * "Dra. Gómez" si cargó un título (`Professional.title`), o solo "Gómez" si
 * no. Compartido entre `availability-context.ts` y `appointments-context.ts`
 * para que las dos superficies (horarios ofrecidos, turnos existentes)
 * lo digan igual.
 */
export function describeProfessionalLabel(name: string, title: string | null): string {
  return title ? `${title} ${name}` : name;
}
