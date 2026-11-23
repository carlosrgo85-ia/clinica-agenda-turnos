import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { checkWorkingHours } from "./working-hours";

/**
 * Toda la disponibilidad se calcula contra Postgres, nunca contra Google
 * Calendar (ver CLAUDE.md).
 *
 * Cada función acepta un cliente de Prisma opcional para poder correr
 * dentro de una transacción. Importa: el chequeo y la creación del turno
 * tienen que pasar en la MISMA transacción serializable, o dos mensajes
 * simultáneos del mismo paciente pueden pasar los dos el chequeo y
 * duplicar el turno (ver services/booking.ts).
 */
type Db = Prisma.TransactionClient | typeof prisma;

/**
 * "Primera vez" = el paciente no tiene NINGÚN turno registrado todavía en
 * esta clínica, ni siquiera cancelado.
 *
 * Recibe `clinicId` para poder usar el índice `[clinicId, patientId]` de
 * `Appointment` — sin él, Postgres no tiene forma de acotar el conteo y
 * escanea la tabla entera de todas las clínicas (ver CLAUDE.md, "nunca
 * sacar el filtro por clinicId de ninguna query").
 */
export async function isFirstTimePatient(
  clinicId: string,
  patientId: string,
  db: Db = prisma
): Promise<boolean> {
  const count = await db.appointment.count({ where: { clinicId, patientId } });
  if (count > 0) return false;
  // Sin citas acá, pero puede ser alguien que ya venía a la clínica antes de usar
  // la plataforma (importación inicial): no es de primera vez.
  const prior = await db.patient.findFirst({ where: { id: patientId, clinicId }, select: { priorHistory: true } });
  return !prior?.priorHistory;
}

/**
 * ¿El profesional tiene un bloqueo de su agenda personal en ese rango?
 *
 * Los bloqueos los importa jobs/calendar-sync.ts desde el Google Calendar
 * del profesional. Se consulta la tabla CalendarBlock en Postgres, NO la
 * API de Google — el calendario no participa de esta decisión.
 */
export async function hasCalendarBlock(
  clinicId: string,
  professionalId: string,
  start: Date,
  end: Date,
  db: Db = prisma
): Promise<boolean> {
  const block = await db.calendarBlock.findFirst({
    where: {
      clinicId,
      professionalId,
      startTime: { lt: end },
      endTime: { gt: start },
    },
  });
  return block !== null;
}

/**
 * ¿Dos rangos se pisan? Es la versión en memoria del `startTime: { lt: end },
 * endTime: { gt: start }` que usan todas las queries de este archivo.
 *
 * La exporta `availability-slots.ts`, que resuelve la ocupación en memoria en
 * vez de ir a la base por cada hueco candidato: teniendo el predicado en un
 * solo lugar, los dos caminos no se pueden desincronizar.
 *
 * Tocarse no es solaparse: un turno que termina 09:30 y otro que empieza
 * 09:30 conviven.
 */
export function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime();
}

/**
 * ¿El profesional tiene otro turno confirmado que se solape?
 *
 * `excludeAppointmentId` es para EDITAR una cita: al moverla, el hueco nuevo
 * se puede pisar con ella misma y no debe contar como ocupado.
 */
export async function hasOverlappingAppointment(
  clinicId: string,
  professionalId: string,
  start: Date,
  end: Date,
  db: Db = prisma,
  excludeAppointmentId?: string | null
): Promise<boolean> {
  const overlapping = await db.appointment.findFirst({
    where: {
      clinicId,
      professionalId,
      status: "confirmado",
      startTime: { lt: end },
      endTime: { gt: start },
      ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
    },
  });
  return overlapping !== null;
}

/**
 * ¿El profesional está libre en ese rango? Consulta nuestra base, no Google
 * Calendar. Cuentan dos cosas: que no tenga otro turno que se solape, y que
 * no tenga bloqueada su agenda personal en ese rato.
 */
export async function isProfessionalFree(
  clinicId: string,
  professionalId: string,
  start: Date,
  end: Date,
  db: Db = prisma
): Promise<boolean> {
  if (await hasOverlappingAppointment(clinicId, professionalId, start, end, db)) return false;
  return !(await hasCalendarBlock(clinicId, professionalId, start, end, db));
}

/** Primer espacio físico activo de la clínica que esté libre en ese rango. */
export async function findAvailableRoom(
  clinicId: string,
  start: Date,
  end: Date,
  db: Db = prisma,
  /**
   * El espacio habitual del profesional, si tiene uno. Es una PREFERENCIA:
   * se intenta primero y, si está ocupado, se le asigna cualquier otro
   * libre. Por eso no cambia la disponibilidad — el horario sigue estando
   * disponible mientras quede algún espacio— y el enumerador de huecos no
   * necesita saber nada de esto.
   */
  preferredRoomId?: string | null,
  /** Editar una cita: ella misma no ocupa el espacio. */
  excludeAppointmentId?: string | null
): Promise<string | null> {
  const todos = await db.room.findMany({ where: { clinicId, active: true } });

  // El preferido primero; el resto en el orden de siempre.
  const rooms = preferredRoomId
    ? [
        ...todos.filter((r) => r.id === preferredRoomId),
        ...todos.filter((r) => r.id !== preferredRoomId),
      ]
    : todos;

  for (const room of rooms) {
    const overlapping = await db.appointment.findFirst({
      where: {
        clinicId,
        roomId: room.id,
        status: "confirmado",
        startTime: { lt: end },
        endTime: { gt: start },
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
      },
    });
    if (!overlapping) return room.id;
  }
  return null;
}

/**
 * Primera unidad de equipo activa de un tipo dado (ej. "laser_diodo") que
 * esté libre en ese rango. Se usa solo cuando el servicio lo requiere —
 * ver Service.requiredResourceType. Si un servicio no necesita equipo,
 * este chequeo directamente no se llama.
 */
export async function findAvailableResource(
  clinicId: string,
  resourceType: string,
  start: Date,
  end: Date,
  db: Db = prisma,
  /** Editar una cita: ella misma no ocupa el equipo. */
  excludeAppointmentId?: string | null
): Promise<string | null> {
  const resources = await db.resource.findMany({
    where: { clinicId, type: resourceType, active: true },
  });
  for (const resource of resources) {
    const overlapping = await db.appointment.findFirst({
      where: {
        clinicId,
        resourceId: resource.id,
        status: "confirmado",
        startTime: { lt: end },
        endTime: { gt: start },
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
      },
    });
    if (!overlapping) return resource.id;
  }
  return null;
}

/**
 * Primer profesional activo de la clínica que esté libre en ese rango Y que
 * trabaje en ese horario.
 *
 * Es el criterio de asignación por default: se usa cuando el paciente no
 * pidió a nadie en particular y tampoco aplica la regla de "primera vez con
 * el profesional principal". Ver services/booking-rules.ts.
 *
 * El horario se chequea acá y no solo en booking.ts porque si no, el
 * criterio por default podría elegir a alguien que ese día no trabaja: está
 * "libre" justamente porque no atiende.
 *
 * El orden es por id, así que es estable y predecible: la clínica que cargó
 * primero a su profesional de cabecera lo va a ver recibir la mayoría de
 * los turnos sin dueño.
 *
 * TODO (Claude Code): si en algún momento hace falta repartir la carga
 * parejo, acá va un round robin — necesita guardar a quién le tocó último,
 * porque con esto solo el orden siempre favorece al primero.
 */
export async function findAvailableProfessional(
  params: {
    clinicId: string;
    clinicTimezone: string;
    start: Date;
    end: Date;
    /** Si la clínica no tiene horario estructurado, no se filtra por horario. */
    enforceWorkingHours: boolean;
    /** Si viene, solo se considera a estos (los que realizan el servicio). */
    onlyProfessionalIds?: string[] | null;
  },
  db: Db = prisma
): Promise<string | null> {
  const professionals = await db.professional.findMany({
    where: {
      clinicId: params.clinicId,
      active: true,
      ...(params.onlyProfessionalIds ? { id: { in: params.onlyProfessionalIds } } : {}),
    },
    orderBy: { id: "asc" },
    select: { id: true },
  });

  for (const professional of professionals) {
    if (
      !(await isProfessionalFree(params.clinicId, professional.id, params.start, params.end, db))
    ) {
      continue;
    }

    if (params.enforceWorkingHours) {
      const verdict = await checkWorkingHours(
        {
          clinicId: params.clinicId,
          clinicTimezone: params.clinicTimezone,
          professionalId: professional.id,
          start: params.start,
          end: params.end,
        },
        db
      );
      if (!verdict.ok) continue;
    }

    return professional.id;
  }
  return null;
}

/** Por qué no se pudo agendar. Se usa para el log y para el dashboard. */
export type UnavailableReason =
  | "profesional_ocupado"
  | "profesional_bloqueado"
  | "sin_espacios"
  | "sin_equipo"
  /**
   * Distinto de `sin_equipo`: no es que esté ocupado a esa hora, es que la
   * clínica no tiene NINGUNA unidad activa de ese tipo — el motor de
   * implantes se rompió y se dio de baja. Ese servicio no se puede dar a
   * ninguna hora, así que ofrecer otro horario no sirve: hay que avisarle a
   * una persona (ver `agent-turn.ts`).
   */
  | "equipo_fuera_de_servicio";

export interface AvailabilityResult {
  available: boolean;
  roomId: string | null;
  resourceId: string | null;
  reason?: UnavailableReason;
  /**
   * El profesional tenía un espacio preferido y estaba ocupado, así que se
   * le asignó otro. Se propaga al turno para poder explicarlo en la agenda.
   */
  preferredRoomUnavailable?: boolean;
}

/**
 * Chequeo combinado que corre antes de crear un turno: profesional libre,
 * espacio libre, y equipo libre si el servicio lo requiere.
 *
 * Este es el chequeo puntual, el que decide si un turno concreto se puede
 * crear. La enumeración de huecos libres de un rango de días, para ofrecerle
 * opciones al paciente, vive en `availability-slots.ts` — son hermanas y
 * tienen que decir lo mismo, pero solo ésta es la que manda: corre dentro de
 * la transacción serializable de `booking.ts`.
 */
export async function checkAvailability(params: {
  clinicId: string;
  professionalId: string;
  start: Date;
  end: Date;
  requiredResourceType?: string | null;
  /** El espacio habitual del profesional (`Professional.preferredRoomId`). */
  preferredRoomId?: string | null;
  /** Editar una cita: ella misma no cuenta como ocupación de nada. */
  excludeAppointmentId?: string | null;
  db?: Db;
}): Promise<AvailabilityResult> {
  const db = params.db ?? prisma;

  if (
    await hasOverlappingAppointment(
      params.clinicId,
      params.professionalId,
      params.start,
      params.end,
      db,
      params.excludeAppointmentId
    )
  ) {
    return { available: false, roomId: null, resourceId: null, reason: "profesional_ocupado" };
  }

  // Distinto de "ocupado": acá el profesional se bloqueó el rato en su
  // propia agenda de Google. Se separa para que el log y el dashboard
  // puedan explicar por qué no se ofreció ese horario.
  if (await hasCalendarBlock(params.clinicId, params.professionalId, params.start, params.end, db)) {
    return { available: false, roomId: null, resourceId: null, reason: "profesional_bloqueado" };
  }

  const roomId = await findAvailableRoom(
    params.clinicId,
    params.start,
    params.end,
    db,
    params.preferredRoomId,
    params.excludeAppointmentId
  );
  if (!roomId) {
    return { available: false, roomId: null, resourceId: null, reason: "sin_espacios" };
  }

  // Tenía un espacio preferido y no le tocó: su espacio estaba ocupado.
  const preferredRoomUnavailable = Boolean(params.preferredRoomId) && roomId !== params.preferredRoomId;

  let resourceId: string | null = null;
  if (params.requiredResourceType) {
    // Primero: ¿existe alguna unidad activa de ese tipo? Sin esto, un equipo
    // roto se ve igual que uno ocupado, y al paciente se le ofrece otro
    // horario que tampoco va a poder cumplirse.
    const unidadesActivas = await db.resource.count({
      where: { clinicId: params.clinicId, type: params.requiredResourceType, active: true },
    });
    if (unidadesActivas === 0) {
      return {
        available: false,
        roomId,
        resourceId: null,
        reason: "equipo_fuera_de_servicio",
        preferredRoomUnavailable,
      };
    }

    resourceId = await findAvailableResource(
      params.clinicId,
      params.requiredResourceType,
      params.start,
      params.end,
      db,
      params.excludeAppointmentId
    );
    if (!resourceId) {
      return { available: false, roomId, resourceId: null, reason: "sin_equipo" };
    }
  }

  return { available: true, roomId, resourceId, preferredRoomUnavailable };
}
