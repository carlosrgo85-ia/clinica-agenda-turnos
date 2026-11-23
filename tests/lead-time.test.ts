import { afterEach, describe, expect, it } from "vitest";
import type { Clinic, Patient, Weekday } from "@prisma/client";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import { CLINIC_CALENDAR_INCLUDE } from "../src/services/calendar";
import type { ClinicWithCalendarAccount } from "../src/repositories/clinics.repository";
import { findAvailableSlots } from "../src/services/availability-slots";
import { createAppointmentFromRequest } from "../src/services/booking";
import { createManualAppointment } from "../src/services/appointment-admin";
import {
  describeLeadTime,
  isValidLeadMinutes,
  MAX_LEAD_MINUTES,
  violatesLeadTime,
} from "../src/services/lead-time";

/**
 * Anticipación mínima para reservar (`Clinic.minLeadMinutes`).
 *
 * Lo que importa es que los TRES caminos que deciden un horario coincidan:
 * ofrecerlo, agendarlo y la Agenda editable. Si el enumerador ofreciera algo
 * que booking.ts rechaza (o al revés), el paciente vería horarios que rebotan.
 */

const LUNES = "2030-06-17";
const DIAS: Weekday[] = ["lunes", "martes", "miercoles", "jueves", "viernes"];
/** Lunes a las 09:00 UTC, con la clínica abierta de 9 a 18. */
const AHORA = new Date("2030-06-17T09:00:00.000Z");
const clinicIds: string[] = [];

async function crearEscenario(minLeadMinutes: number) {
  const creada = await prisma.clinic.create({
    data: {
      name: `Clínica lead ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `lead-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: "UTC",
      services: "x",
      minLeadMinutes,
      professionals: { create: [{ name: "Gómez" }] },
      rooms: { create: [{ name: "Sala 1" }] },
      workingHours: {
        create: DIAS.map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 18 * 60 })),
      },
    },
    include: { professionals: true },
  });
  clinicIds.push(creada.id);

  const clinic = (await prisma.clinic.findUniqueOrThrow({
    where: { id: creada.id },
    include: CLINIC_CALENDAR_INCLUDE,
  })) as ClinicWithCalendarAccount;
  const gomez = creada.professionals[0];
  const servicio = await prisma.service.create({
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
  // Para que no sea de "primera vez".
  await prisma.appointment.create({
    data: {
      clinicId: clinic.id,
      patientId: paciente.id,
      professionalId: gomez.id,
      roomId: (await prisma.room.findFirstOrThrow({ where: { clinicId: clinic.id } })).id,
      service: "Historial",
      startTime: new Date("2020-01-01T10:00:00.000Z"),
      endTime: new Date("2020-01-01T10:30:00.000Z"),
      status: "atendido",
    },
  });
  return { clinic, gomez, servicio, paciente };
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

describe("violatesLeadTime", () => {
  const ahora = new Date("2030-06-17T09:00:00.000Z");
  const en = (min: number) => new Date(ahora.getTime() + min * 60_000);

  it("con margen 0 nunca se viola", () => {
    expect(violatesLeadTime(en(1), ahora, 0)).toBe(false);
    expect(violatesLeadTime(en(0), ahora, 0)).toBe(false);
  });

  it("antes del margen se viola, justo en el margen no", () => {
    expect(violatesLeadTime(en(119), ahora, 120)).toBe(true);
    expect(violatesLeadTime(en(120), ahora, 120)).toBe(false);
    expect(violatesLeadTime(en(121), ahora, 120)).toBe(false);
  });
});

describe("describeLeadTime", () => {
  it("lo dice en la unidad más natural", () => {
    expect(describeLeadTime(30)).toBe("30 minutos");
    expect(describeLeadTime(60)).toBe("1 hora");
    expect(describeLeadTime(120)).toBe("2 horas");
    expect(describeLeadTime(90)).toBe("90 minutos");
    expect(describeLeadTime(1440)).toBe("1 día");
    expect(describeLeadTime(2880)).toBe("2 días");
  });
});

describe("isValidLeadMinutes", () => {
  it("acepta enteros de 0 a una semana y rechaza el resto", () => {
    expect(isValidLeadMinutes(0)).toBe(true);
    expect(isValidLeadMinutes(MAX_LEAD_MINUTES)).toBe(true);
    expect(isValidLeadMinutes(-1)).toBe(false);
    expect(isValidLeadMinutes(MAX_LEAD_MINUTES + 1)).toBe(false);
    expect(isValidLeadMinutes(1.5)).toBe(false);
    expect(isValidLeadMinutes("60")).toBe(false);
    expect(isValidLeadMinutes(null)).toBe(false);
  });
});

describe("el default", () => {
  it("una clínica nueva, sin elegir nada, pide 60 minutos de anticipación", async () => {
    const clinic = await prisma.clinic.create({
      data: {
        name: `Clínica default ${Date.now()}-${Math.random()}`,
        whatsappPhoneNumberId: `def-${Date.now()}-${Math.random()}`,
        whatsappTokenEncrypted: encryptToken("test"),
        email: "test@example.com",
        services: "x",
      },
    });
    clinicIds.push(clinic.id);
    expect(clinic.minLeadMinutes).toBe(60);
  });
});

describe("la base impone el rango", () => {
  it("un CHECK rechaza un valor negativo o mayor a una semana", async () => {
    const { clinic } = await crearEscenario(0);
    await expect(
      prisma.clinic.update({ where: { id: clinic.id }, data: { minLeadMinutes: -5 } })
    ).rejects.toThrow();
    await expect(
      prisma.clinic.update({ where: { id: clinic.id }, data: { minLeadMinutes: MAX_LEAD_MINUTES + 1 } })
    ).rejects.toThrow();
  });
});

describe("ofrecer horarios", () => {
  const huecos = (clinic: Clinic) =>
    findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 30,
      now: AHORA,
    });

  it("sin mínimo, ofrece desde el próximo cuarto de hora", async () => {
    const { clinic } = await crearEscenario(0);
    const { days } = await huecos(clinic);
    expect(days[0].slots[0].time).toBe("09:15");
  });

  it("con 2 horas de mínimo, no ofrece nada antes de las 11:00", async () => {
    const { clinic } = await crearEscenario(120);
    const { days } = await huecos(clinic);
    const horas = days[0].slots.map((s) => s.time);
    expect(horas[0]).toBe("11:00");
    expect(horas.some((h) => h < "11:00")).toBe(false);
  });

  it("si todo el día cae dentro del margen, el día queda sin horarios", async () => {
    const { clinic } = await crearEscenario(24 * 60);
    const { days } = await huecos(clinic);
    expect(days[0].slots).toEqual([]);
    expect(days[0].reason).toBe("anticipacion_minima");
  });
});

describe("agendar", () => {
  const pedir = (e: Awaited<ReturnType<typeof crearEscenario>>, hora: string) =>
    createAppointmentFromRequest({
      clinic: e.clinic,
      patient: e.paciente,
      requestedDate: LUNES,
      requestedTime: hora,
      requestedService: "Limpieza",
      now: AHORA,
    });

  it("rechaza un horario dentro del margen", async () => {
    const e = await crearEscenario(120);
    expect(await pedir(e, "10:00")).toEqual({ ok: false, reason: "anticipacion_insuficiente" });
  });

  it("acepta justo en el margen", async () => {
    const e = await crearEscenario(120);
    expect((await pedir(e, "11:00")).ok).toBe(true);
  });

  it("sin mínimo agenda para dentro de un rato, como antes", async () => {
    const e = await crearEscenario(0);
    expect((await pedir(e, "09:15")).ok).toBe(true);
  });

  it("un horario pasado sigue siendo 'fecha_en_el_pasado', no 'anticipación'", async () => {
    const e = await crearEscenario(120);
    expect(await pedir(e, "08:00")).toEqual({ ok: false, reason: "fecha_en_el_pasado" });
  });

  it("coincide con lo que se ofrece: cada hueco ofrecido se puede agendar", async () => {
    const e = await crearEscenario(120);
    const { days } = await findAvailableSlots({
      clinic: e.clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 30,
      now: AHORA,
    });
    for (const slot of days[0].slots.slice(0, 4)) {
      const r = await createAppointmentFromRequest({
        clinic: e.clinic,
        patient: e.paciente,
        requestedDate: LUNES,
        requestedTime: slot.time,
        requestedService: "Limpieza",
        now: AHORA,
      });
      expect(r).not.toMatchObject({ reason: "anticipacion_insuficiente" });
    }
  });
});

describe("la Agenda editable", () => {
  const crear = (e: Awaited<ReturnType<typeof crearEscenario>>, force?: boolean) =>
    createManualAppointment({
      clinic: e.clinic,
      userId: "user-1",
      patientId: e.paciente.id,
      serviceId: e.servicio.id,
      professionalId: e.gomez.id,
      date: LUNES,
      time: "10:00",
      force,
      now: AHORA,
    });

  it("es una regla blanda: pide confirmación y explica con cuánto margen", async () => {
    const e = await crearEscenario(120);
    const r = await crear(e);
    expect(r).toMatchObject({ ok: false, reason: "requiere_confirmacion" });
    if (r.ok || r.reason !== "requiere_confirmacion") return;
    expect(r.violations.map((v) => v.rule)).toEqual(["anticipacion_minima"]);
    expect(r.violations[0].message).toContain("2 horas");
  });

  it("confirmando se agenda y queda constancia", async () => {
    const e = await crearEscenario(120);
    const r = await crear(e, true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.appointment.forcedRules).toContain("anticipacion_minima");
  });

  it("sin mínimo no pide nada", async () => {
    const e = await crearEscenario(0);
    const r = await crear(e);
    expect(r.ok).toBe(true);
  });
});
