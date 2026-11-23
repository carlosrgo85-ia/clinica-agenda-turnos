import { Prisma, type Appointment, type Package } from "@prisma/client";
import { recordAppointmentEvent } from "./appointment-events";
import { prisma } from "../db/client";
import { updatePatientStage } from "../repositories/patients.repository";
import { addDaysToDateKey, clinicDateKey, clinicWallTimeToUtc } from "./time";

/**
 * Paquetes de sesiones prepagas (*"6 sesiones de láser"*).
 *
 * **La sesión se descuenta cuando UNA PERSONA de la clínica marca la cita como
 * atendida** (`markAppointmentAttended`), y no antes:
 *
 * - No al agendar: el paciente puede cancelar o no venir, y habría que acordarse
 *   de devolverla.
 * - No con `status: "atendido"`: ese estado lo pone solo el job
 *   `post-visit-followup` a las 24 horas de la cita, sin que nadie confirme que
 *   el paciente fue. Por eso la confirmación humana vive aparte
 *   (`Appointment.attendedAt`), y es lo único que mueve el saldo.
 *
 * Como confirmar es tocar el saldo prepago de alguien, es idempotente (marcar
 * dos veces no descuenta dos) y reversible (`unmarkAppointmentAttended` la
 * devuelve): un click equivocado no puede quedar para siempre.
 */

const SERIALIZABLE = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;

type Tx = Prisma.TransactionClient;

/** Hasta cuánto antes de la hora de inicio se puede marcar una cita como atendida. */
export const ATTEND_EARLY_MS = 60 * 60 * 1000;

export const MAX_PACKAGE_SESSIONS = 200;

export function isValidSessionCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_PACKAGE_SESSIONS;
}

export interface PackageCapacity {
  total: number;
  /** Ya descontadas: la persona confirmó que se cumplieron. */
  used: number;
  /** Citas atadas al paquete que todavía no se confirmaron (van a consumir una sesión). */
  reserved: number;
  /** Lo que queda para agendar: total − used − reserved. Puede ser negativo si se sobreagendó. */
  available: number;
}

/**
 * Cuántas sesiones quedan y cuántas están ya comprometidas con una cita.
 *
 * "Comprometida" = atada al paquete, no cancelada y sin confirmar. Incluye las
 * que ya pasaron y nadie marcó: siguen esperando que alguien las confirme.
 */
export async function packageCapacity(
  db: Tx | typeof prisma,
  pkg: Pick<Package, "id" | "totalSessions" | "usedSessions">,
  excludeAppointmentId?: string | null
): Promise<PackageCapacity> {
  const reserved = await db.appointment.count({
    where: {
      packageId: pkg.id,
      status: { not: "cancelado" },
      attendedAt: null,
      ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
    },
  });
  return {
    total: pkg.totalSessions,
    used: pkg.usedSessions,
    reserved,
    available: pkg.totalSessions - pkg.usedSessions - reserved,
  };
}

// --- Alta y edición ---

export type PackageFailure =
  | "plantilla_no_encontrada"
  | "nombre_duplicado"
  | "paciente_no_encontrado"
  | "servicio_requerido"
  | "servicio_no_encontrado"
  | "datos_invalidos"
  | "no_encontrado"
  | "menos_que_las_usadas";

export const PACKAGE_FAILURE_MESSAGE: Record<PackageFailure, string> = {
  plantilla_no_encontrada: "El paquete del catálogo no existe, es de otra clínica o está desactivado.",
  nombre_duplicado: "Ya hay un paquete en el catálogo con ese nombre.",
  paciente_no_encontrado: "El paciente no existe en esta clínica.",
  servicio_requerido: "Elige el servicio al que corresponde el paquete, de la lista de servicios de la clínica.",
  servicio_no_encontrado: "El servicio no existe en esta clínica o está desactivado.",
  datos_invalidos: `Indica el servicio y una cantidad de sesiones entera entre 1 y ${MAX_PACKAGE_SESSIONS}.`,
  no_encontrado: "No se encontró ese paquete en esta clínica.",
  menos_que_las_usadas:
    "El paquete no puede tener menos sesiones que las ya usadas (o agendadas sin confirmar).",
};

export type PackageResult<T> = { ok: true; value: T } | { ok: false; reason: PackageFailure; message: string };

function fail(reason: PackageFailure): { ok: false; reason: PackageFailure; message: string } {
  return { ok: false, reason, message: PACKAGE_FAILURE_MESSAGE[reason] };
}

export async function createPackage(params: {
  clinicId: string;
  userId: string;
  patientId: string;
  /**
   * **Obligatorio**: el servicio del catálogo de la clínica al que corresponde el
   * paquete. Sin él no hay forma de saber a qué citas aplicarlo (ni de atarlo
   * solo cuando se agenda por WhatsApp), así que se elige siempre de la lista.
   */
  serviceId?: string | null;
  totalSessions: unknown;
  notes?: string | null;
  /** Solo cuando se asigna desde el catálogo (`assignPackage`). */
  templateId?: string | null;
  /** El nombre con el que se vendió, copiado de la plantilla. */
  name?: string | null;
}): Promise<PackageResult<Package>> {
  if (!isValidSessionCount(params.totalSessions)) return fail("datos_invalidos");

  const patient = await prisma.patient.findFirst({
    where: { id: params.patientId, clinicId: params.clinicId },
    select: { id: true },
  });
  if (!patient) return fail("paciente_no_encontrado");

  if (!params.serviceId) return fail("servicio_requerido");
  // Activo: un servicio desactivado no se ofrece en ningún lado, así que un
  // paquete nuevo de él quedaría sin poder usarse.
  const service = await prisma.service.findFirst({
    where: { id: params.serviceId, clinicId: params.clinicId, active: true },
    select: { id: true, name: true },
  });
  if (!service) return fail("servicio_no_encontrado");

  const created = await prisma.package.create({
    data: {
      clinicId: params.clinicId,
      patientId: patient.id,
      serviceId: service.id,
      // El nombre del catálogo al momento de la compra: si después se renombra el
      // servicio, el paquete sigue diciendo lo que se vendió.
      serviceName: service.name,
      name: params.name?.trim() || null,
      templateId: params.templateId ?? null,
      totalSessions: params.totalSessions,
      notes: params.notes?.trim() || null,
      createdByUserId: params.userId,
    },
  });
  return { ok: true, value: created };
}

// --- Catálogo de paquetes (plantillas) ---

export interface PackageTemplateView {
  id: string;
  name: string;
  serviceId: string;
  serviceName: string;
  totalSessions: number;
  active: boolean;
  notes: string | null;
  /** A cuántos pacientes se asignó. */
  asignados: number;
}

const MAX_TEMPLATE_NAME = 80;

function toTemplateView(
  t: Prisma.PackageTemplateGetPayload<{ include: { service: { select: { name: true } }; _count: { select: { packages: true } } } }>
): PackageTemplateView {
  return {
    id: t.id,
    name: t.name,
    serviceId: t.serviceId,
    serviceName: t.service.name,
    totalSessions: t.totalSessions,
    active: t.active,
    notes: t.notes,
    asignados: t._count.packages,
  };
}

const TEMPLATE_INCLUDE = {
  service: { select: { name: true } },
  _count: { select: { packages: true } },
} as const;

export async function listPackageTemplates(params: {
  clinicId: string;
  onlyActive?: boolean;
}): Promise<PackageTemplateView[]> {
  const rows = await prisma.packageTemplate.findMany({
    where: { clinicId: params.clinicId, ...(params.onlyActive ? { active: true } : {}) },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: TEMPLATE_INCLUDE,
  });
  return rows.map(toTemplateView);
}

function esUnicidad(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Una plantilla nueva del catálogo. El servicio es obligatorio y tiene que ser
 * uno activo de la clínica, por lo mismo que lo es en cada paquete: sin él no hay
 * a qué citas aplicarlo.
 */
export async function createPackageTemplate(params: {
  clinicId: string;
  name: unknown;
  serviceId: unknown;
  totalSessions: unknown;
  notes?: string | null;
}): Promise<PackageResult<PackageTemplateView>> {
  const name = typeof params.name === "string" ? params.name.trim() : "";
  if (!name || name.length > MAX_TEMPLATE_NAME || !isValidSessionCount(params.totalSessions)) {
    return fail("datos_invalidos");
  }
  if (typeof params.serviceId !== "string" || !params.serviceId) return fail("servicio_requerido");

  const service = await prisma.service.findFirst({
    where: { id: params.serviceId, clinicId: params.clinicId, active: true },
    select: { id: true },
  });
  if (!service) return fail("servicio_no_encontrado");

  try {
    const creada = await prisma.packageTemplate.create({
      data: {
        clinicId: params.clinicId,
        name,
        serviceId: service.id,
        totalSessions: params.totalSessions,
        notes: params.notes?.trim() || null,
      },
      include: TEMPLATE_INCLUDE,
    });
    return { ok: true, value: toTemplateView(creada) };
  } catch (error) {
    if (esUnicidad(error)) return fail("nombre_duplicado");
    throw error;
  }
}

/**
 * Editar una plantilla **no toca los paquetes ya asignados**: los valores se
 * copiaron al asignarla. Lo único que cambia es lo que se le asigne de acá en
 * adelante.
 */
export async function updatePackageTemplate(params: {
  clinicId: string;
  templateId: string;
  name?: unknown;
  serviceId?: unknown;
  totalSessions?: unknown;
  active?: unknown;
  notes?: string | null;
}): Promise<PackageResult<PackageTemplateView>> {
  const actual = await prisma.packageTemplate.findFirst({
    where: { id: params.templateId, clinicId: params.clinicId },
  });
  if (!actual) return fail("plantilla_no_encontrada");

  const data: Prisma.PackageTemplateUpdateInput = {};
  if (params.name !== undefined) {
    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name || name.length > MAX_TEMPLATE_NAME) return fail("datos_invalidos");
    data.name = name;
  }
  if (params.totalSessions !== undefined) {
    if (!isValidSessionCount(params.totalSessions)) return fail("datos_invalidos");
    data.totalSessions = params.totalSessions;
  }
  if (params.serviceId !== undefined) {
    if (typeof params.serviceId !== "string" || !params.serviceId) return fail("servicio_requerido");
    const service = await prisma.service.findFirst({
      where: { id: params.serviceId, clinicId: params.clinicId, active: true },
      select: { id: true },
    });
    if (!service) return fail("servicio_no_encontrado");
    data.service = { connect: { id: service.id } };
  }
  if (params.active !== undefined) {
    if (typeof params.active !== "boolean") return fail("datos_invalidos");
    data.active = params.active;
  }
  if (params.notes !== undefined) data.notes = params.notes?.trim() || null;

  try {
    const actualizada = await prisma.packageTemplate.update({
      where: { id: actual.id },
      data,
      include: TEMPLATE_INCLUDE,
    });
    return { ok: true, value: toTemplateView(actualizada) };
  } catch (error) {
    if (esUnicidad(error)) return fail("nombre_duplicado");
    throw error;
  }
}

/**
 * Le asigna un paquete del catálogo a un paciente: **copia** el nombre, el
 * servicio y las sesiones. Es la forma de dar de alta un paquete (no hay que
 * armar uno nuevo por cada persona).
 */
export async function assignPackage(params: {
  clinicId: string;
  userId: string;
  patientId: string;
  templateId: unknown;
}): Promise<PackageResult<Package>> {
  if (typeof params.templateId !== "string" || !params.templateId) return fail("plantilla_no_encontrada");
  const plantilla = await prisma.packageTemplate.findFirst({
    where: { id: params.templateId, clinicId: params.clinicId, active: true },
  });
  if (!plantilla) return fail("plantilla_no_encontrada");

  return createPackage({
    clinicId: params.clinicId,
    userId: params.userId,
    patientId: params.patientId,
    serviceId: plantilla.serviceId,
    totalSessions: plantilla.totalSessions,
    notes: plantilla.notes,
    templateId: plantilla.id,
    name: plantilla.name,
  });
}

export async function updatePackage(params: {
  clinicId: string;
  packageId: string;
  totalSessions?: unknown;
  active?: boolean;
  notes?: string | null;
}): Promise<PackageResult<Package>> {
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const actual = await tx.package.findFirst({
        where: { id: params.packageId, clinicId: params.clinicId },
      });
      if (!actual) throw new PackageError("no_encontrado");

      const data: Prisma.PackageUpdateInput = {};
      if (params.notes !== undefined) data.notes = params.notes?.trim() || null;

      let total = actual.totalSessions;
      if (params.totalSessions !== undefined) {
        if (!isValidSessionCount(params.totalSessions)) throw new PackageError("datos_invalidos");
        const { used, reserved } = await packageCapacity(tx, actual);
        // Ni menos de las ya usadas (el CHECK lo impide) ni de las que ya están
        // comprometidas con una cita: quedaría una cita atada a una sesión que
        // no existe.
        if (params.totalSessions < used + reserved) throw new PackageError("menos_que_las_usadas");
        data.totalSessions = params.totalSessions;
        total = params.totalSessions;
      }

      // Se apaga/enciende a mano, pero un paquete agotado no puede quedar
      // activo ni uno con sesiones libres quedar apagado por haberse agotado.
      if (params.active !== undefined) data.active = params.active;
      else if (params.totalSessions !== undefined) data.active = actual.usedSessions < total;

      return tx.package.update({ where: { id: actual.id }, data });
    }, SERIALIZABLE);
    return { ok: true, value: updated };
  } catch (error) {
    if (error instanceof PackageError) return fail(error.reason);
    throw error;
  }
}

class PackageError extends Error {
  constructor(public reason: PackageFailure) {
    super(reason);
  }
}

export type PackageView = Package & { capacity: PackageCapacity; patient: { name: string | null; phone: string } };

/** Los paquetes de la clínica (o de un paciente), con lo que les queda. */
export async function listPackages(params: {
  clinicId: string;
  patientId?: string;
  /** Solo los que todavía tienen sesiones y están activos. */
  onlyActive?: boolean;
  /** Solo los de este servicio (o los que no están atados a ninguno). */
  serviceId?: string | null;
}): Promise<PackageView[]> {
  const rows = await prisma.package.findMany({
    where: {
      clinicId: params.clinicId,
      ...(params.patientId ? { patientId: params.patientId } : {}),
      ...(params.onlyActive ? { active: true } : {}),
      ...(params.serviceId ? { OR: [{ serviceId: params.serviceId }, { serviceId: null }] } : {}),
    },
    orderBy: [{ active: "desc" }, { purchasedAt: "desc" }],
    include: { patient: { select: { name: true, phone: true } } },
  });
  return Promise.all(rows.map(async (p) => ({ ...p, capacity: await packageCapacity(prisma, p) })));
}

// --- Atar una cita a un paquete ---

export type PackageLinkFailure =
  | "paquete_no_encontrado"
  | "paquete_inactivo"
  | "paquete_de_otro_servicio";

export type PackageLinkVerdict =
  | { ok: true; package: Package; capacity: PackageCapacity; overbooked: boolean }
  | { ok: false; reason: PackageLinkFailure };

/**
 * ¿Se puede atar esta cita a este paquete? Corre dentro de la transacción de la
 * cita.
 *
 * Duras (la cita no se crea): el paquete tiene que ser de ESTE paciente y de
 * esta clínica —no existe para otro, y se responde igual que si no existiera—,
 * estar activo, y ser del mismo servicio si está atado a uno.
 *
 * Blanda (`overbooked`): ya no le quedan sesiones sin comprometer. La Agenda lo
 * trata como una regla que se puede confirmar (hay clínicas que agendan de
 * más, o van a cargar más sesiones), pero hay que avisarlo.
 */
export async function checkPackageLink(
  tx: Tx,
  params: {
    clinicId: string;
    patientId: string;
    packageId: string;
    serviceId: string | null;
    excludeAppointmentId?: string | null;
  }
): Promise<PackageLinkVerdict> {
  const pkg = await tx.package.findFirst({
    where: { id: params.packageId, clinicId: params.clinicId, patientId: params.patientId },
  });
  if (!pkg) return { ok: false, reason: "paquete_no_encontrado" };
  if (!pkg.active) return { ok: false, reason: "paquete_inactivo" };
  if (pkg.serviceId && pkg.serviceId !== params.serviceId) {
    return { ok: false, reason: "paquete_de_otro_servicio" };
  }
  const capacity = await packageCapacity(tx, pkg, params.excludeAppointmentId);
  return { ok: true, package: pkg, capacity, overbooked: capacity.available <= 0 };
}

/**
 * El paquete con el que se agenda automáticamente (el asistente de WhatsApp):
 * el más antiguo, activo, atado a este mismo servicio y con sesiones sin
 * comprometer.
 *
 * Sin esto, quien tiene un paquete y agenda por WhatsApp quedaría con una cita
 * suelta que nunca descuenta nada. **No agenda de más**: si no queda lugar en
 * ningún paquete, devuelve null y la cita se crea sin paquete (la asistente
 * decide qué hacer al verla).
 */
export async function findPackageForBooking(
  tx: Tx,
  params: { clinicId: string; patientId: string; serviceId: string | null }
): Promise<string | null> {
  if (!params.serviceId) return null;
  const candidatos = await tx.package.findMany({
    where: {
      clinicId: params.clinicId,
      patientId: params.patientId,
      active: true,
      // Solo los atados a ESTE servicio. Un paquete sin servicio (cargado a mano)
      // no se ata solo: no hay forma de saber si es de esto o de otra cosa, y
      // descontarle una sesión de láser a un paquete de limpiezas es peor que
      // dejar la cita suelta. La asistente lo ata a mano desde la Agenda.
      serviceId: params.serviceId,
    },
    orderBy: { purchasedAt: "asc" },
  });
  for (const pkg of candidatos) {
    if ((await packageCapacity(tx, pkg)).available > 0) return pkg.id;
  }
  return null;
}

// --- Marcar como atendida ---

export type AttendFailure =
  | "no_encontrado"
  | "cita_cancelada"
  | "todavia_no_es_la_hora"
  | "paquete_sin_sesiones"
  | "no_estaba_atendida";

export const ATTEND_FAILURE_MESSAGE: Record<AttendFailure, string> = {
  no_encontrado: "No se encontró esa cita en esta clínica.",
  cita_cancelada: "La cita está cancelada: no se puede marcar como atendida.",
  todavia_no_es_la_hora:
    "Todavía falta mucho para esa cita. Se puede marcar como atendida desde una hora antes de su inicio.",
  paquete_sin_sesiones:
    "El paquete ya usó todas sus sesiones: no se puede descontar otra. Sube la cantidad de sesiones del paquete o desata la cita de él.",
  no_estaba_atendida: "Esa cita no estaba marcada como atendida.",
};

export type AttendResult =
  | {
      ok: true;
      appointment: Appointment;
      /** Se descontó una sesión de este paquete. */
      package: Package | null;
      /** Ya estaba marcada: no se descontó nada. */
      yaEstabaMarcada: boolean;
    }
  | { ok: false; reason: AttendFailure; message: string };

function attendFail(reason: AttendFailure): { ok: false; reason: AttendFailure; message: string } {
  return { ok: false, reason, message: ATTEND_FAILURE_MESSAGE[reason] };
}

class AttendError extends Error {
  constructor(public reason: AttendFailure) {
    super(reason);
  }
}

/**
 * Una persona confirma que la cita se cumplió. Si está atada a un paquete,
 * descuenta una sesión.
 *
 * Idempotente: marcar una cita ya marcada no descuenta otra vez. El descuento es
 * un UPDATE condicionado (`usedSessions < totalSessions`) dentro de una
 * transacción serializable, así que dos personas confirmando a la vez no pueden
 * pasarse del total.
 */
export async function markAppointmentAttended(params: {
  clinicId: string;
  appointmentId: string;
  userId: string;
  now?: Date;
}): Promise<AttendResult> {
  const now = params.now ?? new Date();
  try {
    const result = await prisma.$transaction(async (tx) => {
      const cita = await tx.appointment.findFirst({
        where: { id: params.appointmentId, clinicId: params.clinicId },
      });
      if (!cita) throw new AttendError("no_encontrado");
      if (cita.status === "cancelado") throw new AttendError("cita_cancelada");

      if (cita.attendedAt) {
        const pkg = cita.packageId
          ? await tx.package.findUnique({ where: { id: cita.packageId } })
          : null;
        return { appointment: cita, package: pkg, yaEstabaMarcada: true };
      }

      if (cita.startTime.getTime() - now.getTime() > ATTEND_EARLY_MS) {
        throw new AttendError("todavia_no_es_la_hora");
      }

      let pkg: Package | null = null;
      if (cita.packageId) {
        // Condicionado: nunca más sesiones usadas que compradas.
        const { count } = await tx.package.updateMany({
          where: { id: cita.packageId, clinicId: params.clinicId, usedSessions: { lt: tx.package.fields.totalSessions } },
          data: { usedSessions: { increment: 1 } },
        });
        if (count === 0) throw new AttendError("paquete_sin_sesiones");
        pkg = await tx.package.findUniqueOrThrow({ where: { id: cita.packageId } });
        // Agotado: se apaga solo.
        if (pkg.usedSessions >= pkg.totalSessions && pkg.active) {
          pkg = await tx.package.update({ where: { id: pkg.id }, data: { active: false } });
        }
      }

      const appointment = await tx.appointment.update({
        where: { id: cita.id },
        data: { attendedAt: now, attendedByUserId: params.userId, status: "atendido" },
      });
      // Quién confirmó la asistencia, y cuándo: alimenta el reporte de atendidos.
      await recordAppointmentEvent(tx, {
        clinicId: params.clinicId,
        appointmentId: cita.id,
        type: "atendida",
        actorKind: "usuario",
        actorUserId: params.userId,
        occurredAt: now,
        details: pkg ? { descontoSesion: true } : undefined,
      });
      return { appointment, package: pkg, yaEstabaMarcada: false };
    }, SERIALIZABLE);

    // CRM: la misma etapa que pone el job de seguimiento, pero ahora porque una
    // persona lo confirmó. Fuera de la transacción: no es parte del saldo.
    if (!result.yaEstabaMarcada) {
      await updatePatientStage(result.appointment.patientId, "atendido", {
        origin: "panel",
        userId: params.userId,
        motivo: "asistencia_confirmada",
      }).catch((error) => {
        console.error(`No se pudo actualizar la etapa del paciente ${result.appointment.patientId}:`, error);
      });
    }
    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof AttendError) return attendFail(error.reason);
    throw error;
  }
}

/**
 * Deshace "atendida": devuelve la sesión y la cita vuelve a estar confirmada.
 * Es la salida para un click equivocado, y por eso existe: descontar sin poder
 * revertir dejaría a la clínica editando la base a mano.
 */
export async function unmarkAppointmentAttended(params: {
  clinicId: string;
  appointmentId: string;
  /** Quién lo deshace, para el evento. */
  userId?: string | null;
}): Promise<AttendResult> {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const cita = await tx.appointment.findFirst({
        where: { id: params.appointmentId, clinicId: params.clinicId },
      });
      if (!cita) throw new AttendError("no_encontrado");
      if (!cita.attendedAt) throw new AttendError("no_estaba_atendida");

      let pkg: Package | null = null;
      if (cita.packageId) {
        const { count } = await tx.package.updateMany({
          where: { id: cita.packageId, usedSessions: { gt: 0 } },
          data: { usedSessions: { decrement: 1 } },
        });
        if (count > 0) {
          pkg = await tx.package.findUniqueOrThrow({ where: { id: cita.packageId } });
          // Si se había agotado, vuelve a tener una sesión: se reactiva. (Si
          // alguien lo apagó a mano estando agotado, esto lo reactiva igual: no
          // hay forma de distinguirlos sin otro campo.)
          if (!pkg.active && pkg.usedSessions < pkg.totalSessions) {
            pkg = await tx.package.update({ where: { id: pkg.id }, data: { active: true } });
          }
        }
      }

      const appointment = await tx.appointment.update({
        where: { id: cita.id },
        data: { attendedAt: null, attendedByUserId: null, status: "confirmado" },
      });
      await recordAppointmentEvent(tx, {
        clinicId: params.clinicId,
        appointmentId: cita.id,
        type: "desmarcada",
        actorKind: "usuario",
        actorUserId: params.userId ?? null,
        details: pkg ? { devolvioSesion: true } : undefined,
      });
      return { appointment, package: pkg, yaEstabaMarcada: false };
    }, SERIALIZABLE);
    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof AttendError) return attendFail(error.reason);
    throw error;
  }
}

// --- El aviso de la asistente ---

export interface PendingPackageAppointment {
  id: string;
  startTime: Date;
  endTime: Date;
  service: string;
  patient: { id: string; name: string | null; phone: string };
  professional: { name: string };
  package: { id: string; serviceName: string; totalSessions: number; usedSessions: number };
}

/**
 * Las citas que vienen (o vinieron) por un paquete y nadie marcó como atendidas.
 * Es lo que se le muestra a la asistente al entrar, para que no se olvide: si
 * no marca la cita, la sesión no se descuenta y el paciente cree que le quedan
 * más de las que le quedan.
 *
 * - `hoy`: las de hoy en la clínica (hora de pared de la clínica, no del
 *   servidor), incluidas las que todavía no pasaron: el aviso sirve para
 *   saber quién llega.
 * - `atrasadas`: de días anteriores, sin confirmar. Son las que se olvidan.
 *
 * No depende de `status`: el job de seguimiento pone "atendido" solo a las 24
 * horas, y una cita en ese estado sin `attendedAt` sigue pendiente.
 */
export async function listPendingPackageAppointments(params: {
  clinicId: string;
  timezone: string;
  now?: Date;
}): Promise<{ hoy: PendingPackageAppointment[]; atrasadas: PendingPackageAppointment[] }> {
  const now = params.now ?? new Date();
  const hoyKey = clinicDateKey(now, params.timezone);
  const mananaKey = addDaysToDateKey(hoyKey, 1);
  const inicioHoy = clinicWallTimeToUtc(hoyKey, "00:00", params.timezone);
  const inicioManana = mananaKey ? clinicWallTimeToUtc(mananaKey, "00:00", params.timezone) : null;
  if (!inicioHoy || !inicioManana) return { hoy: [], atrasadas: [] };

  const rows = await prisma.appointment.findMany({
    where: {
      clinicId: params.clinicId,
      packageId: { not: null },
      attendedAt: null,
      status: { not: "cancelado" },
      startTime: { lt: inicioManana },
    },
    orderBy: { startTime: "asc" },
    select: {
      id: true,
      startTime: true,
      endTime: true,
      service: true,
      patient: { select: { id: true, name: true, phone: true } },
      professional: { select: { name: true } },
      package: { select: { id: true, serviceName: true, totalSessions: true, usedSessions: true } },
    },
  });

  const citas = rows.filter((r): r is typeof r & { package: NonNullable<typeof r.package> } => r.package !== null);
  return {
    hoy: citas.filter((r) => r.startTime.getTime() >= inicioHoy.getTime()),
    atrasadas: citas.filter((r) => r.startTime.getTime() < inicioHoy.getTime()),
  };
}
