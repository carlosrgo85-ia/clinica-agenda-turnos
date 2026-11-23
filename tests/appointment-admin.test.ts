import { afterEach, describe, expect, it } from "vitest";
import type { Weekday } from "@prisma/client";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import { CLINIC_CALENDAR_INCLUDE } from "../src/services/calendar";
import type { ClinicWithCalendarAccount } from "../src/repositories/clinics.repository";
import {
  cancelAppointment,
  createManualAppointment,
  createManualBlocks,
  deleteManualBlock,
  sinEquipoMessage,
  updateAppointment,
  updateManualBlock,
} from "../src/services/appointment-admin";
import { hasCalendarBlock } from "../src/services/availability";

/**
 * Crear, mover, editar y cancelar citas desde la Agenda, y bloqueos manuales.
 * Contra el Postgres local.
 *
 * Lo que se prueba es el contrato de las dos categorías de reglas: las BLANDAS
 * se saltan solo confirmando (y queda constancia), las DURAS nunca.
 */

const LUNES = "2030-06-17";
const ANTES = new Date("2030-06-17T06:00:00.000Z");
const DIAS: Weekday[] = ["lunes", "martes", "miercoles", "jueves", "viernes"];

const clinicIds: string[] = [];

async function crearEscenario() {
  const creada = await prisma.clinic.create({
    data: {
      name: `Clínica agenda ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `ad-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: "UTC",
      services: "x",
      professionals: { create: [{ name: "Gómez" }, { name: "Ruiz" }] },
      rooms: { create: [{ name: "Sala 1" }, { name: "Sala 2" }] },
      workingHours: {
        create: DIAS.map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 18 * 60 })),
      },
    },
    include: { professionals: { orderBy: { name: "asc" } }, rooms: { orderBy: { name: "asc" } } },
  });
  clinicIds.push(creada.id);
  const clinic = (await prisma.clinic.findUniqueOrThrow({
    where: { id: creada.id },
    include: CLINIC_CALENDAR_INCLUDE,
  })) as ClinicWithCalendarAccount;

  const [gomez, ruiz] = creada.professionals;
  const [sala1, sala2] = creada.rooms;
  const limpieza = await prisma.service.create({
    data: {
      clinicId: clinic.id,
      name: "Limpieza",
      durationMinutes: 30,
      professionals: { connect: [{ id: gomez.id }, { id: ruiz.id }] },
    },
  });
  const blanqueamiento = await prisma.service.create({
    data: {
      clinicId: clinic.id,
      name: "Blanqueamiento",
      durationMinutes: 60,
      professionals: { connect: [{ id: ruiz.id }] },
    },
  });
  const paciente = await prisma.patient.create({
    data: { clinicId: clinic.id, phone: `5491${Math.floor(Math.random() * 1e9)}`, name: "Paciente" },
  });
  const otro = await prisma.patient.create({
    data: { clinicId: clinic.id, phone: `5492${Math.floor(Math.random() * 1e9)}`, name: "Otro" },
  });
  // Para que ninguno sea "de primera vez" salvo que el test lo pida.
  const previo = (patientId: string) =>
    prisma.appointment.create({
      data: {
        clinicId: clinic.id,
        patientId,
        professionalId: gomez.id,
        roomId: sala1.id,
        service: "Historial",
        startTime: new Date("2020-01-01T10:00:00.000Z"),
        endTime: new Date("2020-01-01T10:30:00.000Z"),
        status: "atendido",
      },
    });
  await previo(paciente.id);
  await previo(otro.id);

  return { clinic, gomez, ruiz, sala1, sala2, limpieza, blanqueamiento, paciente, otro };
}

afterEach(async () => {
  for (const clinicId of clinicIds) {
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.calendarBlock.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.service.deleteMany({ where: { clinicId } });
    await prisma.resource.deleteMany({ where: { clinicId } });
    await prisma.room.deleteMany({ where: { clinicId } });
    await prisma.workingHours.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

type Escenario = Awaited<ReturnType<typeof crearEscenario>>;

function crear(e: Escenario, overrides?: Partial<Parameters<typeof createManualAppointment>[0]>) {
  return createManualAppointment({
    clinic: e.clinic,
    userId: "user-1",
    patientId: e.paciente.id,
    serviceId: e.limpieza.id,
    professionalId: e.gomez.id,
    date: LUNES,
    time: "10:00",
    now: ANTES,
    ...overrides,
  });
}

describe("una clínica sin horario cargado", () => {
  it("no se saltea el chequeo: es regla blanda y el mensaje dice qué falta de verdad", async () => {
    const e = await crearEscenario();
    await prisma.workingHours.deleteMany({ where: { clinicId: e.clinic.id } });

    const r = await crear(e);
    expect(r).toMatchObject({ ok: false, reason: "requiere_confirmacion" });
    if (r.ok || r.reason !== "requiere_confirmacion") return;
    expect(r.violations.map((v) => v.rule)).toEqual(["clinica_cerrada"]);
    expect(r.violations[0].message).toContain("no tiene cargado su horario");

    // Confirmando se puede cargar igual, como cualquier regla blanda.
    const forzada = await crear(e, { force: true });
    expect(forzada.ok).toBe(true);
  });
});

describe("crear una cita desde la Agenda", () => {
  it("crea la cita con la duración del servicio, el origen panel y quién la cargó", async () => {
    const e = await crearEscenario();
    const r = await crear(e);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.appointment.startTime.toISOString()).toBe("2030-06-17T10:00:00.000Z");
    expect(r.appointment.endTime.toISOString()).toBe("2030-06-17T10:30:00.000Z");
    expect(r.appointment.source).toBe("panel");
    expect(r.appointment.createdByUserId).toBe("user-1");
    expect(r.appointment.forcedRules).toEqual([]);
  });

  it("una regla blanda rota NO escribe nada hasta que se confirma", async () => {
    const e = await crearEscenario();
    // Un día cerrado a la clínica (domingo) rompe una regla blanda que sí se puede confirmar.
    const sin = await crear(e, { date: "2030-06-16" });
    expect(sin).toMatchObject({ ok: false, reason: "requiere_confirmacion" });
    if (sin.ok || sin.reason !== "requiere_confirmacion") return;
    expect(sin.violations.length).toBeGreaterThan(0);
    expect(await prisma.appointment.count({ where: { clinicId: e.clinic.id, source: "panel" } })).toBe(0);

    const con = await crear(e, { date: "2030-06-16", force: true });
    expect(con.ok).toBe(true);
    if (con.ok) expect(con.appointment.forcedRules.length).toBeGreaterThan(0);
  });

  it("que el profesional realice el servicio es OBLIGATORIO: ni confirmando se puede agendar, y no escribe nada", async () => {
    const e = await crearEscenario();
    // Gómez no hace blanqueamiento.
    for (const force of [false, true]) {
      const r = await crear(e, { serviceId: e.blanqueamiento.id, force });
      expect(r).toMatchObject({ ok: false, reason: "profesional_no_hace_servicio" });
      if (!r.ok && r.reason !== "requiere_confirmacion") expect(r.message).toMatch(/no realiza este servicio/);
    }
    expect(await prisma.appointment.count({ where: { clinicId: e.clinic.id, source: "panel" } })).toBe(0);
  });

  it("fuera de horario y sobreturno: se avisan juntas y se pueden forzar", async () => {
    const e = await crearEscenario();
    await crear(e, { time: "10:00" });
    const otroPaciente = await crear(e, { patientId: e.otro.id, time: "10:00" });
    expect(otroPaciente).toMatchObject({ ok: false, reason: "requiere_confirmacion" });
    if (!otroPaciente.ok && otroPaciente.reason === "requiere_confirmacion") {
      expect(otroPaciente.violations.map((v) => v.rule)).toContain("profesional_ocupado");
    }

    const nocturno = await crear(e, { time: "21:00" });
    expect(nocturno).toMatchObject({ ok: false, reason: "requiere_confirmacion" });
    if (!nocturno.ok && nocturno.reason === "requiere_confirmacion") {
      expect(nocturno.violations.map((v) => v.rule)).toContain("clinica_cerrada");
    }
    const forzada = await crear(e, { time: "21:00", force: true });
    expect(forzada.ok).toBe(true);
  });

  it("el espacio ocupado es una regla DURA: ni confirmando se puede", async () => {
    const e = await crearEscenario();
    await crear(e, { roomId: e.sala1.id });
    const r = await crear(e, {
      patientId: e.otro.id,
      professionalId: e.ruiz.id,
      roomId: e.sala1.id,
      force: true,
    });
    expect(r).toMatchObject({ ok: false, reason: "espacio_ocupado" });
  });

  it("la misma persona no puede tener dos citas que se pisan, ni confirmando", async () => {
    const e = await crearEscenario();
    await crear(e, { time: "10:00" });
    const r = await crear(e, { professionalId: e.ruiz.id, time: "10:15", force: true });
    expect(r).toMatchObject({ ok: false, reason: "paciente_con_turno_superpuesto" });
  });

  it("sin espacios libres no hay forma de forzar", async () => {
    const e = await crearEscenario();
    await crear(e, { patientId: e.paciente.id, roomId: e.sala1.id });
    await crear(e, { patientId: e.otro.id, professionalId: e.ruiz.id, roomId: e.sala2.id });
    const tercero = await prisma.patient.create({
      data: { clinicId: e.clinic.id, phone: "5493000000000", name: "Tercero" },
    });
    await prisma.appointment.create({
      data: {
        clinicId: e.clinic.id,
        patientId: tercero.id,
        professionalId: e.gomez.id,
        roomId: e.sala1.id,
        service: "Historial",
        startTime: new Date("2020-01-01T10:00:00.000Z"),
        endTime: new Date("2020-01-01T10:30:00.000Z"),
        status: "atendido",
      },
    });
    const r = await crear(e, { patientId: tercero.id, force: true });
    // Gómez está ocupado (blanda) y las dos salas también (dura): gana la dura.
    expect(r).toMatchObject({ ok: false, reason: "sin_espacios" });
  });

  it("un paciente de primera vez que no empieza por el diagnóstico pide confirmación", async () => {
    const e = await crearEscenario();
    const diagnostico = await prisma.service.create({
      data: {
        clinicId: e.clinic.id,
        name: "Diagnóstico",
        durationMinutes: 30,
        firstVisit: true,
        professionals: { connect: [{ id: e.gomez.id }] },
      },
    });
    const nuevo = await prisma.patient.create({
      data: { clinicId: e.clinic.id, phone: "5494000000000", name: "Nuevo" },
    });

    const r = await crear(e, { patientId: nuevo.id });
    expect(r).toMatchObject({ ok: false, reason: "requiere_confirmacion" });
    if (!r.ok && r.reason === "requiere_confirmacion") {
      expect(r.violations.map((v) => v.rule)).toContain("primera_vez_sin_diagnostico");
    }
    // Con el diagnóstico no hay nada que confirmar.
    const ok = await crear(e, { patientId: nuevo.id, serviceId: diagnostico.id });
    expect(ok.ok).toBe(true);
  });

  it("rechaza datos de otra clínica", async () => {
    const e = await crearEscenario();
    const ajena = await crearEscenario();
    const r = await crear(e, { serviceId: ajena.limpieza.id });
    expect(r).toMatchObject({ ok: false, reason: "no_encontrado" });
  });
});

describe("un servicio que requiere un equipo que ya está ocupado", () => {
  it("el mensaje nombra el equipo ocupado, no dice solo que falta una unidad", async () => {
    const e = await crearEscenario();
    await prisma.resource.create({
      data: { clinicId: e.clinic.id, name: "Motor de implantes #1", type: "motor_implantes", active: true },
    });
    const implante = await prisma.service.create({
      data: {
        clinicId: e.clinic.id,
        name: "Colocación de implante",
        durationMinutes: 60,
        requiredResourceType: "motor_implantes",
        professionals: { connect: [{ id: e.gomez.id }, { id: e.ruiz.id }] },
      },
    });

    const primera = await crear(e, { serviceId: implante.id, professionalId: e.ruiz.id });
    expect(primera.ok).toBe(true);

    const segunda = await crear(e, { serviceId: implante.id, professionalId: e.gomez.id, patientId: e.otro.id });

    expect(segunda).toMatchObject({ ok: false, reason: "sin_equipo" });
    expect((segunda as { message: string }).message).toBe(
      'El equipo "Motor de implantes #1" no está libre en ese horario y el servicio lo requiere.'
    );
  });
});

describe("sinEquipoMessage", () => {
  it("nombra una unidad, varias, o cae al mensaje genérico si no se conocen", () => {
    expect(sinEquipoMessage(["Láser #1"])).toBe('El equipo "Láser #1" no está libre en ese horario y el servicio lo requiere.');
    expect(sinEquipoMessage(["Láser #1", "Láser #2"])).toContain('"Láser #1", "Láser #2"');
    expect(sinEquipoMessage([])).toBe("No hay una unidad libre del equipo que requiere el servicio.");
  });
});

describe("mover y editar una cita", () => {
  it("mover a un horario que se pisa con ella misma funciona y conserva la duración", async () => {
    const e = await crearEscenario();
    const creada = await crear(e, { serviceId: e.blanqueamiento.id, professionalId: e.ruiz.id });
    expect(creada.ok).toBe(true);
    if (!creada.ok) return;

    // 60 min a las 10:00 → 10:30 se pisa con sí misma.
    const r = await updateAppointment({
      clinic: e.clinic,
      userId: "user-2",
      appointmentId: creada.appointment.id,
      changes: { time: "10:30" },
      now: ANTES,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.appointment.startTime.toISOString()).toBe("2030-06-17T10:30:00.000Z");
    expect(r.appointment.endTime.toISOString()).toBe("2030-06-17T11:30:00.000Z");
    expect(r.appointment.modifiedByUserId).toBe("user-2");
    expect(r.appointment.id).toBe(creada.appointment.id);
  });

  it("mover la cita de hora borra las marcas de recordatorio (otro horario = otro aviso); editar otra cosa no", async () => {
    const e = await crearEscenario();
    const creada = await crear(e);
    if (!creada.ok) throw new Error("fixture");
    const id = creada.appointment.id;
    const marca = new Date();
    await prisma.appointment.update({ where: { id }, data: { reminder24SentAt: marca, reminder2hSentAt: marca } });

    // Mismo horario (solo la duración/servicio no cambian la hora): las marcas se conservan.
    await updateAppointment({ clinic: e.clinic, userId: "u", appointmentId: id, changes: { time: "10:00" }, now: ANTES });
    let f = (await prisma.appointment.findUnique({ where: { id } }))!;
    expect(f.reminder24SentAt).not.toBeNull();

    // Otra hora: hay que volver a avisar.
    const r = await updateAppointment({ clinic: e.clinic, userId: "u", appointmentId: id, changes: { time: "11:00" }, now: ANTES });
    expect(r.ok).toBe(true);
    f = (await prisma.appointment.findUnique({ where: { id } }))!;
    expect(f.reminder24SentAt).toBeNull();
    expect(f.reminder2hSentAt).toBeNull();
  });

  it("mover a otro día conserva la hora, el profesional y el servicio", async () => {
    const e = await crearEscenario();
    const creada = await crear(e);
    if (!creada.ok) throw new Error("fixture");
    const r = await updateAppointment({
      clinic: e.clinic,
      userId: "u",
      appointmentId: creada.appointment.id,
      changes: { date: "2030-06-18" },
      now: ANTES,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.appointment.startTime.toISOString()).toBe("2030-06-18T10:00:00.000Z");
    expect(r.appointment.professionalId).toBe(e.gomez.id);
    expect(r.appointment.service).toBe("Limpieza");
  });

  it("mover a un hueco ocupado pide confirmación y, sin ella, la cita no se toca", async () => {
    const e = await crearEscenario();
    const a = await crear(e, { time: "10:00" });
    await crear(e, { patientId: e.otro.id, time: "11:00", roomId: e.sala2.id });
    if (!a.ok) throw new Error("fixture");

    const r = await updateAppointment({
      clinic: e.clinic,
      userId: "u",
      appointmentId: a.appointment.id,
      changes: { time: "11:00" },
      now: ANTES,
    });
    expect(r).toMatchObject({ ok: false, reason: "requiere_confirmacion" });
    const intacta = await prisma.appointment.findUniqueOrThrow({ where: { id: a.appointment.id } });
    expect(intacta.startTime.toISOString()).toBe("2030-06-17T10:00:00.000Z");

    const forzada = await updateAppointment({
      clinic: e.clinic,
      userId: "u",
      appointmentId: a.appointment.id,
      changes: { time: "11:00" },
      force: true,
      now: ANTES,
    });
    expect(forzada.ok).toBe(true);
    if (forzada.ok) expect(forzada.forcedRules).toContain("profesional_ocupado");
  });

  it("un cambio que arregla la regla forzada limpia la constancia", async () => {
    const e = await crearEscenario();
    const forzada = await crear(e, { time: "21:00", force: true });
    if (!forzada.ok) throw new Error("fixture");
    expect(forzada.appointment.forcedRules).toContain("clinica_cerrada");

    const r = await updateAppointment({
      clinic: e.clinic,
      userId: "u",
      appointmentId: forzada.appointment.id,
      changes: { time: "10:00" },
      now: ANTES,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.appointment.forcedRules).toEqual([]);
  });

  it("cambiar de profesional a uno que no realiza el servicio se rechaza, aun forzando", async () => {
    const e = await crearEscenario();
    const creada = await crear(e, { serviceId: e.blanqueamiento.id, professionalId: e.ruiz.id });
    if (!creada.ok) throw new Error("fixture");

    for (const force of [false, true]) {
      const r = await updateAppointment({
        clinic: e.clinic,
        userId: "u",
        appointmentId: creada.appointment.id,
        changes: { professionalId: e.gomez.id },
        force,
        now: ANTES,
      });
      expect(r).toMatchObject({ ok: false, reason: "profesional_no_hace_servicio" });
    }
    // La cita quedó como estaba.
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: creada.appointment.id } })).professionalId).toBe(e.ruiz.id);
  });

  it("mover de hora una cita cuyo profesional ya no tiene el servicio asignado (cita anterior a la regla) sí se puede", async () => {
    const e = await crearEscenario();
    const creada = await crear(e, { serviceId: e.blanqueamiento.id, professionalId: e.ruiz.id });
    if (!creada.ok) throw new Error("fixture");
    // Después de agendada, a Ruiz le quitan el servicio.
    await prisma.service.update({ where: { id: e.blanqueamiento.id }, data: { professionals: { disconnect: [{ id: e.ruiz.id }] } } });
    const r = await updateAppointment({
      clinic: e.clinic,
      userId: "u",
      appointmentId: creada.appointment.id,
      changes: { time: "11:00" },
      now: ANTES,
    });
    expect(r.ok).toBe(true);
  });

  it("cambiar el servicio cambia la duración, salvo que se indique otra", async () => {
    const e = await crearEscenario();
    const creada = await crear(e, { professionalId: e.ruiz.id });
    if (!creada.ok) throw new Error("fixture");
    const r = await updateAppointment({
      clinic: e.clinic,
      userId: "u",
      appointmentId: creada.appointment.id,
      changes: { serviceId: e.blanqueamiento.id },
      now: ANTES,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.appointment.endTime.toISOString()).toBe("2030-06-17T11:00:00.000Z");
  });

  it("no toca una cita de otra clínica ni una ya cancelada", async () => {
    const e = await crearEscenario();
    const ajena = await crearEscenario();
    const deAjena = await crear(ajena);
    if (!deAjena.ok) throw new Error("fixture");

    const r = await updateAppointment({
      clinic: e.clinic,
      userId: "u",
      appointmentId: deAjena.appointment.id,
      changes: { time: "12:00" },
      now: ANTES,
    });
    expect(r).toMatchObject({ ok: false, reason: "no_encontrado" });

    const propia = await crear(e);
    if (!propia.ok) throw new Error("fixture");
    await cancelAppointment({ clinic: e.clinic, userId: "u", appointmentId: propia.appointment.id });
    const r2 = await updateAppointment({
      clinic: e.clinic,
      userId: "u",
      appointmentId: propia.appointment.id,
      changes: { time: "12:00" },
      now: ANTES,
    });
    expect(r2).toMatchObject({ ok: false, reason: "no_encontrado" });
  });
});

describe("cancelar una cita", () => {
  it("la cancela, libera el hueco y una segunda vez ya no la encuentra", async () => {
    const e = await crearEscenario();
    const creada = await crear(e, { roomId: e.sala1.id });
    if (!creada.ok) throw new Error("fixture");

    const r = await cancelAppointment({ clinic: e.clinic, userId: "u", appointmentId: creada.appointment.id });
    expect(r).toMatchObject({ ok: true, patientNotice: null });
    const cancelada = await prisma.appointment.findUniqueOrThrow({ where: { id: creada.appointment.id } });
    expect(cancelada.status).toBe("cancelado");
    expect(cancelada.modifiedByUserId).toBe("u");

    // El espacio quedó libre.
    const otra = await crear(e, { patientId: e.otro.id, professionalId: e.ruiz.id, roomId: e.sala1.id });
    expect(otra.ok).toBe(true);

    const de_nuevo = await cancelAppointment({ clinic: e.clinic, userId: "u", appointmentId: creada.appointment.id });
    expect(de_nuevo).toMatchObject({ ok: false, reason: "no_encontrado" });
  });

  it("no cancela la cita de otra clínica", async () => {
    const e = await crearEscenario();
    const ajena = await crearEscenario();
    const deAjena = await crear(ajena);
    if (!deAjena.ok) throw new Error("fixture");
    const r = await cancelAppointment({ clinic: e.clinic, userId: "u", appointmentId: deAjena.appointment.id });
    expect(r.ok).toBe(false);
    const sigue = await prisma.appointment.findUniqueOrThrow({ where: { id: deAjena.appointment.id } });
    expect(sigue.status).toBe("confirmado");
  });
});

describe("bloqueos manuales", () => {
  const rango = { date: LUNES, startTime: "12:00", endTime: "13:00" };

  it("frenan al profesional como un evento importado, uno por profesional", async () => {
    const e = await crearEscenario();
    const r = await createManualBlocks({
      clinicId: e.clinic.id,
      timezone: "UTC",
      userId: "u",
      professionalIds: [e.gomez.id, e.ruiz.id],
      title: "Reunión de equipo",
      ...rango,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks.every((b) => b.source === "manual" && b.title === "Reunión de equipo")).toBe(true);

    const inicio = new Date("2030-06-17T12:00:00.000Z");
    const fin = new Date("2030-06-17T12:30:00.000Z");
    expect(await hasCalendarBlock(e.clinic.id, e.gomez.id, inicio, fin)).toBe(true);

    // Y una cita en ese rato pide confirmación: `profesional_bloqueado`.
    const cita = await crear(e, { time: "12:00" });
    expect(cita).toMatchObject({ ok: false, reason: "requiere_confirmacion" });
    if (!cita.ok && cita.reason === "requiere_confirmacion") {
      expect(cita.violations.map((v) => v.rule)).toContain("profesional_bloqueado");
    }
  });

  it("todo el día", async () => {
    const e = await crearEscenario();
    const r = await createManualBlocks({
      clinicId: e.clinic.id,
      timezone: "UTC",
      userId: "u",
      professionalIds: [e.gomez.id],
      title: "Vacaciones",
      date: LUNES,
      allDay: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.blocks[0].isAllDay).toBe(true);
    expect(r.blocks[0].endTime.getTime() - r.blocks[0].startTime.getTime()).toBe(24 * 3600 * 1000);
  });

  it("rechaza título vacío, rangos al revés y profesionales de otra clínica", async () => {
    const e = await crearEscenario();
    const ajena = await crearEscenario();
    const base = { clinicId: e.clinic.id, timezone: "UTC", userId: "u", professionalIds: [e.gomez.id] };
    expect(await createManualBlocks({ ...base, title: " ", ...rango })).toMatchObject({ ok: false });
    expect(
      await createManualBlocks({ ...base, title: "x", date: LUNES, startTime: "13:00", endTime: "12:00" })
    ).toMatchObject({ ok: false, reason: "datos_invalidos" });
    expect(
      await createManualBlocks({ ...base, professionalIds: [ajena.gomez.id], title: "x", ...rango })
    ).toMatchObject({ ok: false, reason: "no_encontrado" });
  });

  it("se mueven y se borran; los importados del calendario no", async () => {
    const e = await crearEscenario();
    const r = await createManualBlocks({
      clinicId: e.clinic.id,
      timezone: "UTC",
      userId: "u",
      professionalIds: [e.gomez.id],
      title: "Almuerzo",
      ...rango,
    });
    if (!r.ok) throw new Error("fixture");

    const movido = await updateManualBlock({
      clinicId: e.clinic.id,
      timezone: "UTC",
      blockId: r.blocks[0].id,
      changes: { date: "2030-06-18", startTime: "13:00" },
    });
    expect(movido.ok).toBe(true);
    if (movido.ok) {
      expect(movido.blocks[0].startTime.toISOString()).toBe("2030-06-18T13:00:00.000Z");
      // Conserva la duración (1 h).
      expect(movido.blocks[0].endTime.toISOString()).toBe("2030-06-18T14:00:00.000Z");
    }

    const importado = await prisma.calendarBlock.create({
      data: {
        clinicId: e.clinic.id,
        professionalId: e.gomez.id,
        googleEventId: "ext-1",
        startTime: new Date("2030-06-19T10:00:00.000Z"),
        endTime: new Date("2030-06-19T11:00:00.000Z"),
      },
    });
    expect((await deleteManualBlock(e.clinic.id, importado.id)).ok).toBe(false);
    expect(
      (await updateManualBlock({
        clinicId: e.clinic.id,
        timezone: "UTC",
        blockId: importado.id,
        changes: { startTime: "12:00" },
      })).ok
    ).toBe(false);

    expect((await deleteManualBlock(e.clinic.id, r.blocks[0].id)).ok).toBe(true);
  });
});
