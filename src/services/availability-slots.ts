import type { Clinic, Patient, Prisma } from "@prisma/client";
import { violatesLeadTime } from "./lead-time";
import type { Weekday } from "@prisma/client";
import { prisma } from "../db/client";
import { rangesOverlap } from "./availability";
import { resolveProfessionalForBooking } from "./booking-rules";
import { resolveServiceForRequest } from "./catalog";
import {
  addDaysToDateKey,
  addMinutes,
  clinicDateKey,
  clinicWallTimeToUtc,
  minutesToWallTime,
  weekdayFromDateKey,
  type WeekdayName,
} from "./time";
import {
  fitsInSomeInterval,
  getEffectiveIntervalsForRange,
  hasStructuredHours,
  intersectIntervals,
  intervalsKey,
  type Interval,
} from "./working-hours";

/**
 * Enumeración de huecos libres, para OFRECERLE opciones al paciente.
 *
 * El principio que ordena todo este archivo:
 *
 *   **El enumerador nunca es el portero.**
 *
 * Un hueco devuelto acá es una oferta, no una reserva. Quien decide de verdad
 * si un turno se puede crear sigue siendo `checkAvailability()` adentro de la
 * transacción serializable de `booking.ts`. Por eso, si alguna vez los dos
 * cálculos difirieran, lo peor que puede pasar es (a) ofrecer un hueco que
 * después falla — recuperable, se re-ofrece — o (b) no ofrecer uno que estaba
 * libre — conservador. Nunca un sobreturno.
 *
 * La contrapartida de esa libertad es que acá se resuelve en memoria y no
 * consultando la base por cada candidato: dos semanas de grilla serían
 * decenas de miles de idas a Postgres para contestar un WhatsApp. Para que
 * las dos implementaciones no se desincronicen, el predicado de solape
 * (`rangesOverlap`) y las reglas de horario (`getEffectiveIntervalsForRange`)
 * se comparten con el camino puntual en vez de reescribirse.
 *
 * Las lecturas van FUERA de toda transacción a propósito: en `Serializable`,
 * leer dos semanas de turnos dentro de una transacción competiría con las de
 * creación de turnos y las haría abortar por conflicto de serialización.
 */

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Paso de la grilla de huecos, en minutos.
 *
 * 15 cae siempre en cuartos de hora (que es como la gente habla de los
 * turnos) y divide exacto las duraciones típicas de 15/30/45/60. Es un paso,
 * no una duración: `Clinic.defaultAppointmentMinutes` es otra cosa y
 * confundirlos ataría dos conceptos que cambian por motivos distintos.
 */
export const SLOT_STEP_MINUTES = 15;

/** Tope duro de días, para que nadie pida un año de agenda de una. */
export const MAX_SLOT_SEARCH_DAYS = 31;

/** Días que se exploran si el llamador no dice otra cosa. */
export const DEFAULT_SLOT_SEARCH_DAYS = 14;

export interface Slot {
  /** Instante UTC de inicio. Es lo que después se agenda. */
  start: Date;
  end: Date;
  /** Fecha local de la clínica, "YYYY-MM-DD". */
  dateKey: string;
  /** Hora de pared local, "HH:MM". Es lo que se le dice al paciente. */
  time: string;
  /**
   * Quién lo atendería. Si hay varios libres es el de menor id — el MISMO
   * criterio que `findAvailableProfessional()`, para que el profesional que
   * se ofrece sea el que después termina tomando el turno.
   */
  professionalId: string;
  professionalName: string;
  /** "Dr.", "Lic.", etc. — null si esta clínica no lo carga. */
  professionalTitle: string | null;
  /** Todos los que podrían tomarlo, por si el paciente pregunta. */
  candidateProfessionalIds: string[];
  /**
   * Los mismos, con nombre y título, para poder decírselo al paciente. Sin
   * esto el prompt solo veía al primero de cada hueco y el agente concluía
   * que ese era el único libre ("solo veo disponibilidad con la Dra. X"),
   * cuando los demás estaban libres a la misma hora.
   */
  candidateProfessionals: Array<{ id: string; name: string; title: string | null }>;
}

/**
 * Por qué un día no tiene huecos. Comparte vocabulario con
 * `BookingFailureReason` para poder explicarlo con `describeBookingFailure()`.
 */
export type DayNoSlotsReason =
  | "clinica_cerrada"
  | "profesional_fuera_de_horario"
  | "sin_profesional_disponible"
  | "sin_espacios"
  | "sin_equipo"
  | "completo"
  | "ya_paso"
  /** Quedan horarios, pero todos dentro del margen mínimo de anticipación. */
  | "anticipacion_minima";

export interface DaySlots {
  dateKey: string;
  weekday: WeekdayName;
  slots: Slot[];
  /** null si el día tiene al menos un hueco. */
  reason: DayNoSlotsReason | null;
  /** El motivo de la excepción de fecha, si la hubo ("Feriado nacional"). */
  exceptionReason: string | null;
}

/** Por qué la clínica no está en condiciones de enumerar nada. */
export type SlotSearchBlocker =
  | "sin_horario_de_atencion"
  | "sin_espacios_activos"
  | "sin_profesionales_activos"
  | "profesional_inexistente"
  /** Nombró un servicio que la clínica no ofrece. No hay nada que ofrecer. */
  | "servicio_no_ofrecido"
  /** El servicio existe pero nadie lo realiza. */
  | "servicio_sin_profesional";

export interface AvailableSlotsResult {
  /** Un elemento por día del rango, en orden, INCLUIDOS los días sin huecos. */
  days: DaySlots[];
  totalSlots: number;
  durationMinutes: number;
  blocker: SlotSearchBlocker | null;
  /** null = se buscó en todos; con valor = se buscó solo en esa agenda. */
  restrictedToProfessionalId: string | null;
  /**
   * El paciente pidió a alguien que NO realiza el servicio; guarda el nombre.
   * Los horarios son de quienes sí lo hacen, y el agente se lo explica.
   */
  requestedProfessionalNotAvailable?: string | null;
  /** Quiénes realizan el servicio, con título, para poder proponerlos. */
  professionalsForService?: Array<{ name: string; title: string | null }>;
}

interface BusyRange {
  start: Date;
  end: Date;
}

function vacio(
  durationMinutes: number,
  blocker: SlotSearchBlocker | null,
  restrictedToProfessionalId: string | null = null
): AvailableSlotsResult {
  return { days: [], totalSlots: 0, durationMinutes, blocker, restrictedToProfessionalId };
}

function anyOverlap(busy: BusyRange[] | undefined, start: Date, end: Date): boolean {
  return busy !== undefined && busy.some((b) => rangesOverlap(start, end, b.start, b.end));
}

function push(map: Map<string, BusyRange[]>, key: string, range: BusyRange): void {
  const actual = map.get(key);
  if (actual) actual.push(range);
  else map.set(key, [range]);
}

/**
 * El motivo más frecuente por el que se descartaron los candidatos del día.
 * Es información para el paciente ("ese día está completo"), no un error.
 */
function motivoDominante(conteo: Map<DayNoSlotsReason, number>): DayNoSlotsReason {
  let motivo: DayNoSlotsReason = "completo";
  let max = 0;
  for (const [key, value] of conteo) {
    if (value > max) {
      max = value;
      motivo = key;
    }
  }
  return motivo;
}

export async function findAvailableSlots(params: {
  clinic: Pick<Clinic, "id" | "timezone" | "defaultAppointmentMinutes"> &
    Partial<Pick<Clinic, "minLeadMinutes">>;
  /** Primer día a explorar, fecha LOCAL de la clínica. Default: hoy. */
  fromDateKey?: string;
  /** Días consecutivos a explorar, incluido el primero. */
  days?: number;
  durationMinutes: number;
  requiredResourceType?: string | null;
  /** Si viene, se busca SOLO en la agenda de ese profesional. */
  professionalId?: string | null;
  /** Si viene, se busca solo entre estos (los que realizan el servicio). */
  professionalIds?: string[] | null;
  /**
   * Reprogramar: una cita que NO debe contar como ocupada. Al mover un turno
   * 9:00 → 9:30, el hueco nuevo se pisa con el propio turno viejo, y sin esto
   * el profesional (y el espacio) aparecerían ocupados por la misma persona.
   */
  excludeAppointmentId?: string | null;
  stepMinutes?: number;
  /** Para testear sin depender del reloj. */
  now?: Date;
  db?: Db;
}): Promise<AvailableSlotsResult> {
  const db = params.db ?? prisma;
  const { timezone } = params.clinic;
  const now = params.now ?? new Date();
  const duration = params.durationMinutes;
  const step = Math.max(1, Math.trunc(params.stepMinutes ?? SLOT_STEP_MINUTES));
  const restrictedTo = params.professionalId ?? null;

  if (!Number.isFinite(duration) || duration < 1) return vacio(duration, null, restrictedTo);

  const dias = Math.min(
    Math.max(1, Math.trunc(params.days ?? DEFAULT_SLOT_SEARCH_DAYS)),
    MAX_SLOT_SEARCH_DAYS
  );

  // Una clínica sin horario cargado no puede agendar (booking.ts lo rechaza con
  // `clinica_sin_horario`), así que tampoco se le ofrece nada: se corta acá y el
  // que llama decide qué decirle al paciente.
  if (!(await hasStructuredHours(params.clinic.id, db))) {
    return vacio(duration, "sin_horario_de_atencion", restrictedTo);
  }

  const fromDateKey = params.fromDateKey ?? clinicDateKey(now, timezone);
  const dayList: Array<{ dateKey: string; weekday: WeekdayName }> = [];
  for (let i = 0; i < dias; i += 1) {
    const dateKey = i === 0 ? fromDateKey : addDaysToDateKey(fromDateKey, i);
    const weekday = dateKey ? weekdayFromDateKey(dateKey) : null;
    if (!dateKey || !weekday) return vacio(duration, null, restrictedTo);
    dayList.push({ dateKey, weekday });
  }

  const professionals = await db.professional.findMany({
    where: {
      clinicId: params.clinic.id,
      active: true,
      ...(restrictedTo
        ? { id: restrictedTo }
        : params.professionalIds
          ? { id: { in: params.professionalIds } }
          : {}),
    },
    orderBy: { id: "asc" },
    select: { id: true, name: true, title: { select: { name: true } } },
  });
  if (professionals.length === 0) {
    return vacio(
      duration,
      restrictedTo ? "profesional_inexistente" : "sin_profesionales_activos",
      restrictedTo
    );
  }

  const rooms = await db.room.findMany({
    where: { clinicId: params.clinic.id, active: true },
    select: { id: true },
  });
  if (rooms.length === 0) return vacio(duration, "sin_espacios_activos", restrictedTo);

  const resources = params.requiredResourceType
    ? await db.resource.findMany({
        where: {
          clinicId: params.clinic.id,
          type: params.requiredResourceType,
          active: true,
        },
        select: { id: true },
      })
    : [];

  // La ventana va de la medianoche local del primer día a la del siguiente al
  // último. Si alguna no existe (cambio de hora a medianoche, como en Chile o
  // Cuba) se corre una hora, que alcanza para no recortar la ventana.
  const finDateKey = addDaysToDateKey(dayList[dayList.length - 1].dateKey, 1);
  const rangeStart =
    clinicWallTimeToUtc(dayList[0].dateKey, "00:00", timezone) ??
    clinicWallTimeToUtc(dayList[0].dateKey, "01:00", timezone);
  const rangeEnd = finDateKey
    ? clinicWallTimeToUtc(finDateKey, "00:00", timezone) ??
      clinicWallTimeToUtc(finDateKey, "01:00", timezone)
    : null;
  if (!rangeStart || !rangeEnd) return vacio(duration, null, restrictedTo);

  // Por SOLAPE y no por `startTime >= rangeStart`: un turno que arrancó antes
  // de la ventana sigue ocupando su sala adentro de la ventana.
  //
  // Sin filtrar por profesional a propósito: las salas y los equipos son un
  // cuello de botella COMPARTIDO por toda la clínica, así que los turnos de
  // los demás (incluidos los de profesionales inactivos) también los ocupan.
  const appointments = await db.appointment.findMany({
    where: {
      clinicId: params.clinic.id,
      status: "confirmado",
      startTime: { lt: rangeEnd },
      endTime: { gt: rangeStart },
      ...(params.excludeAppointmentId ? { id: { not: params.excludeAppointmentId } } : {}),
    },
    select: {
      startTime: true,
      endTime: true,
      professionalId: true,
      roomId: true,
      resourceId: true,
    },
  });

  const blocks = await db.calendarBlock.findMany({
    where: {
      clinicId: params.clinic.id,
      professionalId: { in: professionals.map((p) => p.id) },
      startTime: { lt: rangeEnd },
      endTime: { gt: rangeStart },
    },
    select: { startTime: true, endTime: true, professionalId: true },
  });

  const busyByProfessional = new Map<string, BusyRange[]>();
  const busyByRoom = new Map<string, BusyRange[]>();
  const busyByResource = new Map<string, BusyRange[]>();

  for (const appt of appointments) {
    const range = { start: appt.startTime, end: appt.endTime };
    push(busyByProfessional, appt.professionalId, range);
    push(busyByRoom, appt.roomId, range);
    if (appt.resourceId) push(busyByResource, appt.resourceId, range);
  }
  for (const block of blocks) {
    push(busyByProfessional, block.professionalId, {
      start: block.startTime,
      end: block.endTime,
    });
  }

  const intervalsByKey = await getEffectiveIntervalsForRange(
    {
      clinicId: params.clinic.id,
      professionalIds: professionals.map((p) => p.id),
      days: dayList.map((d) => ({ dateKey: d.dateKey, weekday: d.weekday as Weekday })),
    },
    db
  );

  const days: DaySlots[] = [];
  let totalSlots = 0;

  for (const day of dayList) {
    const conteo = new Map<DayNoSlotsReason, number>();
    const primero = intervalsByKey.get(intervalsKey(day.dateKey, professionals[0].id));
    const clinicDay = primero?.clinic ?? { intervals: [], exceptionReason: null };

    if (clinicDay.intervals.length === 0) {
      days.push({
        dateKey: day.dateKey,
        weekday: day.weekday,
        slots: [],
        reason: "clinica_cerrada",
        exceptionReason: clinicDay.exceptionReason,
      });
      continue;
    }

    // Los tramos hábiles de cada profesional: lo que la clínica atiende Y él
    // trabaja. Se calculan una vez por día y se reusan en cada candidato.
    const tramosPorProfesional = new Map<string, Interval[]>();
    for (const professional of professionals) {
      const efectivos = intervalsByKey.get(intervalsKey(day.dateKey, professional.id));
      tramosPorProfesional.set(
        professional.id,
        intersectIntervals(clinicDay.intervals, efectivos?.professional.intervals ?? [])
      );
    }

    // La grilla del día es la unión de las grillas de cada profesional: un
    // minuto es candidato si AL MENOS uno podría atender ahí.
    const candidatos = new Set<number>();
    for (const tramos of tramosPorProfesional.values()) {
      for (const tramo of tramos) {
        for (let m = tramo.startMinute; m + duration <= tramo.endMinute; m += step) {
          candidatos.add(m);
        }
      }
    }

    if (candidatos.size === 0) {
      days.push({
        dateKey: day.dateKey,
        weekday: day.weekday,
        slots: [],
        reason: "profesional_fuera_de_horario",
        exceptionReason: clinicDay.exceptionReason,
      });
      continue;
    }

    const slots: Slot[] = [];
    for (const startMinute of [...candidatos].sort((a, b) => a - b)) {
      const time = minutesToWallTime(startMinute);
      // null = esa hora local no existe ese día (la madrugada que se saltea
      // al entrar el horario de verano).
      const start = clinicWallTimeToUtc(day.dateKey, time, timezone);
      if (!start) continue;

      // Mismo criterio que booking.ts: tiempo transcurrido, no hora de pared.
      const end = addMinutes(start, duration);

      if (start.getTime() <= now.getTime()) {
        conteo.set("ya_paso", (conteo.get("ya_paso") ?? 0) + 1);
        continue;
      }

      // Anticipación mínima: misma función que booking.ts y la Agenda, para
      // que no se ofrezca un horario que después se rechaza.
      if (violatesLeadTime(start, now, params.clinic.minLeadMinutes ?? 0)) {
        conteo.set("anticipacion_minima", (conteo.get("anticipacion_minima") ?? 0) + 1);
        continue;
      }

      const disponibles = professionals.filter(
        (p) =>
          fitsInSomeInterval(
            tramosPorProfesional.get(p.id) ?? [],
            startMinute,
            startMinute + duration
          ) && !anyOverlap(busyByProfessional.get(p.id), start, end)
      );
      if (disponibles.length === 0) {
        conteo.set(
          "sin_profesional_disponible",
          (conteo.get("sin_profesional_disponible") ?? 0) + 1
        );
        continue;
      }

      if (!rooms.some((r) => !anyOverlap(busyByRoom.get(r.id), start, end))) {
        conteo.set("sin_espacios", (conteo.get("sin_espacios") ?? 0) + 1);
        continue;
      }

      if (
        params.requiredResourceType &&
        !resources.some((r) => !anyOverlap(busyByResource.get(r.id), start, end))
      ) {
        conteo.set("sin_equipo", (conteo.get("sin_equipo") ?? 0) + 1);
        continue;
      }

      slots.push({
        start,
        end,
        dateKey: day.dateKey,
        time,
        professionalId: disponibles[0].id,
        professionalName: disponibles[0].name,
        professionalTitle: disponibles[0].title?.name ?? null,
        candidateProfessionalIds: disponibles.map((p) => p.id),
        candidateProfessionals: disponibles.map((p) => ({
          id: p.id,
          name: p.name,
          title: p.title?.name ?? null,
        })),
      });
    }

    totalSlots += slots.length;
    days.push({
      dateKey: day.dateKey,
      weekday: day.weekday,
      slots,
      reason: slots.length > 0 ? null : motivoDominante(conteo),
      exceptionReason: clinicDay.exceptionReason,
    });
  }

  return {
    days,
    totalSlots,
    durationMinutes: duration,
    blocker: null,
    restrictedToProfessionalId: restrictedTo,
  };
}

/**
 * Los huecos que se le pueden ofrecer a UN paciente concreto, aplicando la
 * política de asignación de profesional.
 *
 * La política no se reimplementa: se le pregunta a
 * `resolveProfessionalForBooking()`, el único lugar donde se decide. Llamada
 * sin `start`/`end` no corre el criterio "el primero libre" (que no tiene
 * sentido al enumerar, porque justamente todavía no hay un horario), pero sí
 * la regla de primera vez — que es lo que hay que respetar acá.
 */
export async function findSlotsForPatient(params: {
  clinic: Clinic;
  patient: Pick<Patient, "id">;
  requestedService: string | null;
  requestedProfessionalId?: string | null;
  isUrgent?: boolean;
  /** La campaña por la que llegó la persona: puede sumarle profesionales al servicio de su promoción. */
  campaignId?: string | null;
  /** Reprogramar: la cita que se está moviendo (no cuenta como ocupada). */
  excludeAppointmentId?: string | null;
  fromDateKey?: string;
  days?: number;
  now?: Date;
  db?: Db;
}): Promise<AvailableSlotsResult> {
  const db = params.db ?? prisma;

  const resolved = await resolveServiceForRequest(
    params.clinic,
    params.requestedService,
    db,
    { patientId: params.patient.id, isUrgent: params.isUrgent, campaignId: params.campaignId }
  );
  const { durationMinutes, requiredResourceType, allowedProfessionalIds } = resolved;

  // Lo pedido no es algo que la clínica hace, o nadie lo realiza: no hay
  // horarios que ofrecer, y quien llama tiene que derivar a una persona.
  if (resolved.notOffered) return vacio(durationMinutes, "servicio_no_ofrecido");
  if (allowedProfessionalIds && allowedProfessionalIds.length === 0) {
    return vacio(durationMinutes, "servicio_sin_profesional");
  }

  const { professionalId, requestedIgnored } = await resolveProfessionalForBooking({
    clinic: params.clinic,
    requestedProfessionalId: params.requestedProfessionalId ?? null,
    allowedProfessionalIds,
    db,
  });

  const result = await findAvailableSlots({
    clinic: params.clinic,
    fromDateKey: params.fromDateKey,
    days: params.days,
    durationMinutes,
    requiredResourceType,
    professionalId,
    professionalIds: allowedProfessionalIds,
    excludeAppointmentId: params.excludeAppointmentId,
    now: params.now,
    db,
  });

  if (requestedIgnored && params.requestedProfessionalId) {
    const [pedido, habilitados] = await Promise.all([
      db.professional.findFirst({
        where: { id: params.requestedProfessionalId, clinicId: params.clinic.id },
        select: { name: true, title: { select: { name: true } } },
      }),
      db.professional.findMany({
        where: { id: { in: allowedProfessionalIds ?? [] } },
        orderBy: { id: "asc" },
        select: { name: true, title: { select: { name: true } } },
      }),
    ]);
    result.requestedProfessionalNotAvailable = pedido?.name ?? null;
    result.professionalsForService = habilitados.map((p) => ({
      name: p.name,
      title: p.title?.name ?? null,
    }));
  }

  return result;
}
