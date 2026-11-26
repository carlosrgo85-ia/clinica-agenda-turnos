/**
 * De qué profesional es un evento AJENO de un calendario compartido.
 *
 * En una agenda compartida todas las citas viven en un solo calendario (dos doctores pueden
 * atender a la misma hora y entonces hay dos eventos). Sin pistas, un evento ajeno bloquea a
 * TODOS (el criterio conservador). Con estas tres pistas se puede acotar al profesional correcto:
 *
 * - **Nombre en el título**: "Dra. Munguía – Juan Pérez".
 * - **Color** del evento: cada profesional tiene el suyo.
 * - **Invitado**: el correo del profesional está entre los asistentes.
 *
 * Reglas, que no son obvias:
 *
 * - **Las pistas se SUMAN** (unión): si el título nombra a A y el color es de B, el bloqueo es de
 *   los dos. Equivocarse hacia "de más" pierde un horario; hacia "de menos" agenda encima de algo.
 * - **Ninguna pista que coincida = de todos** (devuelve `[]` y quien llama aplica el bloqueo a todo
 *   el equipo), como siempre.
 * - **Del título solo cuentan las palabras que identifican a UNA persona.** "López" en un equipo con
 *   dos López no atribuye nada; "Munguía", si nadie más la tiene, sí. Los tratamientos ("Dra.") y las
 *   palabras de enlace ("de", "del") no identifican a nadie.
 * - **Los datos del evento viven solo en memoria**: se leen, se resuelven y se descartan. Lo que se
 *   guarda es el bloqueo de cada profesional afectado, sin título, sin color y sin invitados.
 */

export interface EventHints {
  /** Título del evento (en memoria nada más). */
  title?: string | null;
  /** Color del evento en Google (`colorId`, "1" a "11"); null si usa el del calendario. */
  colorId?: string | null;
  /** Correos de los invitados. */
  attendeeEmails?: string[];
}

export interface AttributableProfessional {
  id: string;
  name: string;
  contactEmail: string | null;
  calendarColorId: string | null;
}

/** Los colores de evento de Google Calendar (`Event.colorId`), con el nombre con que se los ve. */
export const GOOGLE_EVENT_COLORS: Array<{ id: string; label: string }> = [
  { id: "1", label: "Lavanda" },
  { id: "2", label: "Salvia" },
  { id: "3", label: "Uva" },
  { id: "4", label: "Flamenco" },
  { id: "5", label: "Banana" },
  { id: "6", label: "Mandarina" },
  { id: "7", label: "Pavo real" },
  { id: "8", label: "Grafito" },
  { id: "9", label: "Arándano" },
  { id: "10", label: "Albahaca" },
  { id: "11", label: "Tomate" },
];

export function isValidEventColorId(value: unknown): value is string {
  return typeof value === "string" && GOOGLE_EVENT_COLORS.some((c) => c.id === value);
}

/** Palabras que no identifican a nadie: tratamientos y enlaces. */
const SIN_VALOR = new Set([
  "dr", "dra", "dre", "doctor", "doctora", "lic", "licenciado", "licenciada",
  "de", "del", "la", "las", "los", "el", "y", "e", "con",
]);

function tokens(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9ñ]+/u)
    .filter(Boolean);
}

/** Palabras del nombre que sirven para reconocerlo: al menos 3 letras y que no sean un tratamiento. */
function nameTokens(name: string): Set<string> {
  return new Set(tokens(name).filter((t) => t.length >= 3 && !SIN_VALOR.has(t)));
}

/**
 * Ids de los profesionales a los que apuntan las pistas del evento. `[]` = ninguna pista coincidió
 * (o no hay pistas): el bloqueo es de todo el equipo.
 */
export function attributeBlockToProfessionals(
  hints: EventHints | undefined,
  professionals: AttributableProfessional[]
): string[] {
  if (!hints) return [];
  const matched = new Set<string>();

  // 1) Nombre en el título: solo palabras que tiene una única persona del equipo.
  if (hints.title) {
    const perProfessional = professionals.map((p) => ({ id: p.id, words: nameTokens(p.name) }));
    const owners = new Map<string, string[]>();
    for (const p of perProfessional) {
      for (const w of p.words) owners.set(w, [...(owners.get(w) ?? []), p.id]);
    }
    for (const word of new Set(tokens(hints.title))) {
      const ids = owners.get(word);
      if (ids?.length === 1) matched.add(ids[0]);
    }
  }

  // 2) Color del evento.
  if (hints.colorId) {
    for (const p of professionals) {
      if (p.calendarColorId && p.calendarColorId === hints.colorId) matched.add(p.id);
    }
  }

  // 3) Invitado.
  if (hints.attendeeEmails?.length) {
    const invited = new Set(hints.attendeeEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
    for (const p of professionals) {
      const email = p.contactEmail?.trim().toLowerCase();
      if (email && invited.has(email)) matched.add(p.id);
    }
  }

  return [...matched];
}
