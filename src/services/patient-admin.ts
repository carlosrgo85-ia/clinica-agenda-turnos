import type { Patient, Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { MAX_AUTHORIZED_PHONES, normalizarNombre } from "../repositories/patients.repository";
import { normalizeWhatsAppNumber } from "./phone";
import { listPackages, type PackageView } from "./packages";
import { dateKeyToUtcMidnight } from "./time";

/**
 * El módulo de pacientes: la ficha que ve el personal (datos, observaciones,
 * comentarios, historial, paquetes y próxima cita sugerida).
 *
 * **`Patient.name` sigue siendo el nombre completo y el dato canónico**: lo usa
 * el asistente, los avisos, la búsqueda y la detección de duplicados. Acá se
 * edita en dos campos (nombre y apellido) y `name` se recalcula desde ellos. Las
 * fichas que crea el asistente por WhatsApp traen solo `name`; para mostrarlas
 * partidas se parte al leer (`patientNameParts()`) sin escribir nada.
 */

export const MAX_OBSERVATIONS = 2000;
export const MAX_COMMENT = 2000;
export const MAX_NEXT_VISIT_NOTE = 200;
export const MAX_NAME_PART = 80;

// --- Nombre y apellido ---

/**
 * Parte un nombre completo: la primera palabra es el nombre y el resto el
 * apellido. **Es una heurística y se equivoca** con nombres compuestos ("Ana
 * María García") o apellidos con partículas ("de la Cruz"); por eso solo se usa
 * para MOSTRAR fichas que no tienen las partes guardadas, y el personal las
 * corrige desde la ficha.
 */
export function splitFullName(name: string | null | undefined): { firstName: string; lastName: string } {
  const limpio = (name ?? "").trim().replace(/\s+/g, " ");
  if (!limpio) return { firstName: "", lastName: "" };
  const i = limpio.indexOf(" ");
  return i === -1
    ? { firstName: limpio, lastName: "" }
    : { firstName: limpio.slice(0, i), lastName: limpio.slice(i + 1) };
}

/** Las partes guardadas, o las que salen de partir `name` si la ficha no las tiene. */
export function patientNameParts(p: Pick<Patient, "name" | "firstName" | "lastName">): {
  firstName: string;
  lastName: string;
} {
  if (p.firstName !== null || p.lastName !== null) {
    return { firstName: p.firstName ?? "", lastName: p.lastName ?? "" };
  }
  return splitFullName(p.name);
}

export function joinFullName(firstName: string, lastName: string): string {
  return `${firstName.trim()} ${lastName.trim()}`.replace(/\s+/g, " ").trim();
}

/**
 * El nombre de una persona que se da de alta a mano (Agenda): **nombre y apellido, los dos** (decidido el 2026-11-21: con una sola
 * palabra se dejaba pasar y la ficha quedaba sin apellido, igual que por WhatsApp, donde el asistente no agenda sin los dos).
 * Acepta las partes por separado (`firstName` + `lastName`, lo que manda la pantalla: se guardan tal cual) o el nombre completo
 * (`name`, que tiene que traer al menos dos palabras: se parte con la heurística de `splitFullName`, que se equivoca con nombres
 * compuestos, y por eso la pantalla manda las partes).
 */
export type NewPatientName =
  | { ok: true; name: string; firstName: string | null; lastName: string | null }
  | { ok: false; error: string };

export function validateNewPatientName(input: { name?: unknown; firstName?: unknown; lastName?: unknown }): NewPatientName {
  const txt = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");
  const firstName = txt(input.firstName);
  const lastName = txt(input.lastName);

  if (firstName || lastName) {
    if (!firstName || !lastName) {
      return { ok: false, error: `Falta ${!firstName ? "el nombre" : "el apellido"}: indica nombre y apellido.` };
    }
    if (firstName.length > MAX_NAME_PART || lastName.length > MAX_NAME_PART) {
      return { ok: false, error: `El nombre y el apellido pueden tener hasta ${MAX_NAME_PART} caracteres cada uno.` };
    }
    return { ok: true, name: joinFullName(firstName, lastName), firstName, lastName };
  }

  const name = txt(input.name);
  if (!name) return { ok: false, error: "Indica el nombre y el apellido del paciente." };
  if (name.split(" ").length < 2) {
    return { ok: false, error: "Indica nombre y apellido: con una sola palabra no alcanza." };
  }
  if (name.length > 2 * MAX_NAME_PART + 1) return { ok: false, error: "El nombre es demasiado largo." };
  return { ok: true, name, firstName: null, lastName: null };
}

// --- Fechas ---

/**
 * "YYYY-MM-DD" → medianoche UTC, rechazando los días imposibles (`2030-02-31`):
 * `dateKeyToUtcMidnight()` los corre en silencio al mes siguiente, y una próxima
 * cita sugerida mal tipeada contactaría al paciente en otra fecha.
 */
export function parseDateKey(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = dateKeyToUtcMidnight(value);
  if (!date || date.toISOString().slice(0, 10) !== value) return null;
  return date;
}

export const dateKeyOf = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

// --- Resultados ---

export type PatientFailure =
  | "no_encontrado"
  | "datos_invalidos"
  | "telefono_invalido"
  | "nombre_duplicado";

export const PATIENT_FAILURE_MESSAGE: Record<PatientFailure, string> = {
  no_encontrado: "No se encontró ese paciente en esta clínica.",
  datos_invalidos: "Hay algún dato inválido: revisa el nombre, las fechas y los largos de los textos.",
  telefono_invalido: "El teléfono tiene que incluir el código de país (por lo menos 8 dígitos).",
  nombre_duplicado:
    "Ya hay otra persona con ese nombre en ese mismo WhatsApp: el asistente no podría distinguirlas.",
};

export type PatientResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: PatientFailure; message: string };

function fail(reason: PatientFailure): { ok: false; reason: PatientFailure; message: string } {
  return { ok: false, reason, message: PATIENT_FAILURE_MESSAGE[reason] };
}

// --- Vistas ---

export interface PatientRow {
  id: string;
  phone: string;
  name: string | null;
  firstName: string;
  lastName: string;
  /**
   * Nombre y apellido salieron de PARTIR el nombre completo (la ficha la creó el asistente sin
   * separarlos): es una heurística y se equivoca con nombres compuestos, así que la pantalla pide
   * revisarlos. Se apaga solo al guardar las partes.
   */
  nameInferred: boolean;
  stage: string;
  suggestedNextVisitDate: string | null;
  suggestedNextVisitNote: string | null;
  outreachOptOut: boolean;
  /** Otros WhatsApp autorizados a consultar sus citas. */
  authorizedPhones: string[];
  /** Cuándo se le escribió por esta sugerencia, si ya se hizo. */
  outreachSentAt: string | null;
  /** La próxima cita confirmada, si tiene. */
  nextAppointmentAt: string | null;
  /** La última que se cumplió. */
  lastVisitAt: string | null;
  activePackages: number;
}

function toRow(
  p: Patient & {
    appointments: Array<{ startTime: Date; status: string; attendedAt: Date | null }>;
    _count: { packages: number };
  },
  now: Date
): PatientRow {
  const futuras = p.appointments
    .filter((a) => a.status === "confirmado" && a.startTime >= now)
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  const cumplidas = p.appointments
    .filter((a) => a.status === "atendido" || a.attendedAt)
    .sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
  return {
    id: p.id,
    phone: p.phone,
    name: p.name,
    ...patientNameParts(p),
    nameInferred: p.firstName === null && p.lastName === null && (p.name ?? "").trim().split(/\s+/).length >= 2,
    stage: p.stage,
    suggestedNextVisitDate: dateKeyOf(p.suggestedNextVisitDate),
    suggestedNextVisitNote: p.suggestedNextVisitNote,
    outreachOptOut: p.outreachOptOut,
    authorizedPhones: p.authorizedPhones,
    outreachSentAt: p.nextVisitOutreachSentAt?.toISOString() ?? null,
    nextAppointmentAt: futuras[0]?.startTime.toISOString() ?? null,
    lastVisitAt: cumplidas[0]?.startTime.toISOString() ?? null,
    activePackages: p._count.packages,
  };
}

export async function listPatients(params: {
  clinicId: string;
  /** Nombre, apellido o teléfono (parcial). */
  q?: string;
  /** Solo los que tienen próxima cita sugerida entre estas fechas (YYYY-MM-DD, inclusive). */
  suggestedFrom?: string;
  suggestedTo?: string;
  /** Solo los que tienen alguna próxima cita sugerida. */
  withSuggestion?: boolean;
  limit?: number;
  offset?: number;
  now?: Date;
}): Promise<PatientResult<{ pacientes: PatientRow[]; total: number }>> {
  const now = params.now ?? new Date();
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);

  const from = params.suggestedFrom ? parseDateKey(params.suggestedFrom) : null;
  const to = params.suggestedTo ? parseDateKey(params.suggestedTo) : null;
  if ((params.suggestedFrom && !from) || (params.suggestedTo && !to)) return fail("datos_invalidos");

  const q = params.q?.trim() ?? "";
  const digitos = q.replace(/\D/g, "");
  const where: Prisma.PatientWhereInput = {
    clinicId: params.clinicId,
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { firstName: { contains: q, mode: "insensitive" } },
            { lastName: { contains: q, mode: "insensitive" } },
            ...(digitos.length >= 3 ? [{ phone: { contains: digitos } }] : []),
          ],
        }
      : {}),
    ...(from || to
      ? { suggestedNextVisitDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : params.withSuggestion
        ? { suggestedNextVisitDate: { not: null } }
        : {}),
  };

  const [filas, total] = await Promise.all([
    prisma.patient.findMany({
      where,
      // Con filtro de sugerencia, lo más próximo primero: es una lista de trabajo.
      orderBy:
        from || to || params.withSuggestion
          ? [{ suggestedNextVisitDate: "asc" }, { name: "asc" }]
          : [{ name: "asc" }, { createdAt: "asc" }],
      take: limit,
      skip: offset,
      include: {
        appointments: { select: { startTime: true, status: true, attendedAt: true } },
        _count: { select: { packages: { where: { active: true } } } },
      },
    }),
    prisma.patient.count({ where }),
  ]);

  return { ok: true, value: { pacientes: filas.map((p) => toRow(p, now)), total } };
}

export interface PatientDetail {
  paciente: PatientRow & { observations: string | null; createdAt: string };
  comentarios: Array<{ id: string; authorName: string; text: string; createdAt: string }>;
  citas: Array<{
    id: string;
    startTime: string;
    service: string;
    status: string;
    professional: string;
    attendedAt: string | null;
    package: { serviceName: string } | null;
  }>;
  paquetes: PackageView[];
}

export async function getPatientDetail(params: {
  clinicId: string;
  patientId: string;
  now?: Date;
}): Promise<PatientResult<PatientDetail>> {
  const now = params.now ?? new Date();
  const p = await prisma.patient.findFirst({
    where: { id: params.patientId, clinicId: params.clinicId },
    include: {
      appointments: {
        orderBy: { startTime: "desc" },
        take: 100,
        select: {
          id: true,
          startTime: true,
          service: true,
          status: true,
          attendedAt: true,
          professional: { select: { name: true } },
          package: { select: { serviceName: true } },
        },
      },
      comments: { orderBy: { createdAt: "desc" }, take: 200 },
      _count: { select: { packages: { where: { active: true } } } },
    },
  });
  if (!p) return fail("no_encontrado");

  const paquetes = await listPackages({ clinicId: params.clinicId, patientId: p.id });

  return {
    ok: true,
    value: {
      paciente: {
        ...toRow({ ...p, appointments: p.appointments }, now),
        observations: p.observations,
        createdAt: p.createdAt.toISOString(),
      },
      comentarios: p.comments.map((c) => ({
        id: c.id,
        authorName: c.authorName,
        text: c.text,
        createdAt: c.createdAt.toISOString(),
      })),
      citas: p.appointments.map((a) => ({
        id: a.id,
        startTime: a.startTime.toISOString(),
        service: a.service,
        status: a.status,
        professional: a.professional.name,
        attendedAt: a.attendedAt?.toISOString() ?? null,
        package: a.package,
      })),
      paquetes,
    },
  };
}

// --- Alta y edición ---

/** Dígitos del teléfono, o null si no alcanzan (mismo criterio que la Agenda). */
function normalizarTelefono(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digitos = value.replace(/\D/g, "");
  return digitos.length >= 8 ? digitos : null;
}

const parteValida = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.trim().length <= MAX_NAME_PART;

export async function createPatient(params: {
  clinicId: string;
  firstName: unknown;
  lastName?: unknown;
  phone: unknown;
}): Promise<PatientResult<Patient>> {
  if (!parteValida(params.firstName)) return fail("datos_invalidos");
  const last =
    params.lastName === undefined || params.lastName === null || params.lastName === ""
      ? ""
      : parteValida(params.lastName)
        ? (params.lastName as string)
        : null;
  if (last === null) return fail("datos_invalidos");
  const phone = normalizarTelefono(params.phone);
  if (!phone) return fail("telefono_invalido");

  const name = joinFullName(params.firstName, last);
  // La misma persona en el mismo número ya está cargada: no se duplica.
  const mismas = await prisma.patient.findMany({ where: { clinicId: params.clinicId, phone } });
  if (mismas.some((m) => m.name && normalizarNombre(m.name) === normalizarNombre(name))) {
    return fail("nombre_duplicado");
  }

  const creado = await prisma.patient.create({
    data: {
      clinicId: params.clinicId,
      phone,
      name,
      firstName: params.firstName.trim(),
      lastName: last.trim() || null,
    },
  });
  return { ok: true, value: creado };
}

export interface PatientChanges {
  firstName?: unknown;
  lastName?: unknown;
  observations?: unknown;
  /** "YYYY-MM-DD" o null para quitarla. */
  suggestedNextVisitDate?: unknown;
  suggestedNextVisitNote?: unknown;
  outreachOptOut?: unknown;
  /** Lista de números (dígitos con código de país). Se reemplaza entera. */
  authorizedPhones?: unknown;
}

const textoOpcional = (v: unknown, max: number): string | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string" || v.length > max) throw new TypeError("texto inválido");
  return v.trim() || null;
};

/**
 * `changedFields` son los NOMBRES de los campos que de verdad cambiaron (no los que
 * llegaron en el pedido: la ficha manda todo en cada guardado). Es lo que se registra en
 * la auditoría, que nunca guarda valores.
 */
export type UpdatePatientResult =
  | { ok: true; value: Patient; changedFields: string[] }
  | { ok: false; reason: PatientFailure; message: string };

export async function updatePatient(params: {
  clinicId: string;
  patientId: string;
  changes: PatientChanges;
}): Promise<UpdatePatientResult> {
  const { changes } = params;
  const actual = await prisma.patient.findFirst({
    where: { id: params.patientId, clinicId: params.clinicId },
  });
  if (!actual) return fail("no_encontrado");

  const data: Prisma.PatientUpdateInput = {};
  try {
    // Nombre y apellido: se recalcula `name`, que es el que usa todo lo demás.
    if (changes.firstName !== undefined || changes.lastName !== undefined) {
      const partes = patientNameParts(actual);
      const first = changes.firstName === undefined ? partes.firstName : changes.firstName;
      // El apellido puede quedar vacío (null o ""): hay personas con un solo nombre.
      const last =
        changes.lastName === undefined ? partes.lastName : changes.lastName === null ? "" : changes.lastName;
      if (!parteValida(first)) return fail("datos_invalidos");
      if (typeof last !== "string" || last.length > MAX_NAME_PART) return fail("datos_invalidos");
      const name = joinFullName(first, last);

      // Dos personas con el mismo nombre en el mismo WhatsApp: el asistente
      // elige la ficha por nombre y no podría distinguirlas.
      const hermanas = await prisma.patient.findMany({
        where: { clinicId: params.clinicId, phone: actual.phone, id: { not: actual.id } },
      });
      if (hermanas.some((h) => h.name && normalizarNombre(h.name) === normalizarNombre(name))) {
        return fail("nombre_duplicado");
      }
      data.name = name;
      data.firstName = first.trim();
      data.lastName = last.trim() || null;
    }

    const obs = textoOpcional(changes.observations, MAX_OBSERVATIONS);
    if (obs !== undefined) data.observations = obs;
    const nota = textoOpcional(changes.suggestedNextVisitNote, MAX_NEXT_VISIT_NOTE);
    if (nota !== undefined) data.suggestedNextVisitNote = nota;

    if (changes.suggestedNextVisitDate !== undefined) {
      if (changes.suggestedNextVisitDate === null || changes.suggestedNextVisitDate === "") {
        data.suggestedNextVisitDate = null;
      } else {
        const fecha = parseDateKey(changes.suggestedNextVisitDate);
        if (!fecha) return fail("datos_invalidos");
        data.suggestedNextVisitDate = fecha;
      }
      // Otra fecha es otra sugerencia: corresponde un mensaje nuevo.
      if (dateKeyOf((data.suggestedNextVisitDate as Date | null) ?? null) !== dateKeyOf(actual.suggestedNextVisitDate)) {
        data.nextVisitOutreachSentAt = null;
      }
    }

    if (changes.outreachOptOut !== undefined) {
      if (typeof changes.outreachOptOut !== "boolean") return fail("datos_invalidos");
      data.outreachOptOut = changes.outreachOptOut;
    }

    if (changes.authorizedPhones !== undefined) {
      if (!Array.isArray(changes.authorizedPhones) || changes.authorizedPhones.length > MAX_AUTHORIZED_PHONES) {
        return fail("datos_invalidos");
      }
      const numeros: string[] = [];
      for (const raw of changes.authorizedPhones) {
        const n = typeof raw === "string" ? normalizeWhatsAppNumber(raw) : null;
        if (!n) return fail("datos_invalidos");
        // El propio número de la persona no se autoriza a sí mismo, y no se repiten.
        if (n !== actual.phone && !numeros.includes(n)) numeros.push(n);
      }
      data.authorizedPhones = numeros;
    }
  } catch {
    return fail("datos_invalidos");
  }

  // Qué cambió de verdad: se compara con lo que había. Solo los nombres.
  const changedFields: string[] = [];
  const igual = (a: unknown, b: unknown) =>
    a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : (a ?? null) === (b ?? null);
  for (const campo of [
    "firstName",
    "lastName",
    "observations",
    "suggestedNextVisitDate",
    "suggestedNextVisitNote",
    "outreachOptOut",
  ] as const) {
    if (campo in data && !igual((data as Record<string, unknown>)[campo], (actual as Record<string, unknown>)[campo])) {
      changedFields.push(campo);
    }
  }

  if (
    "authorizedPhones" in data &&
    JSON.stringify(data.authorizedPhones) !== JSON.stringify(actual.authorizedPhones)
  ) {
    changedFields.push("authorizedPhones");
  }

  if (Object.keys(data).length === 0) return { ok: true, value: actual, changedFields };
  const actualizado = await prisma.patient.update({ where: { id: actual.id }, data });
  return { ok: true, value: actualizado, changedFields };
}

// --- Comentarios ---

export async function addPatientComment(params: {
  clinicId: string;
  patientId: string;
  userId: string | null;
  authorName: string;
  text: unknown;
}) {
  if (typeof params.text !== "string" || !params.text.trim() || params.text.length > MAX_COMMENT) {
    return fail("datos_invalidos");
  }
  const paciente = await prisma.patient.findFirst({
    where: { id: params.patientId, clinicId: params.clinicId },
    select: { id: true },
  });
  if (!paciente) return fail("no_encontrado");

  const comentario = await prisma.patientComment.create({
    data: {
      clinicId: params.clinicId,
      patientId: paciente.id,
      authorUserId: params.userId,
      authorName: params.authorName,
      text: params.text.trim(),
    },
  });
  return { ok: true as const, value: comentario };
}

export async function deletePatientComment(params: {
  clinicId: string;
  patientId: string;
  commentId: string;
}): Promise<PatientResult<true>> {
  const { count } = await prisma.patientComment.deleteMany({
    where: { id: params.commentId, patientId: params.patientId, clinicId: params.clinicId },
  });
  return count > 0 ? { ok: true, value: true } : fail("no_encontrado");
}
