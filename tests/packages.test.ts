import { afterEach, describe, expect, it } from "vitest";
import { purgeAuditForClinics } from "./helpers/audit";
import type { Weekday } from "@prisma/client";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import { CLINIC_CALENDAR_INCLUDE } from "../src/services/calendar";
import type { ClinicWithCalendarAccount } from "../src/repositories/clinics.repository";
import { createAppointmentFromRequest } from "../src/services/booking";
import { createManualAppointment, updateAppointment } from "../src/services/appointment-admin";
import {
  createPackage,
  listPackages,
  listPendingPackageAppointments,
  markAppointmentAttended,
  packageCapacity,
  unmarkAppointmentAttended,
  updatePackage,
} from "../src/services/packages";

/**
 * Paquetes de sesiones: la sesión se descuenta cuando UNA PERSONA marca la cita
 * como atendida, y solo entonces. Contra el Postgres local.
 */

const LUNES = "2030-06-17";
const DIAS: Weekday[] = ["lunes", "martes", "miercoles", "jueves", "viernes"];
/** Lunes a las 09:00 UTC. Las citas del test son a las 10:00. */
const AHORA = new Date("2030-06-17T09:00:00.000Z");
/** Después de la cita de las 10:00. */
const DESPUES = new Date("2030-06-17T11:00:00.000Z");
const clinicIds: string[] = [];

async function escenario() {
  const creada = await prisma.clinic.create({
    data: {
      name: `Clínica paquetes ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `pq-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: "UTC",
      services: "x",
      minLeadMinutes: 0,
      professionals: { create: [{ name: "Gómez" }] },
      rooms: { create: [{ name: "Sala 1" }, { name: "Sala 2" }] },
      workingHours: {
        create: DIAS.map((weekday) => ({ weekday, startMinute: 0, endMinute: 24 * 60 })),
      },
    },
    include: { professionals: true, rooms: true },
  });
  clinicIds.push(creada.id);
  const clinic = (await prisma.clinic.findUniqueOrThrow({
    where: { id: creada.id },
    include: CLINIC_CALENDAR_INCLUDE,
  })) as ClinicWithCalendarAccount;
  const gomez = creada.professionals[0];
  const laser = await prisma.service.create({
    data: {
      clinicId: clinic.id,
      name: "Láser",
      durationMinutes: 30,
      professionals: { connect: [{ id: gomez.id }] },
    },
  });
  const limpieza = await prisma.service.create({
    data: {
      clinicId: clinic.id,
      name: "Limpieza",
      durationMinutes: 30,
      professionals: { connect: [{ id: gomez.id }] },
    },
  });
  const paciente = await prisma.patient.create({
    data: { clinicId: clinic.id, phone: `5491${Math.floor(Math.random() * 1e9)}`, name: "Paciente" },
  });
  const otro = await prisma.patient.create({
    data: { clinicId: clinic.id, phone: `5492${Math.floor(Math.random() * 1e9)}`, name: "Otro" },
  });
  // Para que ninguno sea de "primera vez".
  for (const p of [paciente, otro]) {
    await prisma.appointment.create({
      data: {
        clinicId: clinic.id,
        patientId: p.id,
        professionalId: gomez.id,
        roomId: creada.rooms[0].id,
        service: "Historial",
        startTime: new Date("2020-01-01T10:00:00.000Z"),
        endTime: new Date("2020-01-01T10:30:00.000Z"),
        status: "atendido",
      },
    });
  }
  return { clinic, gomez, laser, limpieza, paciente, otro, sala1: creada.rooms[0], sala2: creada.rooms[1] };
}
type E = Awaited<ReturnType<typeof escenario>>;

/**
 * `serviceId: null` representa un paquete HEREDADO, anterior a que el servicio
 * fuera obligatorio: ya no se puede crear por `createPackage`, así que va directo
 * a la base. Sigue existiendo en el modelo y tiene que seguir funcionando.
 */
async function paquete(e: E, total = 3, over?: { patientId?: string; serviceId?: string | null }) {
  if (over?.serviceId === null) {
    return prisma.package.create({
      data: {
        clinicId: e.clinic.id,
        patientId: over?.patientId ?? e.paciente.id,
        serviceName: "Pack heredado",
        totalSessions: total,
      },
    });
  }
  const r = await createPackage({
    clinicId: e.clinic.id,
    userId: "u1",
    patientId: over?.patientId ?? e.paciente.id,
    serviceId: over?.serviceId ?? e.laser.id,
    totalSessions: total,
  });
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

/** Cita directa en la base, a una hora distinta cada una (no se pisan). */
let contador = 0;
async function cita(
  e: E,
  over?: { packageId?: string | null; hora?: string; patientId?: string; status?: "confirmado" | "cancelado" | "atendido"; dia?: string }
) {
  contador += 1;
  const hora = over?.hora ?? `${String(10 + (contador % 8)).padStart(2, "0")}:00`;
  const dia = over?.dia ?? LUNES;
  const start = new Date(`${dia}T${hora}:00.000Z`);
  return prisma.appointment.create({
    data: {
      clinicId: e.clinic.id,
      patientId: over?.patientId ?? e.paciente.id,
      professionalId: e.gomez.id,
      roomId: e.sala1.id,
      serviceId: e.laser.id,
      service: "Láser",
      startTime: start,
      endTime: new Date(start.getTime() + 30 * 60_000),
      packageId: over?.packageId ?? null,
      status: over?.status ?? "confirmado",
    },
  });
}

const marcar = (e: E, id: string, now = DESPUES) =>
  markAppointmentAttended({ clinicId: e.clinic.id, appointmentId: id, userId: "asistente-1", now });
const usadas = async (id: string) => (await prisma.package.findUniqueOrThrow({ where: { id } })).usedSessions;

afterEach(async () => {
  await purgeAuditForClinics(clinicIds);
  for (const clinicId of clinicIds) {
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.package.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.service.deleteMany({ where: { clinicId } });
    await prisma.room.deleteMany({ where: { clinicId } });
    await prisma.workingHours.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

describe("alta de un paquete", () => {
  it("con un servicio del catálogo toma su nombre", async () => {
    const e = await escenario();
    const p = await paquete(e, 6);
    expect(p).toMatchObject({ serviceName: "Láser", serviceId: e.laser.id, totalSessions: 6, usedSessions: 0, active: true });
  });

  it("el servicio es obligatorio: sin elegirlo de la lista no se crea", async () => {
    const e = await escenario();
    const sin = await createPackage({ clinicId: e.clinic.id, userId: "u", patientId: e.paciente.id, totalSessions: 3 });
    expect(sin).toMatchObject({ ok: false, reason: "servicio_requerido" });
    expect(await prisma.package.count({ where: { clinicId: e.clinic.id } })).toBe(0);
  });

  it("no se puede crear con un nombre escrito a mano en vez de un servicio", async () => {
    const e = await escenario();
    // El parámetro ya no existe: aunque llegue por la API, no se usa.
    const r = await createPackage({
      clinicId: e.clinic.id, userId: "u", patientId: e.paciente.id, totalSessions: 3,
      ...({ serviceName: "Depilación" } as object),
    });
    expect(r).toMatchObject({ ok: false, reason: "servicio_requerido" });
  });

  it("un servicio desactivado no se ofrece, así que tampoco sirve para un paquete nuevo", async () => {
    const e = await escenario();
    await prisma.service.update({ where: { id: e.laser.id }, data: { active: false } });
    expect(await createPackage({
      clinicId: e.clinic.id, userId: "u", patientId: e.paciente.id, serviceId: e.laser.id, totalSessions: 3,
    })).toMatchObject({ ok: false, reason: "servicio_no_encontrado" });
  });

  it("el nombre del paquete es el del catálogo al momento de la compra", async () => {
    const e = await escenario();
    const p = await paquete(e, 3);
    await prisma.service.update({ where: { id: e.laser.id }, data: { name: "Láser renombrado" } });
    expect((await prisma.package.findUniqueOrThrow({ where: { id: p.id } })).serviceName).toBe("Láser");
  });

  it("rechaza cantidades inválidas, un paciente o un servicio ajenos", async () => {
    const e = await escenario();
    for (const total of [0, -1, 1.5, "3", 201]) {
      expect(await createPackage({
        clinicId: e.clinic.id, userId: "u", patientId: e.paciente.id, serviceId: e.laser.id, totalSessions: total,
      })).toMatchObject({ ok: false, reason: "datos_invalidos" });
    }
    expect(await createPackage({
      clinicId: e.clinic.id, userId: "u", patientId: "no-existe", serviceId: e.laser.id, totalSessions: 3,
    })).toMatchObject({ ok: false, reason: "paciente_no_encontrado" });
    expect(await createPackage({
      clinicId: e.clinic.id, userId: "u", patientId: e.paciente.id, serviceId: "no-existe", totalSessions: 3,
    })).toMatchObject({ ok: false, reason: "servicio_no_encontrado" });
  });

  it("un paciente de otra clínica no existe para esta", async () => {
    const e = await escenario();
    const ajena = await escenario();
    expect(await createPackage({
      clinicId: e.clinic.id, userId: "u", patientId: ajena.paciente.id, serviceId: e.laser.id, totalSessions: 3,
    })).toMatchObject({ ok: false, reason: "paciente_no_encontrado" });
  });

  it("la base impone que no haya más sesiones usadas que compradas", async () => {
    const e = await escenario();
    const p = await paquete(e, 2);
    await expect(prisma.package.update({ where: { id: p.id }, data: { usedSessions: 3 } })).rejects.toThrow();
  });
});

describe("marcar una cita como atendida", () => {
  it("descuenta una sesión del paquete y deja quién y cuándo", async () => {
    const e = await escenario();
    const p = await paquete(e, 3);
    const c = await cita(e, { packageId: p.id, hora: "10:00" });

    const r = await marcar(e, c.id);
    expect(r.ok).toBe(true);
    expect(await usadas(p.id)).toBe(1);
    const despues = await prisma.appointment.findUniqueOrThrow({ where: { id: c.id } });
    expect(despues.attendedAt).toEqual(DESPUES);
    expect(despues.attendedByUserId).toBe("asistente-1");
    expect(despues.status).toBe("atendido");
  });

  it("es idempotente: marcarla dos veces no descuenta dos", async () => {
    const e = await escenario();
    const p = await paquete(e, 3);
    const c = await cita(e, { packageId: p.id, hora: "10:00" });
    await marcar(e, c.id);
    const otra = await marcar(e, c.id);
    expect(otra).toMatchObject({ ok: true, yaEstabaMarcada: true });
    expect(await usadas(p.id)).toBe(1);
  });

  it("dos personas marcándola a la vez descuentan una sola sesión", async () => {
    const e = await escenario();
    const p = await paquete(e, 3);
    const c = await cita(e, { packageId: p.id, hora: "10:00" });
    const resultados = await Promise.allSettled([marcar(e, c.id), marcar(e, c.id)]);
    // Una puede abortar por serialización: lo que importa es el saldo.
    expect(resultados.some((r) => r.status === "fulfilled")).toBe(true);
    expect(await usadas(p.id)).toBe(1);
  });

  it("una cita sin paquete también se marca, sin tocar ningún saldo", async () => {
    const e = await escenario();
    const p = await paquete(e, 3);
    const c = await cita(e, { hora: "10:00" });
    const r = await marcar(e, c.id);
    expect(r).toMatchObject({ ok: true, package: null });
    expect(await usadas(p.id)).toBe(0);
  });

  it("una cita que el job dejó en 'atendido' solo igual descuenta al confirmarla", async () => {
    const e = await escenario();
    const p = await paquete(e, 3);
    const c = await cita(e, { packageId: p.id, hora: "10:00", status: "atendido" });
    expect((await marcar(e, c.id)).ok).toBe(true);
    expect(await usadas(p.id)).toBe(1);
  });

  it("al usarse la última sesión el paquete se apaga solo", async () => {
    const e = await escenario();
    const p = await paquete(e, 1);
    const c = await cita(e, { packageId: p.id, hora: "10:00" });
    await marcar(e, c.id);
    const despues = await prisma.package.findUniqueOrThrow({ where: { id: p.id } });
    expect(despues).toMatchObject({ usedSessions: 1, active: false });
  });

  it("no se puede pasar del total aunque haya dos citas atadas", async () => {
    const e = await escenario();
    const p = await paquete(e, 1);
    const a = await cita(e, { packageId: p.id, hora: "10:00" });
    const b = await cita(e, { packageId: p.id, hora: "11:00" });
    await marcar(e, a.id);
    expect(await marcar(e, b.id)).toMatchObject({ ok: false, reason: "paquete_sin_sesiones" });
    expect(await usadas(p.id)).toBe(1);
    // La segunda quedó sin marcar: no se perdió nada.
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: b.id } })).attendedAt).toBeNull();
  });

  it("rechaza una cita cancelada, una ajena o inexistente", async () => {
    const e = await escenario();
    const ajena = await escenario();
    const cancelada = await cita(e, { hora: "10:00", status: "cancelado" });
    expect(await marcar(e, cancelada.id)).toMatchObject({ ok: false, reason: "cita_cancelada" });
    const deOtra = await cita(ajena, { hora: "10:00" });
    expect(await marcar(e, deOtra.id)).toMatchObject({ ok: false, reason: "no_encontrado" });
    expect(await marcar(e, "no-existe")).toMatchObject({ ok: false, reason: "no_encontrado" });
  });

  it("no deja marcar una cita que falta mucho, pero sí desde una hora antes", async () => {
    const e = await escenario();
    const p = await paquete(e, 3);
    const c = await cita(e, { packageId: p.id, hora: "10:00" });
    expect(await marcar(e, c.id, new Date("2030-06-17T08:00:00.000Z"))).toMatchObject({
      ok: false,
      reason: "todavia_no_es_la_hora",
    });
    expect(await usadas(p.id)).toBe(0);
    expect((await marcar(e, c.id, new Date("2030-06-17T09:00:00.000Z"))).ok).toBe(true);
  });
});

describe("deshacer", () => {
  it("devuelve la sesión y la cita vuelve a estar confirmada", async () => {
    const e = await escenario();
    const p = await paquete(e, 3);
    const c = await cita(e, { packageId: p.id, hora: "10:00" });
    await marcar(e, c.id);
    const r = await unmarkAppointmentAttended({ clinicId: e.clinic.id, appointmentId: c.id });
    expect(r.ok).toBe(true);
    expect(await usadas(p.id)).toBe(0);
    const despues = await prisma.appointment.findUniqueOrThrow({ where: { id: c.id } });
    expect(despues).toMatchObject({ attendedAt: null, attendedByUserId: null, status: "confirmado" });
  });

  it("si el paquete se había agotado, se reactiva", async () => {
    const e = await escenario();
    const p = await paquete(e, 1);
    const c = await cita(e, { packageId: p.id, hora: "10:00" });
    await marcar(e, c.id);
    await unmarkAppointmentAttended({ clinicId: e.clinic.id, appointmentId: c.id });
    expect((await prisma.package.findUniqueOrThrow({ where: { id: p.id } })).active).toBe(true);
  });

  it("deshacer una que no estaba marcada no toca nada", async () => {
    const e = await escenario();
    const p = await paquete(e, 3);
    const c = await cita(e, { packageId: p.id, hora: "10:00" });
    expect(await unmarkAppointmentAttended({ clinicId: e.clinic.id, appointmentId: c.id })).toMatchObject({
      ok: false,
      reason: "no_estaba_atendida",
    });
    expect(await usadas(p.id)).toBe(0);
  });
});

describe("cuántas sesiones quedan", () => {
  it("separa las usadas, las agendadas sin confirmar y las libres", async () => {
    const e = await escenario();
    const p = await paquete(e, 5);
    const a = await cita(e, { packageId: p.id, hora: "10:00" });
    await cita(e, { packageId: p.id, hora: "11:00" });
    await cita(e, { packageId: p.id, hora: "12:00", status: "cancelado" });
    await marcar(e, a.id);
    const actual = await prisma.package.findUniqueOrThrow({ where: { id: p.id } });
    expect(await packageCapacity(prisma, actual)).toEqual({ total: 5, used: 1, reserved: 1, available: 3 });
  });

  it("cambiar el total no puede dejar menos que lo usado más lo comprometido", async () => {
    const e = await escenario();
    const p = await paquete(e, 3);
    await cita(e, { packageId: p.id, hora: "10:00" });
    await cita(e, { packageId: p.id, hora: "11:00" });
    expect(await updatePackage({ clinicId: e.clinic.id, packageId: p.id, totalSessions: 1 })).toMatchObject({
      ok: false,
      reason: "menos_que_las_usadas",
    });
    expect((await updatePackage({ clinicId: e.clinic.id, packageId: p.id, totalSessions: 2 })).ok).toBe(true);
  });

  it("subir el total de un paquete agotado lo reactiva", async () => {
    const e = await escenario();
    const p = await paquete(e, 1);
    const c = await cita(e, { packageId: p.id, hora: "10:00" });
    await marcar(e, c.id);
    const r = await updatePackage({ clinicId: e.clinic.id, packageId: p.id, totalSessions: 4 });
    expect(r).toMatchObject({ ok: true, value: { totalSessions: 4, active: true } });
  });

  it("listPackages trae la capacidad y respeta el paciente y la clínica", async () => {
    const e = await escenario();
    const ajena = await escenario();
    await paquete(e, 3);
    await paquete(e, 2, { patientId: e.otro.id });
    await paquete(ajena, 9);
    const todos = await listPackages({ clinicId: e.clinic.id });
    expect(todos).toHaveLength(2);
    const delPaciente = await listPackages({ clinicId: e.clinic.id, patientId: e.paciente.id });
    expect(delPaciente).toHaveLength(1);
    expect(delPaciente[0].capacity.available).toBe(3);
  });
});

describe("atar una cita desde la Agenda", () => {
  const crear = (e: E, over?: Partial<Parameters<typeof createManualAppointment>[0]>) =>
    createManualAppointment({
      clinic: e.clinic,
      userId: "u1",
      patientId: e.paciente.id,
      serviceId: e.laser.id,
      professionalId: e.gomez.id,
      date: LUNES,
      time: "10:00",
      now: AHORA,
      ...over,
    });

  it("crea la cita atada al paquete, sin descontar todavía", async () => {
    const e = await escenario();
    const p = await paquete(e, 3);
    const r = await crear(e, { packageId: p.id });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.appointment.packageId).toBe(p.id);
    expect(await usadas(p.id)).toBe(0);
  });

  it("el paquete de otra persona no existe para esta cita", async () => {
    const e = await escenario();
    const deOtro = await paquete(e, 3, { patientId: e.otro.id });
    expect(await crear(e, { packageId: deOtro.id })).toMatchObject({ ok: false, reason: "paquete_no_encontrado" });
  });

  it("rechaza un paquete de otro servicio, y uno desactivado", async () => {
    const e = await escenario();
    const deLaser = await paquete(e, 3);
    expect(await crear(e, { packageId: deLaser.id, serviceId: e.limpieza.id })).toMatchObject({
      ok: false,
      reason: "paquete_de_otro_servicio",
    });
    await updatePackage({ clinicId: e.clinic.id, packageId: deLaser.id, active: false });
    expect(await crear(e, { packageId: deLaser.id })).toMatchObject({ ok: false, reason: "paquete_inactivo" });
  });

  it("un paquete heredado, sin servicio, sirve para cualquiera", async () => {
    const e = await escenario();
    const libre = await paquete(e, 3, { serviceId: null });
    expect((await crear(e, { packageId: libre.id, serviceId: e.limpieza.id })).ok).toBe(true);
  });

  it("sin sesiones libres es una regla blanda: pide confirmación y, confirmando, agenda", async () => {
    const e = await escenario();
    const p = await paquete(e, 1);
    await cita(e, { packageId: p.id, hora: "15:00" });
    const sin = await crear(e, { packageId: p.id });
    expect(sin).toMatchObject({ ok: false, reason: "requiere_confirmacion" });
    if (sin.ok || sin.reason !== "requiere_confirmacion") return;
    expect(sin.violations.map((v) => v.rule)).toEqual(["paquete_sin_sesiones"]);
    const con = await crear(e, { packageId: p.id, force: true });
    expect(con.ok).toBe(true);
    if (con.ok) expect(con.appointment.forcedRules).toContain("paquete_sin_sesiones");
  });

  it("editar: se puede atar, y desatar con null", async () => {
    const e = await escenario();
    const p = await paquete(e, 3);
    const base = await crear(e);
    if (!base.ok) throw new Error("fixture");
    const atar = await updateAppointment({
      clinic: e.clinic, userId: "u1", appointmentId: base.appointment.id, changes: { packageId: p.id }, now: AHORA,
    });
    expect(atar.ok && atar.appointment.packageId).toBe(p.id);
    const desatar = await updateAppointment({
      clinic: e.clinic, userId: "u1", appointmentId: base.appointment.id, changes: { packageId: null }, now: AHORA,
    });
    expect(desatar.ok && desatar.appointment.packageId).toBeNull();
  });

  it("mover de hora una cita ya atada no falla aunque el paquete esté justo", async () => {
    const e = await escenario();
    const p = await paquete(e, 1);
    const base = await crear(e, { packageId: p.id });
    if (!base.ok) throw new Error("fixture");
    const mover = await updateAppointment({
      clinic: e.clinic, userId: "u1", appointmentId: base.appointment.id, changes: { time: "11:00" }, now: AHORA,
    });
    expect(mover.ok).toBe(true);
  });
});

describe("agendar por WhatsApp", () => {
  const pedir = (e: E, hora: string, patient = e.paciente, servicio = "Láser") =>
    createAppointmentFromRequest({
      clinic: e.clinic, patient, requestedDate: LUNES, requestedTime: hora, requestedService: servicio, now: AHORA,
    });

  it("ata la cita al paquete del paciente para ese servicio", async () => {
    const e = await escenario();
    const p = await paquete(e, 2);
    const r = await pedir(e, "10:00");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.appointment.packageId).toBe(p.id);
  });

  it("no agenda de más: sin sesiones libres, la cita queda sin paquete", async () => {
    const e = await escenario();
    await paquete(e, 1);
    const primera = await pedir(e, "10:00");
    const segunda = await pedir(e, "11:00");
    expect(primera.ok && segunda.ok).toBe(true);
    if (primera.ok && segunda.ok) {
      expect(primera.appointment.packageId).not.toBeNull();
      expect(segunda.appointment.packageId).toBeNull();
    }
  });

  it("un paquete heredado, sin servicio, no se ata solo", async () => {
    const e = await escenario();
    await paquete(e, 3, { serviceId: null });
    const r = await pedir(e, "10:00");
    expect(r.ok && r.appointment.packageId).toBeNull();
  });

  it("el paquete de otra persona del mismo número no se usa", async () => {
    const e = await escenario();
    await paquete(e, 3, { patientId: e.otro.id });
    const r = await pedir(e, "10:00");
    expect(r.ok && r.appointment.packageId).toBeNull();
  });

  it("un servicio distinto no usa el paquete", async () => {
    const e = await escenario();
    await paquete(e, 3);
    const r = await pedir(e, "10:00", e.paciente, "Limpieza");
    expect(r.ok && r.appointment.packageId).toBeNull();
  });
});

describe("el aviso de la asistente", () => {
  it("separa las de hoy de las atrasadas, y deja afuera lo ya confirmado o cancelado", async () => {
    const e = await escenario();
    const p = await paquete(e, 10);
    const hoy = await cita(e, { packageId: p.id, hora: "10:00" });
    const ayer = await cita(e, { packageId: p.id, hora: "10:00", dia: "2030-06-16" });
    const yaMarcada = await cita(e, { packageId: p.id, hora: "12:00" });
    await cita(e, { packageId: p.id, hora: "13:00", status: "cancelado" });
    await cita(e, { hora: "14:00" }); // sin paquete
    await cita(e, { packageId: p.id, hora: "10:00", dia: "2030-06-18" }); // mañana
    await marcar(e, yaMarcada.id);

    const r = await listPendingPackageAppointments({ clinicId: e.clinic.id, timezone: "UTC", now: AHORA });
    expect(r.hoy.map((c) => c.id)).toEqual([hoy.id]);
    expect(r.atrasadas.map((c) => c.id)).toEqual([ayer.id]);
    expect(r.hoy[0].package).toMatchObject({ totalSessions: 10, usedSessions: 1 });
  });

  it("una cita que el job dejó en 'atendido' sin confirmar sigue figurando", async () => {
    const e = await escenario();
    const p = await paquete(e, 3);
    const c = await cita(e, { packageId: p.id, hora: "10:00", dia: "2030-06-16", status: "atendido" });
    const r = await listPendingPackageAppointments({ clinicId: e.clinic.id, timezone: "UTC", now: AHORA });
    expect(r.atrasadas.map((x) => x.id)).toEqual([c.id]);
  });

  it("'hoy' es el día de la clínica y no el del servidor", async () => {
    const e = await escenario();
    const p = await paquete(e, 3);
    // 02:00 UTC del martes 18 es lunes 17 a las 20:00 en México (UTC-6).
    const c = await cita(e, { packageId: p.id, hora: "02:00", dia: "2030-06-18" });
    const r = await listPendingPackageAppointments({
      clinicId: e.clinic.id,
      timezone: "America/Mexico_City",
      now: new Date("2030-06-18T03:00:00.000Z"), // lunes 21:00 en México
    });
    expect(r.hoy.map((x) => x.id)).toEqual([c.id]);
  });

  it("no mezcla clínicas", async () => {
    const e = await escenario();
    const ajena = await escenario();
    const pa = await paquete(ajena, 3);
    await cita(ajena, { packageId: pa.id, hora: "10:00" });
    const r = await listPendingPackageAppointments({ clinicId: e.clinic.id, timezone: "UTC", now: AHORA });
    expect(r.hoy).toEqual([]);
  });
});
