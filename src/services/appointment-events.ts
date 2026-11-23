import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client";

/**
 * Los eventos de la vida de una cita (`AppointmentEvent`): la fuente de los
 * reportes de citas creadas, reagendadas, canceladas y atendidas.
 *
 * **Se escribe con el mismo cliente de la transacción que hace el cambio** (`db`),
 * así no puede haber un cambio sin su evento ni un evento de algo que se revirtió.
 * A diferencia de `recordAudit`, esto SÍ puede lanzar: un reporte con huecos es peor
 * que un cambio que falla.
 *
 * Definiciones que los reportes dan por buenas:
 * - **`creada`**: una reserva nueva. **Reagendar no cuenta como crear.**
 * - **`reagendada`**: cambió la hora o el profesional. Por WhatsApp se da de baja la
 *   cita vieja y se crea una nueva: el evento va en la NUEVA y apunta a la vieja
 *   (`relatedAppointmentId`); la vieja queda con `cancelledByKind: "reprogramacion"`
 *   y sin evento de cancelación. **Mover una cita no es cancelarla.**
 * - **`editada`**: cambió otra cosa (el espacio, el servicio, la duración).
 * - **`cancelada`**: una cancelación REAL, con quién la hizo y, si se dio, el motivo.
 * - **`atendida` / `desmarcada`**: una persona confirmó, o deshizo, la asistencia; o el
 *   sistema la dio por atendida a las 24 horas (`actorKind: "sistema"`).
 */

export type AppointmentEventType = "creada" | "reagendada" | "editada" | "cancelada" | "atendida" | "desmarcada";

/** `paciente`: por WhatsApp. `usuario`: desde el panel. `sistema`: un job. */
export type AppointmentActorKind = "paciente" | "usuario" | "sistema";

type Db = Prisma.TransactionClient | typeof prisma;

export interface AppointmentEventInput {
  clinicId: string;
  appointmentId: string;
  type: AppointmentEventType;
  actorKind: AppointmentActorKind;
  actorUserId?: string | null;
  reason?: string | null;
  fromStartTime?: Date | null;
  toStartTime?: Date | null;
  fromProfessionalId?: string | null;
  toProfessionalId?: string | null;
  relatedAppointmentId?: string | null;
  /** Datos extra sin columna (qué campos cambió una edición). Nunca valores clínicos ni de contacto. */
  details?: Prisma.InputJsonValue | null;
  occurredAt?: Date;
}

export function recordAppointmentEvent(db: Db, e: AppointmentEventInput) {
  return db.appointmentEvent.create({
    data: {
      clinicId: e.clinicId,
      appointmentId: e.appointmentId,
      type: e.type,
      actorKind: e.actorKind,
      actorUserId: e.actorUserId ?? null,
      reason: e.reason?.trim() || null,
      fromStartTime: e.fromStartTime ?? null,
      toStartTime: e.toStartTime ?? null,
      fromProfessionalId: e.fromProfessionalId ?? null,
      toProfessionalId: e.toProfessionalId ?? null,
      relatedAppointmentId: e.relatedAppointmentId ?? null,
      details: e.details ?? undefined,
      ...(e.occurredAt ? { occurredAt: e.occurredAt } : {}),
    },
  });
}

/** El motivo de una cancelación: opcional, recortado, y vacío = ninguno. */
export const MAX_CANCEL_REASON = 200;
export function cleanCancelReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const limpio = value.replace(/\s+/g, " ").trim();
  return limpio ? limpio.slice(0, MAX_CANCEL_REASON) : null;
}

// --- El motivo de una cancelación que llega DESPUÉS ---

/** Cuánto tiempo después de cancelar se acepta que el paciente cuente el motivo. */
export const CANCEL_REASON_WINDOW_HOURS = 48;

export interface RecentCancellation {
  id: string;
  startTime: Date;
  service: string;
  professionalName: string;
}

/**
 * Las citas que estas personas cancelaron por WhatsApp hace poco y todavía no tienen
 * motivo. El asistente cancela SIN demorar y pregunta el motivo después, así que el
 * motivo suele llegar en el mensaje siguiente: esta lista es lo que le permite saber a
 * qué cancelación corresponde. Acotada por clínica y por las personas de ESE número.
 */
export function findRecentCancellationsWithoutReason(params: {
  clinicId: string;
  patientIds: string[];
  now?: Date;
}): Promise<RecentCancellation[]> {
  const now = params.now ?? new Date();
  const desde = new Date(now.getTime() - CANCEL_REASON_WINDOW_HOURS * 60 * 60 * 1000);
  return prisma.appointment
    .findMany({
      where: {
        clinicId: params.clinicId,
        patientId: { in: params.patientIds },
        status: "cancelado",
        // Solo las que canceló el paciente por WhatsApp: una reprogramación no es una
        // cancelación, y la de la clínica ya trae su motivo del panel.
        cancelledByKind: "paciente",
        cancelReason: null,
        cancelledAt: { gte: desde },
      },
      orderBy: { cancelledAt: "desc" },
      take: 5,
      select: { id: true, startTime: true, service: true, professional: { select: { name: true } } },
    })
    .then((rows) =>
      rows.map((r) => ({ id: r.id, startTime: r.startTime, service: r.service, professionalName: r.professional.name }))
    );
}

export type AttachReasonResult = { ok: true } | { ok: false; reason: "no_encontrada" };

/**
 * Le pone el motivo a una cancelación que ya ocurrió (el paciente lo contó en un mensaje
 * posterior). **Solo rellena**: si la cita ya tenía motivo no lo pisa, y solo sirve para
 * una cancelación del paciente de las últimas 48 horas, de una de las personas de ese
 * número y de esa clínica. El id lo escribe el modelo: nunca se confía en él solo.
 */
export async function attachCancellationReason(params: {
  clinicId: string;
  patientIds: string[];
  appointmentId: string;
  reason: unknown;
  isComplaint: boolean;
  now?: Date;
}): Promise<AttachReasonResult> {
  const reason = cleanCancelReason(params.reason);
  if (!reason) return { ok: false, reason: "no_encontrada" };
  const now = params.now ?? new Date();
  const desde = new Date(now.getTime() - CANCEL_REASON_WINDOW_HOURS * 60 * 60 * 1000);

  return prisma.$transaction(async (tx) => {
    // El UPDATE condicionado (`cancelReason: null`) es lo que impide pisar un motivo.
    const { count } = await tx.appointment.updateMany({
      where: {
        id: params.appointmentId,
        clinicId: params.clinicId,
        patientId: { in: params.patientIds },
        status: "cancelado",
        cancelledByKind: "paciente",
        cancelReason: null,
        cancelledAt: { gte: desde },
      },
      data: { cancelReason: reason },
    });
    if (count === 0) return { ok: false as const, reason: "no_encontrada" as const };

    const evento = await tx.appointmentEvent.findFirst({
      where: { appointmentId: params.appointmentId, type: "cancelada" },
      orderBy: { occurredAt: "desc" },
    });
    if (evento) {
      await tx.appointmentEvent.update({
        where: { id: evento.id },
        data: {
          reason,
          details: { ...((evento.details as Record<string, unknown> | null) ?? {}), motivoDespues: true, ...(params.isComplaint ? { queja: true } : {}) },
        },
      });
    }
    return { ok: true as const };
  });
}
