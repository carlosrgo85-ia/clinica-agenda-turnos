import type { AvailableSlotsResult, DaySlots } from "../services/availability-slots";
import { describeProfessionalLabel } from "./professional-label";

/**
 * El bloque de texto con los horarios libres que se le pasa a Claude.
 *
 * Vive al lado del system prompt y no en `availability-slots.ts` porque es
 * presentación: qué mostrar y cuánto recortar depende del presupuesto de
 * tokens del prompt, no del cálculo. El cálculo devuelve todo, barato y
 * completo, y acá se decide qué entra.
 */

/** Todavía no se consultó la agenda para este mensaje. */
export const SIN_CONSULTAR = "no consultados todavía";

/**
 * Se consultó y no hay nada. Es distinto de no haber podido consultar: una
 * agenda llena y una clínica sin horario cargado llevan a mensajes distintos.
 */
export function sinHorarios(dias: number): string {
  return `sin horarios disponibles en los próximos ${dias} días`;
}

/**
 * El servicio no lo ofrece la clínica, o nadie lo realiza. Distinto de "no se
 * pudo consultar": acá la agenda ni se miró, porque no hay nada que ofrecer, y
 * el código ya dejó el caso en manos de una persona de la clínica.
 */
export const SERVICIO_NO_OFRECIDO =
  "no se consultó la agenda: el servicio que pidió no figura entre los que ofrece la clínica";
export const SERVICIO_SIN_PROFESIONAL =
  "no se consultó la agenda: por ahora ningún profesional de la clínica tiene asignado ese servicio";

/** No se pudo consultar (falló el cálculo, o la clínica no cargó su horario). */
export const NO_SE_PUDO_CONSULTAR = "no se pudo consultar la agenda en este momento";

interface FormatOptions {
  /** Días con horarios a mostrar. */
  maxDias?: number;
}

/**
 * Con quién se puede en ese horario. Si hay varios libres se nombran todos: el
 * paciente puede preferir a uno, y mostrar solo al primero hacía creer que los
 * otros no tenían lugar.
 */
function describeCandidates(slot: DaySlots["slots"][number]): string {
  const candidatos = slot.candidateProfessionals?.length
    ? slot.candidateProfessionals
    : [{ name: slot.professionalName, title: slot.professionalTitle }];
  return candidatos.map((c) => describeProfessionalLabel(c.name, c.title)).join(" o ");
}

function describeDay(day: DaySlots): string {
  if (day.slots.length === 0) {
    // El motivo es información útil: le permite al bot decir "el miércoles es
    // feriado, ¿te sirve el jueves?" en vez de omitir el día sin explicación.
    if (day.exceptionReason) return `${day.dateKey} (${day.weekday}): cerrado (${day.exceptionReason})`;
    if (day.reason === "clinica_cerrada") return `${day.dateKey} (${day.weekday}): cerrado`;
    return `${day.dateKey} (${day.weekday}): sin horarios libres`;
  }

  // Se listan TODOS los horarios del día, agrupados por con quién se puede:
  // "11:00, 11:15, 12:00 con Dra. Gómez; 14:00 con Dr. Ruiz". Antes se
  // recortaba a 4 por día, y cuando el paciente preguntaba "¿y a las 12?" el
  // modelo, que no veía las 12:00 en la lista, contestaba que no había lugar
  // aunque estuviera libre (2026-11-05). Una lista parcial hace que "no figura"
  // se lea como "no hay"; la completa deja contestar eso con certeza. Cuántas
  // opciones se le ofrecen al paciente lo limita el prompt, no este texto.
  const grupos = new Map<string, string[]>();
  for (const slot of day.slots) {
    const quienes = describeCandidates(slot);
    const horas = grupos.get(quienes) ?? [];
    horas.push(slot.time);
    grupos.set(quienes, horas);
  }
  const horarios = [...grupos.entries()]
    .map(([quienes, horas]) => `${horas.join(", ")} con ${quienes}`)
    .join("; ");
  return `${day.dateKey} (${day.weekday}): ${horarios}`;
}

/**
 * La fecha va en ISO **y** con el nombre del día a propósito: el nombre es lo
 * que el modelo usa para redactar ("el martes 18"), y la fecha ISO es la que
 * tiene que copiar textual a `fecha_solicitada`. Teniendo las dos juntas el
 * modelo copia en vez de calcular, que es donde se equivoca.
 */
export function formatAvailableSlots(
  result: AvailableSlotsResult,
  options?: FormatOptions
): string {
  if (result.blocker === "servicio_no_ofrecido") return SERVICIO_NO_OFRECIDO;
  if (result.blocker === "servicio_sin_profesional") return SERVICIO_SIN_PROFESIONAL;
  if (result.blocker) return NO_SE_PUDO_CONSULTAR;

  // El paciente pidió a alguien que no hace este servicio. Va como primera
  // línea, antes de los horarios, que son de quienes sí lo hacen.
  const aviso = result.requestedProfessionalNotAvailable
    ? `AVISO: ${result.requestedProfessionalNotAvailable} no realiza este servicio. Los horarios de abajo son con ${
        (result.professionalsForService ?? [])
          .map((p) => describeProfessionalLabel(p.name, p.title))
          .join(" o ") || "otros profesionales"
      }, que sí lo realizan.\n`
    : "";

  if (result.totalSlots === 0) {
    return (
      aviso +
      (result.days.length === 0 ? NO_SE_PUDO_CONSULTAR : sinHorarios(result.days.length))
    );
  }

  const maxDias = options?.maxDias ?? 4;

  const conHorarios = result.days.filter((d) => d.slots.length > 0);
  const mostrados = conHorarios.slice(0, maxDias);

  // Los días cerrados se cuelan solo si caen entre los que sí tienen
  // horarios: explican un bache, pero una lista de días cerrados al final no
  // le sirve a nadie.
  const desde = result.days.indexOf(mostrados[0]);
  const hasta = result.days.indexOf(mostrados[mostrados.length - 1]);
  const lineas = result.days.slice(desde, hasta + 1).map((d) => describeDay(d));

  // Los días mostrados están completos; lo único que se recorta son días
  // posteriores, y el modelo tiene que saber que hay más para no decir que
  // no hay nada más adelante.
  if (conHorarios.length > mostrados.length) {
    lineas.push("(hay más días disponibles después de estos)");
  }

  return aviso + lineas.join("\n");
}
