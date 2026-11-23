/**
 * De qué profesional habla el paciente ("con la Dra. Liliana") → el
 * profesional real de la clínica, o null.
 *
 * El modelo recibe la lista de profesionales y tiene que copiar el nombre tal
 * como figura (ver `system-prompt.ts`), pero igual no se confía en que lo haga
 * letra por letra: se compara sin acentos, sin mayúsculas y sin el tratamiento
 * ("Dra.", "Dr."), por palabras sueltas y no por texto exacto.
 *
 * **Si hay más de uno que encaja devuelve null, no el primero.** "Dra. López"
 * puede ser dos personas, y agendar con la equivocada es peor que no filtrar:
 * sin filtro se ofrecen los horarios de todos y el paciente elige.
 */

export interface MatchableProfessional {
  id: string;
  name: string;
  /** "Dr.", "Lic."… — null si la clínica no lo carga. */
  title: string | null;
}

/** Tratamientos que el paciente antepone al nombre y que no identifican a nadie. */
const TRATAMIENTOS = new Set(["dr", "dra", "dre", "doctor", "doctora", "lic", "licenciado", "licenciada"]);

function tokens(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9ñ]+/u)
    .filter(Boolean);
}

export function matchRequestedProfessional(
  requested: string | null | undefined,
  professionals: MatchableProfessional[]
): string | null {
  if (!requested) return null;

  const buscadas = tokens(requested).filter((t) => !TRATAMIENTOS.has(t));
  if (buscadas.length === 0) return null;

  const coinciden = professionals.filter((p) => {
    const suyas = new Set(tokens(`${p.title ?? ""} ${p.name}`));
    return buscadas.every((t) => suyas.has(t));
  });

  return coinciden.length === 1 ? coinciden[0].id : null;
}
