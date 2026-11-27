import { Prisma } from "@prisma/client";
import { recordAppointmentEvent } from "./appointment-events";
import { findPackageForBooking } from "./packages";
import { violatesLeadTime } from "./lead-time";
import type {
  Appointment,
  Clinic,
  GoogleAccount,
  MicrosoftAccount,
  Patient,
  Professional,
} from "@prisma/client";
import { prisma } from "../db/client";
import { checkAvailability, type UnavailableReason } from "./availability";
import { notifyProfessionalOfAppointment } from "./professional-notifications";
import type { ProfessionalNotifyFields } from "./professional-notifications";
import { resolveProfessionalForBooking } from "./booking-rules";
import { resolveServiceForRequest } from "./catalog";
import {
  mirrorAppointmentToCalendar,
  PROFESSIONAL_CALENDAR_INCLUDE,
  removeMirroredEvent,
  resolveCalendarTargetForProfessional,
} from "./calendar";
import { addMinutes, clinicWallTimeToUtc } from "./time";
import { checkClinicHours, checkWorkingHours, hasStructuredHours } from "./working-hours";

/**
 * Creación de turnos: la pieza que conecta lo que interpretó Claude con un
 * `Appointment` real en Postgres.
 *
 * Vive acá y no en el webhook para que el webhook quede como lo que es —
 * ruteo de mensajes — y porque esto se va a necesitar también desde el
 * dashboard cuando la clínica cargue un turno a mano.
 */

/** Motivos por los que un pedido de turno no se puede concretar. */
export type BookingFailureReason =
  | UnavailableReason
  | "fecha_u_hora_invalida" // Claude no devolvió fecha/hora, o vinieron mal
  | "fecha_en_el_pasado"
  /** Dentro del margen mínimo de anticipación que pide la clínica (`Clinic.minLeadMinutes`). */
  | "anticipacion_insuficiente"
  /** La clínica no tiene ningún tramo de horario cargado: no se puede agendar. */
  | "clinica_sin_horario"
  | "clinica_cerrada" // fuera del horario de atención, o en el corte de comida
  | "profesional_fuera_de_horario"
  | "sin_profesional_disponible"
  /** Nombró un servicio que la clínica no ofrece (y tiene catálogo cargado). */
  | "servicio_no_ofrecido"
  /** El servicio existe pero ningún profesional activo lo realiza. */
  | "servicio_sin_profesional"
  | "profesional_no_hace_servicio"
  /** Reprogramar: la cita a cambiar no existe, no es de esa persona o ya no está vigente. */
  | "turno_a_reprogramar_no_encontrado"
  /**
   * El asistente no agenda hasta tener el nombre y el apellido de la persona del turno (`agent-turn.ts`): se confirma primero
   * quién es, y recién después se dice que quedó agendada. Nunca lo devuelve `createAppointmentFromRequest()`.
   */
  | "falta_nombre_y_apellido"
  /** La misma persona ya tiene otra cita que se pisa con esta (no puede estar en dos lugares). */
  | "paciente_con_turno_superpuesto"
  | "conflicto_concurrente"; // dos pedidos simultáneos por el mismo hueco

export type BookingResult =
  | {
      ok: true;
      appointment: Appointment;
      professionalName: string;
      /** null si no había calendario enlazado, o si el espejo falló. */
      googleEventId: string | null;
      /** Se avisa aparte porque el turno SÍ se creó igual. */
      mirrorError: string | null;
      /** Si fue una reprogramación, el id de la cita que quedó cancelada. */
      replacedAppointmentId: string | null;
    }
  | { ok: false; reason: BookingFailureReason };

type ClinicForBooking = Clinic & {
  sharedCalendarAccount?: GoogleAccount | null;
  sharedCalendarMicrosoftAccount?: MicrosoftAccount | null;
};

/**
 * Crea un turno a partir de lo que interpretó Claude.
 *
 * El chequeo de disponibilidad y el `create` corren en la MISMA transacción
 * serializable. Si no, dos mensajes que llegan juntos pueden pasar los dos
 * el chequeo y quedar dos turnos en el mismo espacio físico — el
 * `checkAvailability` de uno no ve el turno que el otro está por insertar.
 *
 * El espejo en Google Calendar se hace DESPUÉS de cerrar la transacción, a
 * propósito: es una llamada de red a un servicio externo y no puede tener
 * una transacción de Postgres abierta esperándola. Si falla, el turno ya
 * está creado y válido — Postgres es la fuente de verdad, el calendario es
 * un espejo (ver CLAUDE.md).
 */
export async function createAppointmentFromRequest(params: {
  clinic: ClinicForBooking;
  patient: Patient;
  /** `fecha_solicitada` de Claude, YYYY-MM-DD. */
  requestedDate: string | null;
  /** `hora_solicitada` de Claude, HH:MM. */
  requestedTime: string | null;
  /** `servicio` de Claude, texto libre. */
  requestedService: string | null;
  requestedProfessionalId?: string | null;
  isUrgent?: boolean;
  /**
   * La campaña por la que llegó la persona (`services/campaigns.ts`). Hace dos cosas: la cita queda
   * atribuida a la campaña, y —si está vigente y el servicio es el de su promoción— se SUMAN a los
   * profesionales del servicio los que la campaña habilita.
   */
  campaignId?: string | null;
  /**
   * **Chat de pruebas** (`services/sandbox.ts`): la cita se crea igual, con todas sus reglas, pero NO salen los avisos
   * ni el espejo (el aviso al profesional por mail/WhatsApp y el evento en su Google Calendar). Una prueba no puede
   * mandarle un mensaje a un profesional real ni ensuciarle la agenda.
   */
  skipExternalEffects?: boolean;
  /**
   * Reprogramar: la cita vigente que este turno REEMPLAZA. Se cancela dentro de
   * la MISMA transacción que crea la nueva, por dos motivos: (1) si el hueco
   * nuevo se pisa con la propia cita vieja (9:00 → 9:30 con un turno de 45
   * minutos), tiene que dejar de contar como ocupado; (2) si la nueva no se
   * puede crear, la transacción se revierte y la vieja sigue vigente — nunca
   * se queda el paciente sin ninguna. Tiene que ser una cita de `patient`.
   */
  replaceAppointmentId?: string | null;
  /** Para poder testear sin depender del reloj. */
  now?: Date;
}): Promise<BookingResult> {
  const { clinic, patient } = params;

  if (!params.requestedDate || !params.requestedTime) {
    return { ok: false, reason: "fecha_u_hora_invalida" };
  }

  // La fecha y hora que dijo el paciente son hora de pared de la clínica,
  // no del servidor.
  const start = clinicWallTimeToUtc(
    params.requestedDate,
    params.requestedTime,
    clinic.timezone
  );
  if (!start) {
    return { ok: false, reason: "fecha_u_hora_invalida" };
  }

  const now = params.now ?? new Date();
  if (start.getTime() <= now.getTime()) {
    return { ok: false, reason: "fecha_en_el_pasado" };
  }
  // Después del pasado y antes de todo lo demás, igual que el enumerador de
  // huecos: lo mismo que no se ofrece, no se agenda.
  if (violatesLeadTime(start, now, clinic.minLeadMinutes ?? 0)) {
    return { ok: false, reason: "anticipacion_insuficiente" };
  }

  // La duración sale del catálogo si el servicio matchea; si no, del default
  // configurado en la clínica. Misma función que usa la enumeración de
  // huecos, para que el horario ofrecido dure lo mismo que el agendado.
  const resolved = await resolveServiceForRequest(
    clinic,
    params.requestedService,
    prisma,
    { patientId: patient.id, isUrgent: params.isUrgent, campaignId: params.campaignId }
  );
  const { service, durationMinutes, allowedProfessionalIds } = resolved;
  const end = addMinutes(start, durationMinutes);

  // Antes de abrir la transacción: no hay profesional que resolver si lo
  // pedido no es algo que la clínica hace, o si nadie lo realiza.
  if (resolved.notOffered) return { ok: false, reason: "servicio_no_ofrecido" };
  if (allowedProfessionalIds && allowedProfessionalIds.length === 0) {
    return { ok: false, reason: "servicio_sin_profesional" };
  }

  /**
   * **El horario es obligatorio.** Una clínica sin ningún tramo cargado no
   * puede agendar: antes se saltaba el chequeo y se aceptaban turnos a
   * cualquier hora (compatibilidad con las clínicas anteriores a
   * `WorkingHours`), y eso dejaba al asistente agendando a las 3 de la
   * madrugada sin que nada lo frenara. Ahora el alta exige el horario y esto lo
   * respalda: se rechaza con un motivo propio, y no con "clínica cerrada", que
   * mandaría a buscar un problema de horario donde lo que falta es el dato.
   * `config-health` ya lo marca como bloqueante y avisa a diario.
   */
  if (!(await hasStructuredHours(clinic.id))) {
    return { ok: false, reason: "clinica_sin_horario" };
  }

  let created: {
    appointment: Appointment;
    /** La cita que se reemplazó, con lo necesario para borrar su evento espejo. */
    replaced: {
      id: string;
      googleEventId: string | null;
      professional: Parameters<typeof resolveCalendarTargetForProfessional>[1];
      /** Para avisarle al profesional de la cita que se movió (cada uno elige canal y tipo de aviso). */
      aviso: { professional: ProfessionalNotifyFields; professionalId: string; startTime: Date; endTime: Date; service: string; roomId: string };
    } | null;
    professionalName: string;
    /** Se lee dentro de la transacción y se usa fuera, para avisarle del turno. */
    professional: ProfessionalNotifyFields;
  };

  try {
    created = await prisma.$transaction(
      async (tx) => {
        // Reprogramar: lo primero es dar de baja la cita vieja, adentro de la
        // transacción (ver `replaceAppointmentId`). Acotada por clínica Y por
        // persona: el id lo escribe el modelo.
        let replaced: {
          id: string;
          googleEventId: string | null;
          professional: Parameters<typeof resolveCalendarTargetForProfessional>[1];
          aviso: { professional: ProfessionalNotifyFields; professionalId: string; startTime: Date; endTime: Date; service: string; roomId: string };
          /** Para el evento de reagendado: de qué hora y con quién se movió. */
          startTime: Date;
          professionalId: string;
        } | null = null;
        if (params.replaceAppointmentId) {
          const vieja = await tx.appointment.findFirst({
            where: {
              id: params.replaceAppointmentId,
              clinicId: clinic.id,
              patientId: patient.id,
              status: "confirmado",
            },
            include: { professional: { include: PROFESSIONAL_CALENDAR_INCLUDE } },
          });
          if (!vieja) throw new BookingError("turno_a_reprogramar_no_encontrado");
          // Se da de baja porque el paciente la MOVIÓ, no porque cancelara: se marca
          // `reprogramacion` para que los reportes no la cuenten como cancelación.
          await tx.appointment.update({
            where: { id: vieja.id },
            data: { status: "cancelado", cancelledAt: new Date(), cancelledByKind: "reprogramacion" },
          });
          replaced = {
            id: vieja.id,
            googleEventId: vieja.googleEventId,
            professional: vieja.professional,
            aviso: {
              professional: vieja.professional,
              professionalId: vieja.professionalId,
              startTime: vieja.startTime,
              endTime: vieja.endTime,
              service: vieja.service,
              roomId: vieja.roomId,
            },
            startTime: vieja.startTime,
            professionalId: vieja.professionalId,
          };
        }

        // Una persona no puede tener dos citas que se pisan. Va después de dar
        // de baja la que se reprograma (esa ya no cuenta) y antes de todo lo
        // demás. Sin esto, "mejor con la Dra. X" sobre una cita recién agendada
        // creaba una SEGUNDA cita en vez de mover la primera (2026-11-06).
        const propia = await tx.appointment.findFirst({
          where: {
            clinicId: clinic.id,
            patientId: patient.id,
            status: "confirmado",
            startTime: { lt: end },
            endTime: { gt: start },
          },
          select: { id: true },
        });
        if (propia) throw new BookingError("paciente_con_turno_superpuesto");

        // Primero el horario de la CLÍNICA: no depende de qué profesional
        // atienda, y si está cerrada el motivo correcto es "cerrada", no
        // "ningún profesional disponible" — que es lo que saldría si se
        // resolviera el profesional antes, porque el criterio por default
        // descarta a todos los que no trabajan a esa hora.
        const clinicVerdict = await checkClinicHours(
          {
            clinicId: clinic.id,
            clinicTimezone: clinic.timezone,
            start,
            end,
          },
          tx
        );
        if (!clinicVerdict.ok) {
          throw new BookingError(clinicVerdict.reason);
        }

        const { professionalId } = await resolveProfessionalForBooking({
          clinic,
          requestedProfessionalId: params.requestedProfessionalId ?? null,
          start,
          end,
          enforceWorkingHours: true,
          allowedProfessionalIds,
          db: tx,
        });

        if (!professionalId) {
          throw new BookingError("sin_profesional_disponible");
        }

        // Última palabra, dentro de la transacción: sea cual sea el criterio
        // que lo eligió, quien atiende tiene que realizar el servicio.
        if (allowedProfessionalIds && !allowedProfessionalIds.includes(professionalId)) {
          throw new BookingError("profesional_no_hace_servicio");
        }

        // Y ahora el horario del profesional concreto. Hace falta incluso
        // después del filtro del criterio por default, porque un
        // profesional pedido explícitamente o el principal de la regla de
        // primera vez NO pasan por ese filtro.
        const verdict = await checkWorkingHours(
          {
            clinicId: clinic.id,
            clinicTimezone: clinic.timezone,
            professionalId,
            start,
            end,
          },
          tx
        );
        if (!verdict.ok) {
          throw new BookingError(verdict.reason);
        }

        // Se lee ANTES del chequeo porque de acá sale el espacio preferido,
        // que condiciona cuál se le asigna.
        const professional = await tx.professional.findFirst({
          where: { id: professionalId, clinicId: clinic.id },
          select: {
            name: true,
            preferredRoomId: true,
            contactEmail: true,
            whatsappPhone: true,
            notifyByEmail: true,
            notifyByWhatsapp: true,
            notifyOnCreate: true,
            notifyOnChange: true,
            notifyOnCancel: true,
          },
        });
        if (!professional) {
          // Puede pasar si se pidió un profesional de otra clínica.
          throw new BookingError("sin_profesional_disponible");
        }

        const availability = await checkAvailability({
          clinicId: clinic.id,
          professionalId,
          start,
          end,
          requiredResourceType: service?.requiredResourceType ?? null,
          preferredRoomId: professional.preferredRoomId,
          db: tx,
        });

        if (!availability.available || !availability.roomId) {
          throw new BookingError(availability.reason ?? "sin_espacios");
        }

        // Si la persona tiene un paquete de este servicio con sesiones libres, la
        // cita se ata a él: sin esto quien compró un paquete y agenda por
        // WhatsApp quedaría con una cita suelta que nunca descuenta nada ni le
        // aparece a la asistente. No agenda "de más": sin lugar en ningún
        // paquete, la cita se crea sin él.
        const packageId = await findPackageForBooking(tx, {
          clinicId: clinic.id,
          patientId: patient.id,
          serviceId: service?.id ?? null,
        });

        const appointment = await tx.appointment.create({
          data: {
            clinicId: clinic.id,
            patientId: patient.id,
            professionalId,
            roomId: availability.roomId,
            resourceId: availability.resourceId,
            serviceId: service?.id ?? null,
            packageId,
            // De qué campaña llegó quien sacó el turno (para los reportes). Solo si la campaña es de esta
            // clínica: el id lo arma nuestro código, pero no se confía a ciegas.
            campaignId: params.campaignId && (await tx.campaign.count({ where: { id: params.campaignId, clinicId: clinic.id } })) > 0 ? params.campaignId : null,
            // Si nació de reagendar otra, el vínculo con la vieja: es lo que permite
            // contar las reagendadas.
            rescheduledFromId: replaced?.id ?? null,
            // `service` en texto libre siempre está presente, incluso sin
            // catálogo cargado.
            service: service?.name ?? params.requestedService ?? "consulta",
            startTime: start,
            endTime: end,
            preferredRoomUnavailable: availability.preferredRoomUnavailable ?? false,
          },
        });

        // El evento, en la misma transacción: no hay cita sin su historia. Reagendar
        // NO cuenta como crear (los reportes de reservas nuevas no se inflan), y el
        // evento va en la cita NUEVA, apuntando a la vieja.
        await recordAppointmentEvent(
          tx,
          replaced
            ? {
                clinicId: clinic.id,
                appointmentId: appointment.id,
                type: "reagendada",
                actorKind: "paciente",
                fromStartTime: replaced.startTime,
                toStartTime: start,
                fromProfessionalId: replaced.professionalId,
                toProfessionalId: professionalId,
                relatedAppointmentId: replaced.id,
              }
            : {
                clinicId: clinic.id,
                appointmentId: appointment.id,
                type: "creada",
                actorKind: "paciente",
                toStartTime: start,
                toProfessionalId: professionalId,
              }
        );

        return { appointment, replaced, professionalName: professional.name, professional };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  } catch (error) {
    if (error instanceof BookingError) {
      return { ok: false, reason: error.reason };
    }
    // Postgres aborta una de las dos transacciones cuando detecta que se
    // pisan. No es un bug: el hueco lo ganó el otro pedido.
    if (isSerializationFailure(error)) {
      return { ok: false, reason: "conflicto_concurrente" };
    }
    throw error;
  }

  /**
   * --- Avisos y espejo, FUERA de la transacción ---
   *
   * Los dos son llamadas de red y no pueden tener una transacción de
   * Postgres abierta esperándolas. Si fallan, el turno ya está creado y es
   * válido.
   *
   * El aviso al profesional va primero porque es el que le importa a una
   * persona: que Google no refleje el evento se nota mucho después que no
   * enterarse de que tenés un paciente.
   */
  // Reprogramación: la cita vieja ya quedó cancelada en Postgres (fuente de
  // verdad); su evento espejo se borra acá, fuera de la transacción. Si falla,
  // se loguea: no puede deshacer el cambio.
  const replacedAppointmentId = created.replaced?.id ?? null;
  if (params.skipExternalEffects) {
    return { ...created, ok: true, googleEventId: null, mirrorError: null, replacedAppointmentId };
  }
  if (created.replaced?.googleEventId) {
    const viejoTarget = resolveCalendarTargetForProfessional(clinic, created.replaced.professional);
    if (viejoTarget) {
      try {
        await removeMirroredEvent(viejoTarget, created.replaced.googleEventId);
      } catch (error) {
        console.error(
          `No se pudo borrar el evento espejo de la cita reprogramada ${created.replaced.id}:`,
          error
        );
      }
    }
  }

  const espacio = await prisma.room.findUnique({
    where: { id: created.appointment.roomId },
    select: { name: true },
  });

  // Al profesional: si es una reprogramación con el mismo profesional, UNA sola novedad ("modificada") y no una baja más una
  // cita nueva; si cambió de profesional, al anterior se le avisa que ya no es suya y al nuevo que le apareció.
  const reprogramada = created.replaced !== null;
  const mismoProfesional = reprogramada && created.replaced!.aviso.professionalId === created.appointment.professionalId;
  if (created.replaced && !mismoProfesional) {
    const antes = created.replaced.aviso;
    const salaAntes = await prisma.room.findUnique({ where: { id: antes.roomId }, select: { name: true } });
    await notifyProfessionalOfAppointment({
      clinic,
      professional: antes.professional,
      evento: "cancelada",
      reasignada: true,
      appointmentId: created.replaced.id,
      startTime: antes.startTime,
      endTime: antes.endTime,
      service: antes.service,
      patientName: patient.name ?? patient.phone,
      roomName: salaAntes?.name ?? null,
      preferredRoomUnavailable: false,
    });
  }
  await notifyProfessionalOfAppointment({
    clinic,
    professional: created.professional,
    evento: mismoProfesional ? "modificada" : "agendada",
    appointmentId: created.appointment.id,
    startTime: created.appointment.startTime,
    endTime: created.appointment.endTime,
    service: created.appointment.service,
    patientName: patient.name ?? patient.phone,
    roomName: espacio?.name ?? null,
    preferredRoomUnavailable: created.appointment.preferredRoomUnavailable,
  });

  const professional = await prisma.professional.findUnique({
    where: { id: created.appointment.professionalId },
    include: PROFESSIONAL_CALENDAR_INCLUDE,
  });

  const target = professional
    ? resolveCalendarTargetForProfessional(clinic, professional)
    : null;

  if (!target) {
    // Sin calendario enlazado no hay espejo, y está bien: el turno vale.
    return { ...created, ok: true, googleEventId: null, mirrorError: null, replacedAppointmentId };
  }

  try {
    const [room, resource] = await Promise.all([
      prisma.room.findUnique({
        where: { id: created.appointment.roomId },
        select: { name: true },
      }),
      created.appointment.resourceId
        ? prisma.resource.findUnique({
            where: { id: created.appointment.resourceId },
            select: { name: true },
          })
        : Promise.resolve(null),
    ]);

    const googleEventId = await mirrorAppointmentToCalendar({
      target,
      appointmentId: created.appointment.id,
      clinicId: clinic.id,
      patientName: patient.name ?? patient.phone,
      professionalName: created.professionalName,
      service: created.appointment.service,
      startTime: created.appointment.startTime.toISOString(),
      endTime: created.appointment.endTime.toISOString(),
      roomName: room?.name ?? null,
      resourceName: resource?.name ?? null,
      timezone: clinic.timezone,
    });

    const appointment = await prisma.appointment.update({
      where: { id: created.appointment.id },
      data: { googleEventId },
    });

    return {
      ok: true,
      appointment,
      professionalName: created.professionalName,
      googleEventId,
      mirrorError: null,
      replacedAppointmentId,
    };
  } catch (error) {
    // El turno queda creado y sin googleEventId. El paciente ya tiene su
    // turno; lo que falta es que aparezca en la agenda del profesional.
    const mirrorError = error instanceof Error ? error.message : "Error desconocido";
    console.error(
      `Cita ${created.appointment.id} creado, pero falló el espejo en Calendar:`,
      error
    );
    return { ...created, ok: true, googleEventId: null, mirrorError, replacedAppointmentId };
  }
}

/** Error interno para cortar la transacción con un motivo tipado. */
class BookingError extends Error {
  constructor(public readonly reason: BookingFailureReason) {
    super(reason);
    this.name = "BookingError";
  }
}

/**
 * ¿Se abortó la transacción por conflicto con otra concurrente?
 *
 * Prisma no deja pasar el código nativo de Postgres (40001,
 * `serialization_failure`): lo traduce a `P2034`, "Transaction failed due to
 * a write conflict or a deadlock". Se chequean las dos formas porque el
 * código de Prisma es lo que llega en la práctica, y el texto crudo puede
 * aparecer si en algún momento se usa SQL directo.
 */
function isSerializationFailure(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  return (
    message.includes("40001") ||
    message.includes("could not serialize access") ||
    message.includes("write conflict or a deadlock")
  );
}

/**
 * Texto para el log cuando un pedido no se pudo concretar. El mensaje al
 * paciente lo escribe Claude, no esto — acá solo se explica el motivo
 * técnico para la auditoría.
 */
export function describeBookingFailure(reason: BookingFailureReason): string {
  switch (reason) {
    case "fecha_u_hora_invalida":
      return "No se pudo interpretar la fecha u hora pedida.";
    case "fecha_en_el_pasado":
      return "La fecha pedida ya pasó.";
    case "anticipacion_insuficiente":
      return "El horario pedido queda dentro del margen mínimo de anticipación que pide la clínica para reservar.";
    case "clinica_sin_horario":
      return "La clínica todavía no tiene cargado su horario de atención, así que no se puede agendar.";
    case "clinica_cerrada":
      return "La clínica no atiende en ese horario (o cae en el corte del mediodía).";
    case "profesional_fuera_de_horario":
      return "El profesional no atiende en ese horario.";
    case "profesional_ocupado":
      return "El profesional ya tiene otra cita en ese horario.";
    case "profesional_bloqueado":
      return "El profesional tiene bloqueada su agenda en ese horario.";
    case "sin_espacios":
      return "No hay ningún espacio físico libre en ese horario.";
    case "equipo_fuera_de_servicio":
      return "El equipo que requiere ese servicio está fuera de servicio.";
    case "sin_equipo":
      return "No hay una unidad libre del equipo que requiere el servicio.";
    case "sin_profesional_disponible":
      return "Ningún profesional está libre en ese horario.";
    case "servicio_no_ofrecido":
      return "El servicio pedido no figura entre los que ofrece la clínica.";
    case "servicio_sin_profesional":
      return "Ningún profesional activo tiene asignado ese servicio.";
    case "profesional_no_hace_servicio":
      return "El profesional elegido no realiza ese servicio.";
    case "falta_nombre_y_apellido":
      return "Falta el nombre y el apellido de la persona del turno.";
    case "turno_a_reprogramar_no_encontrado":
      return "La cita que se quería reprogramar no existe, no es de esa persona o ya no está vigente.";
    case "paciente_con_turno_superpuesto":
      return "Esa persona ya tiene otra cita que se pisa con ese horario. Si quiere cambiarla (de hora o de profesional), es una reprogramación de esa cita, no una cita nueva.";
    case "conflicto_concurrente":
      return "Otro pedido tomó ese horario al mismo tiempo.";
  }
}
