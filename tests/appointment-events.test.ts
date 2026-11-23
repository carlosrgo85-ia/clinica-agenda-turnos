import { afterEach, describe, expect, it } from "vitest";
import { purgeAuditForClinics } from "./helpers/audit";
import type { Weekday } from "@prisma/client";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import { CLINIC_CALENDAR_INCLUDE } from "../src/services/calendar";
import type { ClinicWithCalendarAccount } from "../src/repositories/clinics.repository";
import { createAppointmentFromRequest } from "../src/services/booking";
import {
  cancelAppointment,
  createManualAppointment,
  updateAppointment,
} from "../src/services/appointment-admin";
import { cleanCancelReason, MAX_CANCEL_REASON } from "../src/services/appointment-events";
import { markAppointmentAttended, unmarkAppointmentAttended } from "../src/services/packages";

/**
 * Los eventos de la vida de una cita: la fuente de los reportes de canceladas,
 * reagendadas y atendidas. Lo que más importa son las DEFINICIONES: reagendar no es
 * crear, mover no es cancelar, y lo que el sistema dio por atendido no se confunde
 * con lo que una persona confirmó.
 */

const LUNES = "2030-06-17";
const DIAS: Weekday[] = ["lunes", "martes", "miercoles", "jueves", "viernes"];
const AHORA = new Date("2030-06-17T06:00:00.000Z");
const clinicIds: string[] = [];

async function escenario() {
  const creada = await prisma.clinic.create({
    data: {
      name: `Clínica eventos ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `ev-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: "UTC",
      services: "x",
      minLeadMinutes: 0,
      professionals: { create: [{ name: "Gómez" }, { name: "Ruiz" }] },
      rooms: { create: [{ name: "Sala 1" }, { name: "Sala 2" }] },
      workingHours: { create: DIAS.map((weekday) => ({ weekday, startMinute: 0, endMinute: 24 * 60 })) },
    },
    include: { professionals: { orderBy: { name: "asc" } }, rooms: { orderBy: { name: "asc" } } },
  });
  clinicIds.push(creada.id);
  const clinic = (await prisma.clinic.findUniqueOrThrow({ where: { id: creada.id }, include: CLINIC_CALENDAR_INCLUDE })) as ClinicWithCalendarAccount;
  const [gomez, ruiz] = creada.professionals;
  const [sala1, sala2] = creada.rooms;
  const servicio = await prisma.service.create({
    data: { clinicId: clinic.id, name: "Limpieza", durationMinutes: 30, professionals: { connect: [{ id: gomez.id }, { id: ruiz.id }] } },
  });
  const paciente = await prisma.patient.create({ data: { clinicId: clinic.id, phone: `5491${Math.floor(Math.random() * 1e9)}`, name: "Paciente" } });
  // Para que no sea de "primera vez".
  await prisma.appointment.create({
    data: {
      clinicId: clinic.id, patientId: paciente.id, professionalId: gomez.id, roomId: sala1.id, service: "Historial",
      startTime: new Date("2020-01-01T10:00:00Z"), endTime: new Date("2020-01-01T10:30:00Z"), status: "atendido",
    },
  });
  return { clinic, gomez, ruiz, sala1, sala2, servicio, paciente };
}
type E = Awaited<ReturnType<typeof escenario>>;

const eventos = (appointmentId: string) =>
  prisma.appointmentEvent.findMany({ where: { appointmentId }, orderBy: { occurredAt: "asc" } });

/** Una reserva por WhatsApp. */
const reservar = (e: E, hora: string, over?: Partial<Parameters<typeof createAppointmentFromRequest>[0]>) =>
  createAppointmentFromRequest({
    clinic: e.clinic, patient: e.paciente, requestedDate: LUNES, requestedTime: hora, requestedService: "Limpieza", now: AHORA, ...over,
  });

/** Una cita desde el panel. */
const crearEnPanel = (e: E, over?: Partial<Parameters<typeof createManualAppointment>[0]>) =>
  createManualAppointment({
    clinic: e.clinic, userId: "usuario-1", patientId: e.paciente.id, serviceId: e.servicio.id, professionalId: e.gomez.id,
    date: LUNES, time: "10:00", now: AHORA, ...over,
  });

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

describe("crear una cita", () => {
  it("por WhatsApp: evento 'creada' del paciente, con la hora y el profesional", async () => {
    const e = await escenario();
    const r = await reservar(e, "10:00");
    if (!r.ok) throw new Error("fixture");
    const [ev] = await eventos(r.appointment.id);
    expect(ev).toMatchObject({
      type: "creada", actorKind: "paciente", actorUserId: null, clinicId: e.clinic.id,
      relatedAppointmentId: null, fromStartTime: null,
    });
    expect(ev.toStartTime?.toISOString()).toBe("2030-06-17T10:00:00.000Z");
    expect(ev.toProfessionalId).toBeTruthy();
  });

  it("desde el panel: evento 'creada' del usuario, con las reglas que se forzaron", async () => {
    const e = await escenario();
    // Un sobreturno: otro paciente con el mismo profesional a la misma hora (una misma
    // persona no puede tener dos citas que se pisan: esa regla es dura).
    const otro = await prisma.patient.create({ data: { clinicId: e.clinic.id, phone: "5491100000555", name: "Otro" } });
    await prisma.appointment.create({
      data: {
        clinicId: e.clinic.id, patientId: otro.id, professionalId: e.gomez.id, roomId: e.sala1.id, service: "Historial",
        startTime: new Date("2020-01-01T10:00:00Z"), endTime: new Date("2020-01-01T10:30:00Z"), status: "atendido",
      },
    });
    await crearEnPanel(e, { time: "10:00" });
    const sobreturno = await crearEnPanel(e, { time: "10:00", roomId: e.sala2.id, patientId: otro.id, force: true });
    if (!sobreturno.ok) throw new Error(JSON.stringify(sobreturno));
    const [ev] = await eventos(sobreturno.appointment.id);
    expect(ev).toMatchObject({ type: "creada", actorKind: "usuario", actorUserId: "usuario-1" });
    expect(ev.details).toMatchObject({ reglasForzadas: expect.arrayContaining(["profesional_ocupado"]) });
  });

  it("si la reserva falla no queda ningún evento", async () => {
    const e = await escenario();
    await reservar(e, "10:00");
    const antes = await prisma.appointmentEvent.count({ where: { clinicId: e.clinic.id } });
    // El mismo paciente, a la misma hora: se rechaza.
    const r = await reservar(e, "10:00");
    expect(r.ok).toBe(false);
    expect(await prisma.appointmentEvent.count({ where: { clinicId: e.clinic.id } })).toBe(antes);
  });
});

describe("reagendar por WhatsApp (se da de baja la vieja y se crea una nueva)", () => {
  async function reagendar(e: E) {
    const original = await reservar(e, "10:00");
    if (!original.ok) throw new Error("fixture");
    const nueva = await reservar(e, "15:00", { replaceAppointmentId: original.appointment.id });
    if (!nueva.ok) throw new Error(JSON.stringify(nueva));
    return { original: original.appointment, nueva: nueva.appointment };
  }

  it("la nueva apunta a la vieja, y la vieja queda como 'reprogramacion', no como cancelación", async () => {
    const e = await escenario();
    const { original, nueva } = await reagendar(e);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: nueva.id } })).rescheduledFromId).toBe(original.id);
    const vieja = await prisma.appointment.findUniqueOrThrow({ where: { id: original.id } });
    expect(vieja).toMatchObject({ status: "cancelado", cancelledByKind: "reprogramacion", cancelledByUserId: null });
    expect(vieja.cancelledAt).toBeTruthy();
  });

  it("el evento es UN 'reagendada' en la cita nueva, con de dónde a dónde, y sin 'creada'", async () => {
    const e = await escenario();
    const { original, nueva } = await reagendar(e);
    const evs = await eventos(nueva.id);
    expect(evs.map((x) => x.type)).toEqual(["reagendada"]);
    expect(evs[0]).toMatchObject({ actorKind: "paciente", relatedAppointmentId: original.id });
    expect(evs[0].fromStartTime?.toISOString()).toBe("2030-06-17T10:00:00.000Z");
    expect(evs[0].toStartTime?.toISOString()).toBe("2030-06-17T15:00:00.000Z");
  });

  it("reagendar NO cuenta como cancelación ni como reserva nueva en los reportes", async () => {
    const e = await escenario();
    await reagendar(e);
    const por = async (type: string) => prisma.appointmentEvent.count({ where: { clinicId: e.clinic.id, type } });
    expect(await por("cancelada")).toBe(0); // la vieja no tiene evento de cancelación
    expect(await por("creada")).toBe(1); // solo la reserva original
    expect(await por("reagendada")).toBe(1);
    // Y los que de verdad se canceló: ninguno.
    expect(await prisma.appointment.count({ where: { clinicId: e.clinic.id, status: "cancelado", cancelledByKind: { not: "reprogramacion" } } })).toBe(0);
  });

  it("si el horario nuevo no se puede, todo se revierte: la vieja sigue vigente y no hay eventos nuevos", async () => {
    const e = await escenario();
    const original = await reservar(e, "10:00");
    if (!original.ok) throw new Error("fixture");
    const antes = await prisma.appointmentEvent.count({ where: { clinicId: e.clinic.id } });
    // Un horario pasado: se rechaza.
    const r = await reservar(e, "05:00", { replaceAppointmentId: original.appointment.id });
    expect(r.ok).toBe(false);
    const vieja = await prisma.appointment.findUniqueOrThrow({ where: { id: original.appointment.id } });
    expect(vieja).toMatchObject({ status: "confirmado", cancelledAt: null, cancelledByKind: null });
    expect(await prisma.appointmentEvent.count({ where: { clinicId: e.clinic.id } })).toBe(antes);
  });
});

describe("mover o editar desde la Agenda", () => {
  const mover = (e: E, id: string, changes: Parameters<typeof updateAppointment>[0]["changes"]) =>
    updateAppointment({ clinic: e.clinic, userId: "usuario-2", appointmentId: id, changes, now: AHORA });

  async function citaBase(e: E) {
    const r = await crearEnPanel(e);
    if (!r.ok) throw new Error("fixture");
    return r.appointment;
  }

  it("cambiar la hora es 'reagendada': la hora original queda en el evento aunque la fila se pise", async () => {
    const e = await escenario();
    const cita = await citaBase(e);
    const r = await mover(e, cita.id, { time: "14:30" });
    expect(r.ok).toBe(true);
    const evs = (await eventos(cita.id)).filter((x) => x.type === "reagendada");
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ actorKind: "usuario", actorUserId: "usuario-2", fromProfessionalId: e.gomez.id, toProfessionalId: e.gomez.id });
    expect(evs[0].fromStartTime?.toISOString()).toBe("2030-06-17T10:00:00.000Z");
    expect(evs[0].toStartTime?.toISOString()).toBe("2030-06-17T14:30:00.000Z");
    // La fila quedó con la hora nueva: sin el evento, la original se habría perdido.
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: cita.id } })).startTime.toISOString()).toBe("2030-06-17T14:30:00.000Z");
  });

  it("cambiar solo el profesional también es 'reagendada'", async () => {
    const e = await escenario();
    const cita = await citaBase(e);
    await mover(e, cita.id, { professionalId: e.ruiz.id });
    const ev = (await eventos(cita.id)).find((x) => x.type === "reagendada");
    expect(ev).toMatchObject({ fromProfessionalId: e.gomez.id, toProfessionalId: e.ruiz.id });
  });

  it("cambiar solo el espacio es 'editada', con qué cambió, y NO reagenda", async () => {
    const e = await escenario();
    const cita = await citaBase(e);
    await mover(e, cita.id, { roomId: e.sala2.id });
    const evs = (await eventos(cita.id)).filter((x) => x.type !== "creada");
    expect(evs.map((x) => x.type)).toEqual(["editada"]);
    expect(evs[0].details).toMatchObject({ campos: ["espacio"] });
  });

  it("guardar sin cambiar nada no genera evento", async () => {
    const e = await escenario();
    const cita = await citaBase(e);
    await mover(e, cita.id, { time: "10:00" });
    expect((await eventos(cita.id)).map((x) => x.type)).toEqual(["creada"]);
  });

  it("si el cambio se rechaza no queda evento", async () => {
    const e = await escenario();
    const cita = await citaBase(e);
    const r = await mover(e, cita.id, { roomId: "no-existe" });
    expect(r.ok).toBe(false);
    expect((await eventos(cita.id)).map((x) => x.type)).toEqual(["creada"]);
  });
});

describe("cancelar desde el panel", () => {
  it("guarda quién, cuándo y el motivo, en la cita y en el evento", async () => {
    const e = await escenario();
    const r = await crearEnPanel(e);
    if (!r.ok) throw new Error("fixture");
    const c = await cancelAppointment({ clinic: e.clinic, userId: "usuario-3", appointmentId: r.appointment.id, reason: "  No puede venir  " });
    expect(c.ok).toBe(true);
    const cita = await prisma.appointment.findUniqueOrThrow({ where: { id: r.appointment.id } });
    expect(cita).toMatchObject({ status: "cancelado", cancelledByKind: "clinica", cancelledByUserId: "usuario-3", cancelReason: "No puede venir" });
    expect(cita.cancelledAt).toBeTruthy();
    const ev = (await eventos(r.appointment.id)).find((x) => x.type === "cancelada");
    expect(ev).toMatchObject({ actorKind: "usuario", actorUserId: "usuario-3", reason: "No puede venir" });
    expect(ev?.fromStartTime?.toISOString()).toBe("2030-06-17T10:00:00.000Z");
  });

  it("el motivo es opcional", async () => {
    const e = await escenario();
    const r = await crearEnPanel(e);
    if (!r.ok) throw new Error("fixture");
    await cancelAppointment({ clinic: e.clinic, userId: "u", appointmentId: r.appointment.id });
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: r.appointment.id } })).cancelReason).toBeNull();
    expect((await eventos(r.appointment.id)).find((x) => x.type === "cancelada")?.reason).toBeNull();
  });

  it("cancelar dos veces deja UN solo evento", async () => {
    const e = await escenario();
    const r = await crearEnPanel(e);
    if (!r.ok) throw new Error("fixture");
    const primera = await cancelAppointment({ clinic: e.clinic, userId: "u", appointmentId: r.appointment.id });
    const segunda = await cancelAppointment({ clinic: e.clinic, userId: "u", appointmentId: r.appointment.id });
    expect(primera.ok).toBe(true);
    expect(segunda.ok).toBe(false);
    expect((await eventos(r.appointment.id)).filter((x) => x.type === "cancelada")).toHaveLength(1);
  });

  it("limpia y acota el motivo", () => {
    expect(cleanCancelReason("  hola \n  mundo  ")).toBe("hola mundo");
    expect(cleanCancelReason("   ")).toBeNull();
    expect(cleanCancelReason(undefined)).toBeNull();
    expect(cleanCancelReason(42)).toBeNull();
    expect(cleanCancelReason("x".repeat(500))).toHaveLength(MAX_CANCEL_REASON);
  });
});

describe("la asistencia", () => {
  it("marcar atendida y deshacer dejan sus eventos, a nombre de quien lo hizo", async () => {
    const e = await escenario();
    const r = await crearEnPanel(e);
    if (!r.ok) throw new Error("fixture");
    const despues = new Date("2030-06-17T11:00:00.000Z");
    await markAppointmentAttended({ clinicId: e.clinic.id, appointmentId: r.appointment.id, userId: "asistente-1", now: despues });
    await unmarkAppointmentAttended({ clinicId: e.clinic.id, appointmentId: r.appointment.id, userId: "asistente-2" });
    // Se ordenan por tipo y no por hora: el test inyecta un reloj para "atendida" y la
    // base usa el real para "desmarcada", así que sus fechas no son comparables entre sí.
    const evs = (await eventos(r.appointment.id)).filter((x) => x.type === "atendida" || x.type === "desmarcada");
    expect(evs.map((x) => [x.type, x.actorKind, x.actorUserId]).sort()).toEqual([
      ["atendida", "usuario", "asistente-1"],
      ["desmarcada", "usuario", "asistente-2"],
    ]);
  });

  it("marcarla dos veces no duplica el evento", async () => {
    const e = await escenario();
    const r = await crearEnPanel(e);
    if (!r.ok) throw new Error("fixture");
    const despues = new Date("2030-06-17T11:00:00.000Z");
    await markAppointmentAttended({ clinicId: e.clinic.id, appointmentId: r.appointment.id, userId: "a", now: despues });
    await markAppointmentAttended({ clinicId: e.clinic.id, appointmentId: r.appointment.id, userId: "a", now: despues });
    expect((await eventos(r.appointment.id)).filter((x) => x.type === "atendida")).toHaveLength(1);
  });

  it("lo que da por atendido el sistema se distingue de lo que confirmó una persona", async () => {
    const e = await escenario();
    const r = await crearEnPanel(e);
    if (!r.ok) throw new Error("fixture");
    // Lo mismo que hace el job de seguimiento a las 24 horas.
    const { recordAppointmentEvent } = await import("../src/services/appointment-events");
    await prisma.$transaction(async (tx) => {
      await tx.appointment.update({ where: { id: r.appointment.id }, data: { status: "atendido" } });
      await recordAppointmentEvent(tx, {
        clinicId: e.clinic.id, appointmentId: r.appointment.id, type: "atendida", actorKind: "sistema", details: { automatica: true },
      });
    });
    const persona = await prisma.appointmentEvent.count({ where: { clinicId: e.clinic.id, type: "atendida", actorKind: "usuario" } });
    const sistema = await prisma.appointmentEvent.count({ where: { clinicId: e.clinic.id, type: "atendida", actorKind: "sistema" } });
    expect({ persona, sistema }).toEqual({ persona: 0, sistema: 1 });
  });
});

describe("integridad", () => {
  it("los eventos se van con la cita y con la clínica (CASCADE), así que no estorban al limpiar", async () => {
    const e = await escenario();
    const r = await crearEnPanel(e);
    if (!r.ok) throw new Error("fixture");
    expect((await eventos(r.appointment.id)).length).toBeGreaterThan(0);
    await prisma.appointment.delete({ where: { id: r.appointment.id } });
    expect(await eventos(r.appointment.id)).toHaveLength(0);
  });

  it("borrar la cita vieja de un reagendado no rompe a la nueva (SET NULL)", async () => {
    const e = await escenario();
    const original = await reservar(e, "10:00");
    if (!original.ok) throw new Error("fixture");
    const nueva = await reservar(e, "15:00", { replaceAppointmentId: original.appointment.id });
    if (!nueva.ok) throw new Error("fixture");
    await prisma.appointment.delete({ where: { id: original.appointment.id } });
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: nueva.appointment.id } })).rescheduledFromId).toBeNull();
  });
});
