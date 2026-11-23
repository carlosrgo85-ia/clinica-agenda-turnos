import { afterEach, describe, expect, it } from "vitest";
import type { Clinic, Patient, Weekday } from "@prisma/client";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import { findSlotsForPatient } from "../src/services/availability-slots";
import { createAppointmentFromRequest } from "../src/services/booking";
import { formatAvailableSlots } from "../src/prompts/availability-context";
import { getConfigHealth } from "../src/services/config-health";
import {
  setProfessionalServices,
  setServiceProfessionals,
  setFirstVisitService,
} from "../src/repositories/professional-services.repository";

/**
 * Qué profesional realiza qué servicio. Contra el Postgres local.
 *
 * Lo que se prueba es que la regla se impone en los DOS caminos (el que
 * ofrece y el que agenda) y que un profesional sin servicios no hace nada.
 */

const LUNES = "2030-06-17";
const ANTES = new Date("2030-06-17T06:00:00.000Z");
const DIAS: Weekday[] = ["lunes", "martes", "miercoles", "jueves", "viernes"];

const clinicIds: string[] = [];

async function crearClinica() {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica servicios ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `sp-${Date.now()}-${Math.random()}`,
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
    include: { professionals: { orderBy: { name: "asc" } } },
  });
  clinicIds.push(clinic.id);

  const [gomez, ruiz] = clinic.professionals;
  const limpieza = await prisma.service.create({
    data: {
      clinicId: clinic.id,
      name: "Limpieza",
      durationMinutes: 30,
      professionals: { connect: [{ id: gomez.id }, { id: ruiz.id }] },
    },
  });
  // Solo Ruiz hace blanqueamiento.
  const blanqueamiento = await prisma.service.create({
    data: {
      clinicId: clinic.id,
      name: "Blanqueamiento",
      durationMinutes: 60,
      professionals: { connect: [{ id: ruiz.id }] },
    },
  });
  const patient = await prisma.patient.create({
    data: { clinicId: clinic.id, phone: `5491${Math.floor(Math.random() * 1e9)}`, name: "Paciente" },
  });

  return { clinic, patient, gomez, ruiz, limpieza, blanqueamiento };
}

afterEach(async () => {
  for (const clinicId of clinicIds) {
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.service.deleteMany({ where: { clinicId } });
    await prisma.room.deleteMany({ where: { clinicId } });
    await prisma.workingHours.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

function pedido(
  f: { clinic: Clinic; patient: Patient },
  overrides: Partial<Parameters<typeof createAppointmentFromRequest>[0]>
) {
  return createAppointmentFromRequest({
    clinic: f.clinic,
    patient: f.patient,
    requestedDate: LUNES,
    requestedTime: "10:00",
    requestedService: "limpieza",
    now: ANTES,
    ...overrides,
  });
}

describe("agendar respeta quién hace cada servicio", () => {
  it("asigna solo a quien realiza el servicio, aunque otro esté libre antes", async () => {
    const f = await crearClinica();
    // Gómez tiene el id menor o no: da igual, el blanqueamiento es de Ruiz.
    const r = await pedido(f, { requestedService: "blanqueamiento" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.appointment.professionalId).toBe(f.ruiz.id);
  });

  it("ignora el pedido de un profesional que no hace el servicio", async () => {
    const f = await crearClinica();
    const r = await pedido(f, {
      requestedService: "blanqueamiento",
      requestedProfessionalId: f.gomez.id,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.appointment.professionalId).toBe(f.ruiz.id);
  });

  it("respeta el pedido cuando el profesional sí lo hace", async () => {
    const f = await crearClinica();
    const r = await pedido(f, { requestedProfessionalId: f.ruiz.id });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.appointment.professionalId).toBe(f.ruiz.id);
  });

  it("rechaza un servicio que ningún profesional activo realiza", async () => {
    const f = await crearClinica();
    await prisma.professional.update({ where: { id: f.ruiz.id }, data: { active: false } });
    const r = await pedido(f, { requestedService: "blanqueamiento" });
    expect(r).toEqual({ ok: false, reason: "servicio_sin_profesional" });
  });

  it("rechaza un servicio que la clínica no ofrece (con catálogo cargado)", async () => {
    const f = await crearClinica();
    const r = await pedido(f, { requestedService: "ortodoncia" });
    expect(r).toEqual({ ok: false, reason: "servicio_no_ofrecido" });
  });

  it("sin catálogo no restringe nada (compatibilidad)", async () => {
    const f = await crearClinica();
    await prisma.service.deleteMany({ where: { clinicId: f.clinic.id } });
    const r = await pedido(f, { requestedService: "ortodoncia" });
    expect(r.ok).toBe(true);
  });
});

describe("ofrecer horarios respeta quién hace cada servicio", () => {
  it("ofrece solo horarios de quien realiza el servicio", async () => {
    const f = await crearClinica();
    const r = await findSlotsForPatient({
      clinic: f.clinic,
      patient: f.patient,
      requestedService: "blanqueamiento",
      fromDateKey: LUNES,
      days: 1,
      now: ANTES,
    });
    const quienes = new Set(
      r.days.flatMap((d) => d.slots.flatMap((s) => s.candidateProfessionals.map((c) => c.id)))
    );
    expect([...quienes]).toEqual([f.ruiz.id]);
  });

  it("si piden a quien no lo hace, avisa y ofrece los de quien sí", async () => {
    const f = await crearClinica();
    const r = await findSlotsForPatient({
      clinic: f.clinic,
      patient: f.patient,
      requestedService: "blanqueamiento",
      requestedProfessionalId: f.gomez.id,
      fromDateKey: LUNES,
      days: 1,
      now: ANTES,
    });
    expect(r.requestedProfessionalNotAvailable).toBe("Gómez");
    const texto = formatAvailableSlots(r);
    expect(texto).toMatch(/^AVISO: Gómez no realiza este servicio/);
    expect(texto).toContain("Ruiz");
  });

  it("servicio no ofrecido y servicio sin profesional: no hay horarios, hay motivo", async () => {
    const f = await crearClinica();
    const noOfrecido = await findSlotsForPatient({
      clinic: f.clinic,
      patient: f.patient,
      requestedService: "ortodoncia",
      now: ANTES,
    });
    expect(noOfrecido.blocker).toBe("servicio_no_ofrecido");
    expect(formatAvailableSlots(noOfrecido)).toMatch(/no figura entre los que ofrece/);

    await prisma.professional.update({ where: { id: f.ruiz.id }, data: { active: false } });
    const sinNadie = await findSlotsForPatient({
      clinic: f.clinic,
      patient: f.patient,
      requestedService: "blanqueamiento",
      now: ANTES,
    });
    expect(sinNadie.blocker).toBe("servicio_sin_profesional");
  });
});

describe("servicio de primera vez", () => {
  it("el paciente nuevo parte por el diagnóstico, que solo hace su profesional", async () => {
    const f = await crearClinica();
    const diagnostico = await prisma.service.create({
      data: {
        clinicId: f.clinic.id,
        name: "Diagnóstico inicial",
        durationMinutes: 45,
        professionals: { connect: [{ id: f.gomez.id }] },
      },
    });
    expect(await setFirstVisitService(f.clinic.id, diagnostico.id, true)).toBe(true);

    // Pide un blanqueamiento (de Ruiz) y a Ruiz: como es nuevo, se le agenda
    // el diagnóstico con Gómez.
    const r = await pedido(f, {
      requestedService: "blanqueamiento",
      requestedProfessionalId: f.ruiz.id,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.appointment.professionalId).toBe(f.gomez.id);
    expect(r.appointment.service).toBe("Diagnóstico inicial");

    // Ya vino: el segundo turno es el que pide.
    const segundo = await pedido(f, {
      requestedService: "blanqueamiento",
      requestedTime: "14:00",
    });
    expect(segundo.ok).toBe(true);
    if (segundo.ok) expect(segundo.appointment.professionalId).toBe(f.ruiz.id);
  });

  it("una urgencia no pasa por el servicio de primera vez", async () => {
    const f = await crearClinica();
    const diagnostico = await prisma.service.create({
      data: {
        clinicId: f.clinic.id,
        name: "Diagnóstico inicial",
        durationMinutes: 45,
        professionals: { connect: [{ id: f.gomez.id }] },
      },
    });
    await setFirstVisitService(f.clinic.id, diagnostico.id, true);
    const r = await pedido(f, { requestedService: "limpieza", isUrgent: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.appointment.service).toBe("Limpieza");
  });

  it("marcar uno desmarca el anterior", async () => {
    const f = await crearClinica();
    await setFirstVisitService(f.clinic.id, f.limpieza.id, true);
    await setFirstVisitService(f.clinic.id, f.blanqueamiento.id, true);
    const marcados = await prisma.service.findMany({
      where: { clinicId: f.clinic.id, firstVisit: true },
    });
    expect(marcados.map((s) => s.id)).toEqual([f.blanqueamiento.id]);
  });
});

describe("administrar quién hace qué", () => {
  it("no deja quitar el último servicio de un profesional desde el servicio", async () => {
    const f = await crearClinica();
    // Ruiz hace Limpieza y Blanqueamiento; Gómez, solo Limpieza.
    const r = await setServiceProfessionals(f.clinic.id, f.limpieza.id, [f.ruiz.id]);
    expect(r).toMatchObject({ ok: false, reason: "quedarian_sin_servicios", professionals: ["Gómez"] });

    // Quitar a Ruiz de Blanqueamiento sí: le queda Limpieza.
    const ok = await setServiceProfessionals(f.clinic.id, f.blanqueamiento.id, []);
    expect(ok).toEqual({ ok: true });
  });

  it("no toca un profesional de otra clínica", async () => {
    const a = await crearClinica();
    const b = await crearClinica();
    expect(await setProfessionalServices(a.clinic.id, b.gomez.id, [])).toBe(false);
  });

  it("config-health avisa del profesional sin servicios y del servicio sin profesional", async () => {
    const f = await crearClinica();
    await setProfessionalServices(f.clinic.id, f.gomez.id, []);
    await prisma.professional.update({ where: { id: f.ruiz.id }, data: { active: false } });

    const health = await getConfigHealth(f.clinic.id);
    const codigos = health!.issues.map((i) => i.code);
    expect(codigos).toContain("profesional_sin_servicios");
    expect(codigos).toContain("servicio_sin_profesional");
  });
});
