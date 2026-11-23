/**
 * El historial de cada persona del WhatsApp, para el asistente: qué se le hizo en
 * la clínica, su próxima cita sugerida y las notas internas del personal.
 *
 * Es lo que le permite, con una persona que ya vino, proponerle una nueva cita y
 * preguntarle cómo le fue con lo que le hicieron, en un tono cercano.
 *
 * **Todo esto se envía a la API del modelo** (decidido el 2026-11-13: el
 * asistente lee historial, observaciones y comentarios). Por eso se acota: las
 * últimas atenciones, los últimos comentarios y largos máximos, y solo de las
 * personas de ESTE número — nunca de otro paciente.
 */

export const SIN_HISTORIAL =
  "ninguna de estas personas tiene atenciones registradas ni notas: no hay nada que recordarles ni que preguntarles sobre un tratamiento";

export const MAX_TREATMENTS = 5;
export const MAX_COMMENTS = 5;
export const MAX_OBSERVATIONS_IN_PROMPT = 600;
export const MAX_COMMENT_IN_PROMPT = 300;

export interface PatientHistoryForPrompt {
  /** El nombre completo, tal como figura en "Personas de este WhatsApp". */
  nombre: string;
  /** Con el que se la trata. Puede venir vacío si la ficha no tiene nombre. */
  nombreDePila: string;
  /** Las atenciones cumplidas, de la más reciente a la más vieja. */
  tratamientos: Array<{ fecha: string; servicio: string; profesional: string }>;
  proximaCitaSugerida: { fecha: string; nota: string | null } | null;
  observaciones: string | null;
  /** De la más reciente a la más vieja. */
  comentarios: Array<{ fecha: string; texto: string }>;
}

const recortar = (texto: string, max: number): string => {
  const limpio = texto.replace(/\s+/g, " ").trim();
  return limpio.length > max ? `${limpio.slice(0, max)}…` : limpio;
};

function describirPersona(h: PatientHistoryForPrompt): string | null {
  const lineas: string[] = [];

  if (h.tratamientos.length > 0) {
    lineas.push(
      "    Lo que se le hizo (de lo más reciente a lo más viejo): " +
        h.tratamientos
          .slice(0, MAX_TREATMENTS)
          .map((t) => `${t.fecha} ${t.servicio} con ${t.profesional}`)
          .join("; ")
    );
  }
  if (h.proximaCitaSugerida) {
    const nota = h.proximaCitaSugerida.nota ? ` (${recortar(h.proximaCitaSugerida.nota, 120)})` : "";
    lineas.push(`    Próxima cita sugerida por el personal: ${h.proximaCitaSugerida.fecha}${nota}`);
  }
  if (h.observaciones) {
    lineas.push(
      `    Observaciones del personal: ${recortar(h.observaciones, MAX_OBSERVATIONS_IN_PROMPT)}`
    );
  }
  if (h.comentarios.length > 0) {
    lineas.push(
      "    Comentarios internos del personal (de lo más reciente a lo más viejo): " +
        h.comentarios
          .slice(0, MAX_COMMENTS)
          .map((c) => `[${c.fecha}] ${recortar(c.texto, MAX_COMMENT_IN_PROMPT)}`)
          .join(" | ")
    );
  }

  if (lineas.length === 0) return null;
  const nombre = h.nombre || "(quien escribe, nombre no registrado)";
  const pila = h.nombreDePila ? ` — se la trata por "${h.nombreDePila}"` : "";
  return `- ${nombre}${pila}:\n${lineas.join("\n")}`;
}

/** Función pura: el texto que lee el modelo. Sin nada que contar, `SIN_HISTORIAL`. */
export function describePatientHistories(histories: PatientHistoryForPrompt[]): string {
  const bloques = histories.map(describirPersona).filter((b): b is string => b !== null);
  return bloques.length > 0 ? bloques.join("\n") : SIN_HISTORIAL;
}
