import { clinicDateKey, clinicWeekday, formatWallTime } from "../services/time";
import { describeProfessionalLabel } from "./professional-label";

/**
 * El bloque con las personas registradas en ese WhatsApp y sus turnos.
 *
 * Vive al lado del system prompt por el mismo motivo que
 * `availability-context.ts`: es presentación, no cálculo.
 *
 * Son **personas** y no "el paciente" porque un número suele ser de una
 * familia: el titular agenda para él, para su papá y para su hija. El modelo
 * necesita ver quién es quién para dos cosas — reusar la ficha que ya existe
 * en vez de crear una nueva por cada variante del nombre, y no ofrecerle a
 * uno el turno de otro.
 *
 * Sin este bloque el modelo solo sabía de los turnos por lo que quedara
 * escrito en el historial reciente, que son los últimos 10 mensajes: pasada
 * esa ventana no podía mencionar un turno, ni cancelarlo, ni evitar
 * ofrecerle otro a quien ya tenía uno.
 */

/** No se le informó al modelo: no sabe si hay turnos o no. */
export const TURNOS_SIN_INFORMAR = "ninguno informado";

/** Se consultó y no hay ninguno. Es distinto de no haber consultado. */
export const SIN_TURNOS = "ninguno";

export interface AppointmentForPrompt {
  id: string;
  startTime: Date;
  service: string;
  /** `title` es la relación al catálogo, no un string: puede no estar. */
  professional: { name: string; title: { name: string } | null };
}

export interface PersonForPrompt {
  id: string;
  name: string | null;
  /** El dueño del WhatsApp: a quien se le atribuye lo que no se aclara. */
  esTitular: boolean;
  appointments: AppointmentForPrompt[];
  /**
   * Esta PERSONA nunca tuvo una cita en la clínica (ni cancelada). Es por
   * persona y no por número: la hija de un paciente conocido es nueva, y la
   * regla del servicio de primera vez se le aplica a ella.
   */
  primeraVez?: boolean;
}

/**
 * La fecha va en ISO y con el nombre del día por el mismo motivo que en
 * `formatAvailableSlots`: el nombre es lo que el modelo usa para redactar
 * ("tu turno del lunes"), y el ISO es lo que tiene que copiar sin calcular.
 *
 * El `id` va primero porque es el dato que el modelo tiene que devolver en
 * `turno_a_modificar` para que se pueda cancelar o reprogramar.
 */
function describeAppointment(appointment: AppointmentForPrompt, timezone: string): string {
  const dateKey = clinicDateKey(appointment.startTime, timezone);
  const weekday = clinicWeekday(appointment.startTime, timezone);
  const time = formatWallTime(appointment.startTime, timezone);
  const profesional = describeProfessionalLabel(
    appointment.professional.name,
    appointment.professional.title?.name ?? null
  );
  return `    - id ${appointment.id}: ${dateKey} (${weekday}) a las ${time}, ${appointment.service}, con ${profesional}`;
}

export function describeAppointments(
  appointments: AppointmentForPrompt[],
  timezone: string
): string {
  if (appointments.length === 0) return SIN_TURNOS;
  return appointments.map((a) => describeAppointment(a, timezone)).join("\n");
}

/**
 * Las personas de un número con sus turnos.
 *
 * Al titular sin nombre se lo nombra por su rol y no con un placeholder
 * vacío: "(quien escribe, nombre no registrado)" le dice al modelo que
 * puede preguntarlo, mientras que una línea en blanco lo invita a inventarlo.
 */
export function describePeople(personas: PersonForPrompt[], timezone: string): string {
  if (personas.length === 0) return SIN_TURNOS;

  return personas
    .map((persona) => {
      const base = persona.name
        ? `${persona.name}${persona.esTitular ? " (quien escribe)" : ""}`
        : "(quien escribe, nombre no registrado)";
      const rotulo = persona.primeraVez ? `${base} [PRIMERA VEZ: nunca tuvo una cita]` : base;
      const turnos =
        persona.appointments.length === 0
          ? "    sin citas"
          : persona.appointments.map((a) => describeAppointment(a, timezone)).join("\n");
      return `- ${rotulo}:\n${turnos}`;
    })
    .join("\n");
}

export const SIN_CANCELACIONES_RECIENTES =
  "ninguna: no hay una cancelación reciente a la que ponerle motivo";

/**
 * Las cancelaciones recientes sin motivo, para que el modelo pueda asociar el motivo que el
 * paciente cuenta DESPUÉS de cancelar. Con el id, que es lo que tiene que devolver en
 * `turno_cancelado`: nunca lo escribe a ciegas.
 */
export function describeRecentCancellations(
  cancelaciones: Array<{ id: string; startTime: Date; service: string; professionalName: string }>,
  timezone: string
): string {
  if (cancelaciones.length === 0) return SIN_CANCELACIONES_RECIENTES;
  return cancelaciones
    .map((c) => {
      const dateKey = clinicDateKey(c.startTime, timezone);
      const hora = formatWallTime(c.startTime, timezone);
      return `    - id ${c.id}: la cita del ${dateKey} a las ${hora}, ${c.service}, con ${c.professionalName}`;
    })
    .join("\n");
}
