import { Prisma } from "@prisma/client";
import { cleanCancelReason, recordAppointmentEvent } from "./appointment-events";
import { checkPackageLink } from "./packages";
import { describeLeadTime, violatesLeadTime } from "./lead-time";
import type { Appointment, CalendarBlock, Professional, Service } from "@prisma/client";
import { prisma } from "../db/client";
import type { ClinicWithCalendarAccount } from "../repositories/clinics.repository";
import {
  findAvailableResource,
  findAvailableRoom,
  hasCalendarBlock,
  hasOverlappingAppointment,
  isFirstTimePatient,
} from "./availability";
import {
  mirrorAppointmentToCalendar,
  PROFESSIONAL_CALENDAR_INCLUDE,
  removeMirroredEvent,
  resolveCalendarTargetForProfessional,
} from "./calendar";
import { notifyPatientOfChange, type PatientNoticeResult } from "./patient-notifications";
import { notifyProfessionalOfAppointment } from "./professional-notifications";
import {
  addMinutes,
  clinicDateKey,
  clinicWallTimeToUtc,
  formatWallTime,
} from "./time";
import { checkClinicHours, checkWorkingHours, hasStructuredHours } from "./working-hours";

/**
 * Crear, mover, editar y cancelar citas —y cargar bloqueos— desde la Agenda de
 * la aplicación, que a futuro reemplaza a la de otras plataformas.
 *
 * **Mismas reglas que el asistente de WhatsApp, con excepción confirmada**
 * (decisión del 2026-11-07). Una persona puede tener razones que el asistente
 * no (un sobreturno, atender fuera de horario, un amigo de la casa), así que
 * las reglas BLANDAS se pueden saltar — pero solo con una confirmación
 * explícita (`force: true`) después de ver cuáles se rompen, y queda constancia
 * en `Appointment.forcedRules`. Las reglas DURAS no se saltan nunca: son físicas
 * (el mismo espacio o equipo no puede estar en dos lugares a la vez) o rompen la
 * identidad del turno (la misma persona con dos citas que se pisan).
 *
 * El flujo de dos pasos es el mismo en las tres operaciones: se manda sin
 * `force`, y si hay reglas blandas rotas se devuelve `requiere_confirmacion`
 * con la lista, sin haber tocado nada. La interfaz la muestra y reenvía con
 * `force: true`.
 *
 * Todo corre en UNA transacción `Serializable`, igual que `booking.ts`: dos
 * personas moviendo citas al mismo hueco no pueden dejar ambas adentro. Las
 * llamadas de red (espejo en Calendar, avisos) van DESPUÉS de cerrarla.
 */

/** Reglas que una persona puede saltarse confirmando. */
export type ForceableRule =
  | "fecha_en_el_pasado"
  | "anticipacion_minima"
  | "clinica_cerrada"
  | "profesional_fuera_de_horario"
  | "profesional_ocupado"
  | "profesional_bloqueado"
  | "primera_vez_sin_diagnostico"
  /** El paquete elegido ya no tiene sesiones sin comprometer con otra cita. */
  | "paquete_sin_sesiones";

export interface Violation {
  rule: ForceableRule;
  message: string;
}

const MENSAJES: Record<ForceableRule, string> = {
  fecha_en_el_pasado: "El horario elegido ya pasó.",
  // El texto real lleva los minutos de la clínica: lo arma `evaluateSlot()`.
  anticipacion_minima: "El horario queda dentro del margen mínimo de anticipación de la clínica.",
  clinica_cerrada: "La clínica no atiende en ese horario (o cae en el corte del mediodía).",
  profesional_fuera_de_horario: "El profesional no atiende en ese horario.",
  profesional_ocupado: "El profesional ya tiene otra cita en ese horario.",
  profesional_bloqueado: "El profesional tiene bloqueado ese rato en su agenda.",
  primera_vez_sin_diagnostico:
    "Es un paciente de primera vez: la clínica indica que empiece por el diagnóstico inicial.",
  // El texto real lleva los números del paquete: lo arma `avisoPaqueteSinSesiones()`.
  paquete_sin_sesiones: "El paquete no tiene sesiones libres.",
};

function avisoPaqueteSinSesiones(c: { total: number; used: number; reserved: number }): Violation {
  return {
    rule: "paquete_sin_sesiones",
    message:
      `El paquete tiene ${c.total} sesiones: ${c.used} ya usadas y ${c.reserved} agendadas sin confirmar. ` +
      "Esta cita sería de más.",
  };
}

/** Por qué no se pudo, sin posibilidad de forzarlo. */
export type HardFailure =
  | "no_encontrado"
  | "datos_invalidos"
  | "espacio_invalido"
  | "espacio_ocupado"
  | "sin_espacios"
  | "sin_equipo"
  | "equipo_fuera_de_servicio"
  | "paciente_con_turno_superpuesto"
  /** El profesional no tiene asignado el servicio: obligatorio, no se puede forzar (2026-11-21). */
  | "profesional_no_hace_servicio"
  | "paquete_no_encontrado"
  | "paquete_inactivo"
  | "paquete_de_otro_servicio"
  | "conflicto_concurrente";

export const HARD_FAILURE_MESSAGE: Record<HardFailure, string> = {
  no_encontrado: "No se encontró lo que se quería modificar en esta clínica.",
  datos_invalidos: "Faltan datos o hay alguno inválido (fecha, hora o duración).",
  espacio_invalido: "El espacio indicado no existe, no es de esta clínica o está inactivo.",
  espacio_ocupado: "Ese espacio ya está ocupado en ese horario.",
  sin_espacios: "No hay ningún espacio libre en ese horario.",
  sin_equipo: "No hay una unidad libre del equipo que requiere el servicio.",
  equipo_fuera_de_servicio: "El equipo que requiere el servicio está fuera de servicio.",
  paciente_con_turno_superpuesto:
    "Esa persona ya tiene otra cita que se pisa con ese horario.",
  profesional_no_hace_servicio:
    "Ese profesional no realiza este servicio. Elige a alguien que lo tenga asignado (en \"Servicios\" se define quién realiza cada uno).",
  paquete_no_encontrado: "El paquete no existe, o no es de este paciente.",
  paquete_inactivo: "El paquete ya no tiene sesiones o está desactivado.",
  paquete_de_otro_servicio: "El paquete es de otro servicio distinto al de la cita.",
  conflicto_concurrente: "Otra persona tomó ese horario al mismo tiempo. Prueba de nuevo.",
};

export type AdminFailure =
  | { ok: false; reason: "requiere_confirmacion"; violations: Violation[] }
  | { ok: false; reason: HardFailure; message: string };

class HardError extends Error {
  constructor(
    public reason: HardFailure,
    /** Mensaje más específico que el genérico de la razón (p. ej. con el nombre del equipo). */
    public detail?: string
  ) {
    super(reason);
  }
}

/** Qué equipo hace falta y no está libre, dicho con el nombre real de la unidad. */
export function sinEquipoMessage(unitNames: string[]): string {
  if (unitNames.length === 0) return HARD_FAILURE_MESSAGE.sin_equipo;
  if (unitNames.length === 1) {
    return `El equipo "${unitNames[0]}" no está libre en ese horario y el servicio lo requiere.`;
  }
  const quoted = unitNames.map((n) => `"${n}"`).join(", ");
  return `Ninguna unidad del equipo que requiere el servicio está libre en ese horario (${quoted}).`;
}

class ConfirmationNeeded extends Error {
  constructor(public violations: Violation[]) {
    super("requiere_confirmacion");
  }
}

function isSerializationFailure(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

function failure(error: unknown): AdminFailure | null {
  if (error instanceof ConfirmationNeeded) {
    return { ok: false, reason: "requiere_confirmacion", violations: error.violations };
  }
  if (error instanceof HardError) {
    return { ok: false, reason: error.reason, message: error.detail ?? HARD_FAILURE_MESSAGE[error.reason] };
  }
  if (isSerializationFailure(error)) {
    return {
      ok: false,
      reason: "conflicto_concurrente",
      message: HARD_FAILURE_MESSAGE.conflicto_concurrente,
    };
  }
  return null;
}

type Tx = Prisma.TransactionClient;

interface SlotContext {
  clinic: Pick<ClinicWithCalendarAccount, "id" | "timezone" | "minLeadMinutes">;
  patientId: string;
  professional: Pick<Professional, "id" | "preferredRoomId"> & { services: Array<{ id: string }> };
  service: Pick<Service, "id" | "firstVisit" | "requiredResourceType"> | null;
  start: Date;
  end: Date;
  /** Espacio pedido a mano; null = se elige solo (el habitual del profesional primero). */
  roomId: string | null;
  /** Al editar: la cita que se mueve, que no cuenta como ocupación de nada. */
  excludeAppointmentId: string | null;
  /** El espacio que ya tenía, para conservarlo si sigue libre. */
  currentRoomId: string | null;
  /**
   * Exigir que el profesional tenga asignado el servicio. Siempre al crear; al editar, solo si cambió el profesional o el
   * servicio: mover de hora una cita vieja no puede fallar porque después se le quitó el servicio al profesional.
   */
  exigirServicioAsignado: boolean;
  now: Date;
}

interface SlotVerdict {
  violations: Violation[];
  roomId: string;
  resourceId: string | null;
  preferredRoomUnavailable: boolean;
}

/**
 * Evalúa un hueco para una cita: junta las reglas blandas rotas y corta en la
 * primera dura. Corre DENTRO de la transacción.
 */
async function evaluateSlot(tx: Tx, ctx: SlotContext): Promise<SlotVerdict> {
  const { clinic, start, end } = ctx;
  const violations: Violation[] = [];
  const romper = (rule: ForceableRule) => violations.push({ rule, message: MENSAJES[rule] });

  // Dura: una persona no puede estar en dos citas a la vez.
  const propia = await tx.appointment.findFirst({
    where: {
      clinicId: clinic.id,
      patientId: ctx.patientId,
      status: "confirmado",
      startTime: { lt: end },
      endTime: { gt: start },
      ...(ctx.excludeAppointmentId ? { id: { not: ctx.excludeAppointmentId } } : {}),
    },
    select: { id: true },
  });
  if (propia) throw new HardError("paciente_con_turno_superpuesto");

  if (start.getTime() <= ctx.now.getTime()) {
    romper("fecha_en_el_pasado");
  } else if (violatesLeadTime(start, ctx.now, clinic.minLeadMinutes)) {
    // Blanda, como el pasado: una asistente puede meter un turno urgente.
    violations.push({
      rule: "anticipacion_minima",
      message: `La clínica pide reservar con al menos ${describeLeadTime(clinic.minLeadMinutes)} de anticipación.`,
    });
  }

  // Horario: igual que `booking.ts`. Sin ningún tramo cargado la clínica está
  // "cerrada" siempre (ya no se saltea el chequeo); como es una regla blanda,
  // la asistente puede confirmar igual, pero se le dice cuál es el problema de
  // verdad en vez de "no atiende en ese horario".
  const clinicVerdict = await checkClinicHours(
    { clinicId: clinic.id, clinicTimezone: clinic.timezone, start, end },
    tx
  );
  if (!clinicVerdict.ok) {
    if (await hasStructuredHours(clinic.id, tx)) {
      romper("clinica_cerrada");
    } else {
      violations.push({
        rule: "clinica_cerrada",
        message: "La clínica todavía no tiene cargado su horario de atención (se carga en \"Horarios\").",
      });
    }
  } else {
    const verdict = await checkWorkingHours(
      {
        clinicId: clinic.id,
        clinicTimezone: clinic.timezone,
        professionalId: ctx.professional.id,
        start,
        end,
      },
      tx
    );
    if (!verdict.ok) romper("profesional_fuera_de_horario");
  }

  // Quién realiza qué: OBLIGATORIO (dura), solo con servicio de catálogo. Antes era una regla blanda que se podía confirmar; se
  // endureció el 2026-11-21: agendar a alguien con un servicio que no realiza no es una excepción de horario sino un dato
  // equivocado. Es la misma regla que impone el asistente de WhatsApp (`profesional_no_hace_servicio` en `booking.ts`).
  if (
    ctx.exigirServicioAsignado &&
    ctx.service &&
    !ctx.professional.services.some((s) => s.id === ctx.service!.id)
  ) {
    throw new HardError("profesional_no_hace_servicio");
  }

  // Primera vez: si la clínica marcó un servicio de primera vez y esta persona
  // nunca vino, la asistente elige otro. A diferencia del asistente de WhatsApp
  // —que lo reemplaza solo— acá no se pisa lo que una persona eligió a
  // propósito: se avisa y se deja confirmar.
  if (ctx.service && !ctx.service.firstVisit) {
    const hayServicioDePrimeraVez = await tx.service.count({
      where: { clinicId: clinic.id, active: true, firstVisit: true },
    });
    if (hayServicioDePrimeraVez > 0 && (await isFirstTimePatient(clinic.id, ctx.patientId, tx))) {
      romper("primera_vez_sin_diagnostico");
    }
  }

  if (
    await hasOverlappingAppointment(
      clinic.id,
      ctx.professional.id,
      start,
      end,
      tx,
      ctx.excludeAppointmentId
    )
  ) {
    romper("profesional_ocupado");
  }
  if (await hasCalendarBlock(clinic.id, ctx.professional.id, start, end, tx)) {
    romper("profesional_bloqueado");
  }

  // Dura: el espacio. Si pidió uno puntual tiene que estar libre; si no, se
  // elige uno — el que ya tenía, o el habitual del profesional, primero.
  let roomId: string;
  if (ctx.roomId) {
    const room = await tx.room.findFirst({
      where: { id: ctx.roomId, clinicId: clinic.id, active: true },
      select: { id: true },
    });
    if (!room) throw new HardError("espacio_invalido");
    const ocupado = await tx.appointment.findFirst({
      where: {
        clinicId: clinic.id,
        roomId: room.id,
        status: "confirmado",
        startTime: { lt: end },
        endTime: { gt: start },
        ...(ctx.excludeAppointmentId ? { id: { not: ctx.excludeAppointmentId } } : {}),
      },
      select: { id: true },
    });
    if (ocupado) throw new HardError("espacio_ocupado");
    roomId = room.id;
  } else {
    const elegido = await findAvailableRoom(
      clinic.id,
      start,
      end,
      tx,
      ctx.currentRoomId ?? ctx.professional.preferredRoomId,
      ctx.excludeAppointmentId
    );
    if (!elegido) throw new HardError("sin_espacios");
    roomId = elegido;
  }

  // Dura: el equipo, si el servicio lo pide.
  let resourceId: string | null = null;
  if (ctx.service?.requiredResourceType) {
    const activas = await tx.resource.count({
      where: { clinicId: clinic.id, type: ctx.service.requiredResourceType, active: true },
    });
    if (activas === 0) throw new HardError("equipo_fuera_de_servicio");
    resourceId = await findAvailableResource(
      clinic.id,
      ctx.service.requiredResourceType,
      start,
      end,
      tx,
      ctx.excludeAppointmentId
    );
    if (!resourceId) {
      const unidades = await tx.resource.findMany({
        where: { clinicId: clinic.id, type: ctx.service.requiredResourceType, active: true },
        select: { name: true },
        orderBy: { name: "asc" },
      });
      throw new HardError("sin_equipo", sinEquipoMessage(unidades.map((u) => u.name)));
    }
  }

  const habitual = ctx.professional.preferredRoomId;
  return {
    violations,
    roomId,
    resourceId,
    preferredRoomUnavailable: Boolean(habitual) && !ctx.roomId && roomId !== habitual,
  };
}

/** Si hay reglas blandas rotas y no se confirmó, se corta ANTES de escribir nada. */
function exigirConfirmacion(verdict: SlotVerdict, force: boolean): void {
  if (verdict.violations.length > 0 && !force) {
    throw new ConfirmationNeeded(verdict.violations);
  }
}

const SERIALIZABLE = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;

// --- Espejo en el calendario y avisos (FUERA de la transacción) ---

async function espejar(params: {
  clinic: ClinicWithCalendarAccount;
  appointment: Appointment;
  patientName: string;
}): Promise<string | null> {
  const { clinic, appointment } = params;
  const professional = await prisma.professional.findUnique({
    where: { id: appointment.professionalId },
    include: PROFESSIONAL_CALENDAR_INCLUDE,
  });
  const target = professional ? resolveCalendarTargetForProfessional(clinic, professional) : null;
  if (!professional || !target) return null;

  try {
    const [room, resource] = await Promise.all([
      prisma.room.findUnique({ where: { id: appointment.roomId }, select: { name: true } }),
      appointment.resourceId
        ? prisma.resource.findUnique({ where: { id: appointment.resourceId }, select: { name: true } })
        : Promise.resolve(null),
    ]);
    return await mirrorAppointmentToCalendar({
      target,
      appointmentId: appointment.id,
      clinicId: clinic.id,
      patientName: params.patientName,
      professionalName: professional.name,
      service: appointment.service,
      startTime: appointment.startTime.toISOString(),
      endTime: appointment.endTime.toISOString(),
      roomName: room?.name ?? null,
      resourceName: resource?.name ?? null,
      timezone: clinic.timezone,
    });
  } catch (error) {
    // El turno existe y vale; lo que falló es reflejarlo en el calendario.
    console.error(`Cita ${appointment.id} sin espejo en Calendar:`, error);
    return null;
  }
}

async function desespejar(params: {
  clinic: ClinicWithCalendarAccount;
  professionalId: string;
  googleEventId: string | null;
}): Promise<void> {
  if (!params.googleEventId) return;
  const professional = await prisma.professional.findUnique({
    where: { id: params.professionalId },
    include: PROFESSIONAL_CALENDAR_INCLUDE,
  });
  const target = professional ? resolveCalendarTargetForProfessional(params.clinic, professional) : null;
  if (!target) return;
  try {
    await removeMirroredEvent(target, params.googleEventId);
  } catch (error) {
    console.error(`No se pudo borrar el evento espejo ${params.googleEventId}:`, error);
  }
}

/** Fecha y hora de pared de la clínica → instante UTC, o null si no existe. */
function aInstante(
  timezone: string,
  date: string | null | undefined,
  time: string | null | undefined
): Date | null {
  if (!date || !time) return null;
  return clinicWallTimeToUtc(date, time, timezone);
}

function duracionValida(minutos: number): boolean {
  return Number.isInteger(minutos) && minutos >= 5 && minutos <= 720;
}

// --- Crear ---

export type CreateResult =
  | { ok: true; appointment: Appointment; forcedRules: ForceableRule[] }
  | AdminFailure;

export async function createManualAppointment(params: {
  clinic: ClinicWithCalendarAccount;
  userId: string;
  patientId: string;
  serviceId: string;
  professionalId: string;
  /** Día en la clínica, YYYY-MM-DD. */
  date: string;
  /** Hora de pared de la clínica, HH:MM. */
  time: string;
  /** Si no viene, la del servicio. */
  durationMinutes?: number | null;
  roomId?: string | null;
  /** Usar una sesión de este paquete del paciente (se descuenta al marcarla atendida). */
  packageId?: string | null;
  force?: boolean;
  now?: Date;
}): Promise<CreateResult> {
  const { clinic } = params;

  const start = aInstante(clinic.timezone, params.date, params.time);
  if (!start) return { ok: false, reason: "datos_invalidos", message: HARD_FAILURE_MESSAGE.datos_invalidos };

  const [patient, service, professional] = await Promise.all([
    prisma.patient.findFirst({ where: { id: params.patientId, clinicId: clinic.id } }),
    prisma.service.findFirst({ where: { id: params.serviceId, clinicId: clinic.id } }),
    prisma.professional.findFirst({
      where: { id: params.professionalId, clinicId: clinic.id, active: true },
      include: { services: { select: { id: true } } },
    }),
  ]);
  if (!patient || !service || !professional) {
    return { ok: false, reason: "no_encontrado", message: HARD_FAILURE_MESSAGE.no_encontrado };
  }

  const duracion = params.durationMinutes ?? service.durationMinutes;
  if (!duracionValida(duracion)) {
    return { ok: false, reason: "datos_invalidos", message: HARD_FAILURE_MESSAGE.datos_invalidos };
  }
  const end = addMinutes(start, duracion);

  let appointment: Appointment;
  let forced: ForceableRule[] = [];
  try {
    appointment = await prisma.$transaction(async (tx) => {
      const verdict = await evaluateSlot(tx, {
        clinic,
        patientId: patient.id,
        professional,
        service,
        start,
        end,
        roomId: params.roomId ?? null,
        excludeAppointmentId: null,
        currentRoomId: null,
        exigirServicioAsignado: true,
        now: params.now ?? new Date(),
      });
      let packageId: string | null = null;
      if (params.packageId) {
        const link = await checkPackageLink(tx, {
          clinicId: clinic.id,
          patientId: patient.id,
          packageId: params.packageId,
          serviceId: service.id,
        });
        if (!link.ok) throw new HardError(link.reason);
        if (link.overbooked) verdict.violations.push(avisoPaqueteSinSesiones(link.capacity));
        packageId = link.package.id;
      }
      exigirConfirmacion(verdict, params.force === true);
      forced = verdict.violations.map((v) => v.rule);

      const creada = await tx.appointment.create({
        data: {
          clinicId: clinic.id,
          patientId: patient.id,
          professionalId: professional.id,
          roomId: verdict.roomId,
          resourceId: verdict.resourceId,
          serviceId: service.id,
          packageId,
          service: service.name,
          startTime: start,
          endTime: end,
          preferredRoomUnavailable: verdict.preferredRoomUnavailable,
          source: "panel",
          forcedRules: forced,
          createdByUserId: params.userId,
        },
      });
      await recordAppointmentEvent(tx, {
        clinicId: clinic.id,
        appointmentId: creada.id,
        type: "creada",
        actorKind: "usuario",
        actorUserId: params.userId,
        toStartTime: start,
        toProfessionalId: professional.id,
        details: forced.length > 0 ? { reglasForzadas: forced } : undefined,
      });
      return creada;
    }, SERIALIZABLE);
  } catch (error) {
    const f = failure(error);
    if (f) return f;
    throw error;
  }

  // Fuera de la transacción.
  const [room] = await Promise.all([
    prisma.room.findUnique({ where: { id: appointment.roomId }, select: { name: true } }),
  ]);
  await notifyProfessionalOfAppointment({
    clinic,
    professional,
    appointmentId: appointment.id,
    startTime: appointment.startTime,
    endTime: appointment.endTime,
    service: appointment.service,
    patientName: patient.name ?? patient.phone,
    roomName: room?.name ?? null,
    preferredRoomUnavailable: appointment.preferredRoomUnavailable,
  });

  const googleEventId = await espejar({
    clinic,
    appointment,
    patientName: patient.name ?? patient.phone,
  });
  if (googleEventId) {
    appointment = await prisma.appointment.update({
      where: { id: appointment.id },
      data: { googleEventId },
    });
  }

  return { ok: true, appointment, forcedRules: forced };
}

// --- Mover / editar ---

export interface AppointmentChanges {
  /** Día nuevo, YYYY-MM-DD. Sin él se conserva el actual. */
  date?: string;
  /** Hora nueva, HH:MM. Sin ella se conserva la actual. */
  time?: string;
  professionalId?: string;
  serviceId?: string;
  /** null = elegir solo; con valor = ese espacio. Ausente = conservar el actual. */
  roomId?: string | null;
  durationMinutes?: number;
  /** null = desatar del paquete; con valor = atar a ese; ausente = conservar. */
  packageId?: string | null;
}

export type UpdateResult =
  | {
      ok: true;
      appointment: Appointment;
      forcedRules: ForceableRule[];
      /** Presente solo si se pidió avisar. */
      patientNotice: PatientNoticeResult | null;
    }
  | AdminFailure;

export async function updateAppointment(params: {
  clinic: ClinicWithCalendarAccount;
  userId: string;
  appointmentId: string;
  changes: AppointmentChanges;
  force?: boolean;
  /** Avisarle al paciente por WhatsApp (plantilla `cita_modificada`). */
  notifyPatient?: boolean;
  now?: Date;
}): Promise<UpdateResult> {
  const { clinic, changes } = params;

  const actual = await prisma.appointment.findFirst({
    where: { id: params.appointmentId, clinicId: clinic.id, status: "confirmado" },
    include: { patient: true },
  });
  if (!actual) return { ok: false, reason: "no_encontrado", message: HARD_FAILURE_MESSAGE.no_encontrado };

  const professionalId = changes.professionalId ?? actual.professionalId;
  const serviceId = changes.serviceId ?? actual.serviceId;

  const [professional, service] = await Promise.all([
    prisma.professional.findFirst({
      where: { id: professionalId, clinicId: clinic.id, active: true },
      include: { services: { select: { id: true } } },
    }),
    serviceId
      ? prisma.service.findFirst({ where: { id: serviceId, clinicId: clinic.id } })
      : Promise.resolve(null),
  ]);
  if (!professional || (changes.serviceId && !service)) {
    return { ok: false, reason: "no_encontrado", message: HARD_FAILURE_MESSAGE.no_encontrado };
  }

  // Día y hora: lo que no se cambió, se conserva en hora de pared de la clínica.
  const date = changes.date ?? clinicDateKey(actual.startTime, clinic.timezone);
  const time = changes.time ?? formatWallTime(actual.startTime, clinic.timezone);
  const start = aInstante(clinic.timezone, date, time);
  if (!start) return { ok: false, reason: "datos_invalidos", message: HARD_FAILURE_MESSAGE.datos_invalidos };

  // Duración: la pedida; si cambió el servicio, la del servicio nuevo; si no,
  // la que ya tenía. Mover una cita de hora no puede cambiarle cuánto dura.
  const duracionActual = Math.round((actual.endTime.getTime() - actual.startTime.getTime()) / 60000);
  const duracion =
    changes.durationMinutes ??
    (changes.serviceId && service ? service.durationMinutes : duracionActual);
  if (!duracionValida(duracion)) {
    return { ok: false, reason: "datos_invalidos", message: HARD_FAILURE_MESSAGE.datos_invalidos };
  }
  const end = addMinutes(start, duracion);

  const cambioElInstante =
    start.getTime() !== actual.startTime.getTime() || end.getTime() !== actual.endTime.getTime();
  const cambioElProfesional = professionalId !== actual.professionalId;

  let updated: Appointment;
  let forced: ForceableRule[] = [];
  try {
    updated = await prisma.$transaction(async (tx) => {
      const verdict = await evaluateSlot(tx, {
        clinic,
        patientId: actual.patientId,
        professional,
        service,
        start,
        end,
        // Ausente = conservar el espacio (se intenta el mismo primero).
        roomId: changes.roomId === undefined ? null : changes.roomId,
        excludeAppointmentId: actual.id,
        currentRoomId: changes.roomId === undefined ? actual.roomId : null,
        exigirServicioAsignado:
          cambioElProfesional || (Boolean(changes.serviceId) && changes.serviceId !== actual.serviceId),
        now: params.now ?? new Date(),
      });
      // Paquete: solo se vuelve a validar si cambió el paquete o el servicio.
      // Mover de hora una cita que ya estaba atada no tiene que fallar porque el
      // paquete se haya agotado con las demás: esta cita ya cuenta como suya.
      const packageId = changes.packageId === undefined ? actual.packageId : changes.packageId;
      const cambioPaquete = changes.packageId !== undefined && changes.packageId !== actual.packageId;
      const cambioServicio = Boolean(changes.serviceId) && changes.serviceId !== actual.serviceId;
      if (packageId && (cambioPaquete || cambioServicio)) {
        const link = await checkPackageLink(tx, {
          clinicId: clinic.id,
          patientId: actual.patientId,
          packageId,
          serviceId: service?.id ?? null,
          excludeAppointmentId: actual.id,
        });
        if (!link.ok) throw new HardError(link.reason);
        if (link.overbooked) verdict.violations.push(avisoPaqueteSinSesiones(link.capacity));
      }
      exigirConfirmacion(verdict, params.force === true);
      forced = verdict.violations.map((v) => v.rule);

      const modificada = await tx.appointment.update({
        where: { id: actual.id },
        data: {
          packageId,
          professionalId: professional.id,
          roomId: verdict.roomId,
          resourceId: verdict.resourceId,
          serviceId: service?.id ?? null,
          service: service?.name ?? actual.service,
          startTime: start,
          endTime: end,
          // Otra hora = otro recordatorio: si la cambió de horario, los avisos ya mandados no valen.
          ...(start.getTime() !== actual.startTime.getTime() ? { reminder24SentAt: null, reminder2hSentAt: null } : {}),
          preferredRoomUnavailable: verdict.preferredRoomUnavailable,
          // Lo que está forzado AHORA: si se arregló, se limpia.
          forcedRules: forced,
          modifiedByUserId: params.userId,
          modifiedAt: new Date(),
        },
      });

      // Qué le pasó a la cita, para los reportes. Cambiar la hora o el profesional es
      // REAGENDAR (la hora original queda en el evento: la fila la pisa); cambiar
      // solo el espacio, el servicio o la duración es EDITAR; si no cambió nada, no
      // hay evento.
      const cambios: string[] = [];
      if (modificada.roomId !== actual.roomId) cambios.push("espacio");
      if (modificada.service !== actual.service) cambios.push("servicio");
      if (modificada.endTime.getTime() - modificada.startTime.getTime() !== actual.endTime.getTime() - actual.startTime.getTime()) {
        cambios.push("duracion");
      }
      if (modificada.packageId !== actual.packageId) cambios.push("paquete");
      if (cambioElInstante || cambioElProfesional) {
        await recordAppointmentEvent(tx, {
          clinicId: clinic.id,
          appointmentId: actual.id,
          type: "reagendada",
          actorKind: "usuario",
          actorUserId: params.userId,
          fromStartTime: actual.startTime,
          toStartTime: modificada.startTime,
          fromProfessionalId: actual.professionalId,
          toProfessionalId: modificada.professionalId,
          details: cambios.length > 0 ? { tambienCambio: cambios } : undefined,
        });
      } else if (cambios.length > 0) {
        await recordAppointmentEvent(tx, {
          clinicId: clinic.id,
          appointmentId: actual.id,
          type: "editada",
          actorKind: "usuario",
          actorUserId: params.userId,
          details: { campos: cambios },
        });
      }
      return modificada;
    }, SERIALIZABLE);
  } catch (error) {
    const f = failure(error);
    if (f) return f;
    throw error;
  }

  // Espejo: el evento viejo se borra y se crea el nuevo (el profesional pudo
  // cambiar, y con él el calendario). Mismo criterio que el resto: si falla, se
  // loguea y no deshace el cambio.
  const cambioAlgoDelEvento =
    cambioElInstante ||
    cambioElProfesional ||
    updated.roomId !== actual.roomId ||
    updated.service !== actual.service;
  if (cambioAlgoDelEvento) {
    await desespejar({
      clinic,
      professionalId: actual.professionalId,
      googleEventId: actual.googleEventId,
    });
    const googleEventId = await espejar({
      clinic,
      appointment: updated,
      patientName: actual.patient.name ?? actual.patient.phone,
    });
    updated = await prisma.appointment.update({
      where: { id: updated.id },
      data: { googleEventId },
    });
  }

  // Al profesional nuevo hay que avisarle: la cita le apareció en la agenda.
  if (cambioElProfesional) {
    const room = await prisma.room.findUnique({ where: { id: updated.roomId }, select: { name: true } });
    await notifyProfessionalOfAppointment({
      clinic,
      professional,
      appointmentId: updated.id,
      startTime: updated.startTime,
      endTime: updated.endTime,
      service: updated.service,
      patientName: actual.patient.name ?? actual.patient.phone,
      roomName: room?.name ?? null,
      preferredRoomUnavailable: updated.preferredRoomUnavailable,
    });
  }

  let patientNotice: PatientNoticeResult | null = null;
  if (params.notifyPatient) {
    patientNotice = await notifyPatientOfChange({
      clinic,
      patient: actual.patient,
      kind: "modificada",
      service: updated.service,
      startTime: updated.startTime,
      professionalName: professional.name,
    });
  }

  return { ok: true, appointment: updated, forcedRules: forced, patientNotice };
}

// --- Cancelar ---

export type CancelResult =
  | { ok: true; patientNotice: PatientNoticeResult | null }
  | { ok: false; reason: "no_encontrado"; message: string };

export async function cancelAppointment(params: {
  clinic: ClinicWithCalendarAccount;
  userId: string;
  appointmentId: string;
  notifyPatient?: boolean;
  /** Por qué se cancela. Opcional: la asistente no siempre lo sabe. */
  reason?: unknown;
}): Promise<CancelResult> {
  const { clinic } = params;

  const actual = await prisma.appointment.findFirst({
    where: { id: params.appointmentId, clinicId: clinic.id, status: "confirmado" },
    include: { patient: true, professional: { select: { name: true } } },
  });
  if (!actual) return { ok: false, reason: "no_encontrado", message: HARD_FAILURE_MESSAGE.no_encontrado };

  // `updateMany` con el estado en el where: dos personas cancelando a la vez no
  // pueden avisar dos veces al paciente. El cambio y su evento van juntos: es lo que
  // alimenta el reporte de cancelaciones (quién, cuándo y por qué).
  const reason = cleanCancelReason(params.reason);
  const cancelada = await prisma.$transaction(async (tx) => {
    const ahora = new Date();
    const { count } = await tx.appointment.updateMany({
      where: { id: actual.id, clinicId: clinic.id, status: "confirmado" },
      data: {
        status: "cancelado",
        modifiedByUserId: params.userId,
        modifiedAt: ahora,
        cancelledAt: ahora,
        cancelledByKind: "clinica",
        cancelledByUserId: params.userId,
        cancelReason: reason,
      },
    });
    if (count === 0) return false;
    await recordAppointmentEvent(tx, {
      clinicId: clinic.id,
      appointmentId: actual.id,
      type: "cancelada",
      actorKind: "usuario",
      actorUserId: params.userId,
      reason,
      fromStartTime: actual.startTime,
    });
    return true;
  });
  if (!cancelada) return { ok: false, reason: "no_encontrado", message: HARD_FAILURE_MESSAGE.no_encontrado };

  await desespejar({
    clinic,
    professionalId: actual.professionalId,
    googleEventId: actual.googleEventId,
  });

  let patientNotice: PatientNoticeResult | null = null;
  if (params.notifyPatient) {
    patientNotice = await notifyPatientOfChange({
      clinic,
      patient: actual.patient,
      kind: "cancelada",
      service: actual.service,
      startTime: actual.startTime,
      professionalName: actual.professional.name,
    });
  }
  return { ok: true, patientNotice };
}

// --- Bloqueos manuales ---

export type BlockResult =
  | { ok: true; blocks: CalendarBlock[] }
  | { ok: false; reason: "datos_invalidos" | "no_encontrado"; message: string };

/**
 * Carga un bloqueo de la agenda de uno o más profesionales (reunión, almuerzo,
 * vacaciones): frena al asistente de WhatsApp igual que un evento importado de
 * Google. Se guarda UNO por profesional, con el mismo título.
 *
 * No valida contra las citas que ya existen en ese rato, igual que un evento
 * de Google Calendar: el bloqueo frena las NUEVAS, no cancela las ya agendadas.
 */
export async function createManualBlocks(params: {
  clinicId: string;
  timezone: string;
  userId: string;
  professionalIds: string[];
  title: string;
  date: string;
  /** HH:MM; sin hora y sin `endTime` no hay bloqueo. Con `allDay` se ignoran. */
  startTime?: string;
  endTime?: string;
  allDay?: boolean;
}): Promise<BlockResult> {
  const invalido = {
    ok: false as const,
    reason: "datos_invalidos" as const,
    message: HARD_FAILURE_MESSAGE.datos_invalidos,
  };

  const title = params.title.trim();
  if (!title || title.length > 120 || params.professionalIds.length === 0) return invalido;

  let start: Date | null;
  let end: Date | null;
  if (params.allDay) {
    start = aInstante(params.timezone, params.date, "00:00");
    const siguiente = start ? addMinutes(start, 24 * 60) : null;
    end = siguiente;
  } else {
    start = aInstante(params.timezone, params.date, params.startTime);
    end = aInstante(params.timezone, params.date, params.endTime);
  }
  if (!start || !end || end.getTime() <= start.getTime()) return invalido;

  const ids = [...new Set(params.professionalIds)];
  const profesionales = await prisma.professional.findMany({
    where: { id: { in: ids }, clinicId: params.clinicId },
    select: { id: true },
  });
  if (profesionales.length !== ids.length) {
    return { ok: false, reason: "no_encontrado", message: HARD_FAILURE_MESSAGE.no_encontrado };
  }

  const blocks = await prisma.$transaction(
    ids.map((professionalId) =>
      prisma.calendarBlock.create({
        data: {
          clinicId: params.clinicId,
          professionalId,
          // La columna se llama así por historia y exige un valor único por
          // profesional; para los manuales no hay evento externo.
          googleEventId: `manual:${crypto.randomUUID()}`,
          startTime: start!,
          endTime: end!,
          isAllDay: params.allDay === true,
          source: "manual",
          title,
          createdByUserId: params.userId,
        },
      })
    )
  );
  return { ok: true, blocks };
}

/** Mueve (o cambia de profesional) un bloqueo manual. Los importados no se tocan. */
export async function updateManualBlock(params: {
  clinicId: string;
  timezone: string;
  blockId: string;
  changes: {
    date?: string;
    startTime?: string;
    endTime?: string;
    professionalId?: string;
    title?: string;
  };
}): Promise<BlockResult> {
  const actual = await prisma.calendarBlock.findFirst({
    where: { id: params.blockId, clinicId: params.clinicId, source: "manual" },
  });
  if (!actual) {
    return { ok: false, reason: "no_encontrado", message: HARD_FAILURE_MESSAGE.no_encontrado };
  }
  const c = params.changes;

  if (c.professionalId) {
    const existe = await prisma.professional.findFirst({
      where: { id: c.professionalId, clinicId: params.clinicId },
      select: { id: true },
    });
    if (!existe) {
      return { ok: false, reason: "no_encontrado", message: HARD_FAILURE_MESSAGE.no_encontrado };
    }
  }

  const date = c.date ?? clinicDateKey(actual.startTime, params.timezone);
  const duracionMs = actual.endTime.getTime() - actual.startTime.getTime();
  const start = aInstante(params.timezone, date, c.startTime ?? formatWallTime(actual.startTime, params.timezone));
  const end = c.endTime
    ? aInstante(params.timezone, date, c.endTime)
    : start
      ? new Date(start.getTime() + duracionMs)
      : null;
  const title = c.title !== undefined ? c.title.trim() : actual.title;
  if (!start || !end || end.getTime() <= start.getTime() || !title) {
    return { ok: false, reason: "datos_invalidos", message: HARD_FAILURE_MESSAGE.datos_invalidos };
  }

  const block = await prisma.calendarBlock.update({
    where: { id: actual.id },
    data: {
      startTime: start,
      endTime: end,
      title,
      ...(c.professionalId ? { professionalId: c.professionalId } : {}),
    },
  });
  return { ok: true, blocks: [block] };
}

export async function deleteManualBlock(
  clinicId: string,
  blockId: string
): Promise<{ ok: boolean }> {
  // Solo los manuales: borrar uno importado no serviría de nada (el próximo
  // sync lo trae de vuelta) y confundiría.
  const { count } = await prisma.calendarBlock.deleteMany({
    where: { id: blockId, clinicId, source: "manual" },
  });
  return { ok: count > 0 };
}
