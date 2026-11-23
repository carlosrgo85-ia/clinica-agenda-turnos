import { afterEach, describe, expect, it } from "vitest";
import type { Clinic, Patient, Weekday } from "@prisma/client";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import { findAvailableSlots, findSlotsForPatient } from "../src/services/availability-slots";
import { checkAvailability } from "../src/services/availability";
import { createAppointmentFromRequest } from "../src/services/booking";
import { checkWorkingHours } from "../src/services/working-hours";
import { clinicDateKey, clinicWallTimeToUtc, formatWallTime } from "../src/services/time";

/**
 * Enumeración de huecos libres para ofrecerle horarios al paciente. Va contra
 * el Postgres local (docker compose up -d db).
 *
 * Lo que más importa acá es el cuello de botella COMPARTIDO: un hueco no es
 * "el profesional está libre", porque las salas y los equipos los usan todos
 * los profesionales de la clínica. Y la consistencia con `checkAvailability`,
 * que es quien decide de verdad al crear el turno.
 */

const LUNES = "2030-06-17";
const MARTES = "2030-06-18";
const SABADO = "2030-06-22";

const DIAS_DE_SEMANA: Weekday[] = ["lunes", "martes", "miercoles", "jueves", "viernes"];

/** Antes de que abra la clínica del lunes, para que nada quede "en el pasado". */
const ANTES = new Date("2030-06-17T06:00:00.000Z");

const clinicIds: string[] = [];

/** Clínica de 9 a 13 y de 14 a 18, lunes a viernes. Comida de 13 a 14. */
async function crearClinica(options?: {
  profesionales?: number;
  salas?: number;
  timezone?: string;
  tramos?: Array<{ startMinute: number; endMinute: number }>;
}): Promise<{ clinic: Clinic; patient: Patient; professionalIds: string[] }> {
  const tramos = options?.tramos ?? [
    { startMinute: 9 * 60, endMinute: 13 * 60 },
    { startMinute: 14 * 60, endMinute: 18 * 60 },
  ];

  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica huecos ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `slots-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: options?.timezone ?? "UTC",
      services: "Consulta",
      professionals: {
        create: Array.from({ length: options?.profesionales ?? 1 }, (_, i) => ({
          name: `Profesional ${i + 1}`,
        })),
      },
      rooms: {
        create: Array.from({ length: options?.salas ?? 2 }, (_, i) => ({
          name: `Sala ${i + 1}`,
        })),
      },
      workingHours: {
        create: DIAS_DE_SEMANA.flatMap((weekday) =>
          tramos.map((t) => ({ weekday, startMinute: t.startMinute, endMinute: t.endMinute }))
        ),
      },
    },
    include: { professionals: { orderBy: { id: "asc" } } },
  });

  clinicIds.push(clinic.id);

  const patient = await prisma.patient.create({
    data: {
      clinicId: clinic.id,
      phone: `5491${Math.floor(Math.random() * 1e9)}`,
      name: "Paciente Test",
    },
  });

  return { clinic, patient, professionalIds: clinic.professionals.map((p) => p.id) };
}

/** Turno confirmado directo en la base, para armar la agenda del escenario. */
async function ocupar(params: {
  clinic: Clinic;
  patient: Patient;
  professionalId: string;
  roomId: string;
  resourceId?: string;
  dateKey: string;
  desde: string;
  hasta: string;
}): Promise<void> {
  const start = clinicWallTimeToUtc(params.dateKey, params.desde, params.clinic.timezone);
  const end = clinicWallTimeToUtc(params.dateKey, params.hasta, params.clinic.timezone);
  if (!start || !end) throw new Error("hora inválida en el fixture");

  await prisma.appointment.create({
    data: {
      clinicId: params.clinic.id,
      patientId: params.patient.id,
      professionalId: params.professionalId,
      roomId: params.roomId,
      resourceId: params.resourceId ?? null,
      service: "consulta",
      startTime: start,
      endTime: end,
    },
  });
}

/**
 * Otro paciente, para ocupar la agenda sin tocar el historial del que se está
 * probando: un turno propio lo dejaría de hacer "de primera vez".
 */
async function otroPaciente(clinicId: string): Promise<Patient> {
  return prisma.patient.create({
    data: {
      clinicId,
      phone: `5492${Math.floor(Math.random() * 1e9)}`,
      name: "Otro Paciente",
    },
  });
}

async function salasDe(clinicId: string): Promise<string[]> {
  const rooms = await prisma.room.findMany({ where: { clinicId }, orderBy: { name: "asc" } });
  return rooms.map((r) => r.id);
}

/** Las horas ofrecidas de un día puntual. */
function horasDe(
  result: Awaited<ReturnType<typeof findAvailableSlots>>,
  dateKey: string
): string[] {
  return result.days.find((d) => d.dateKey === dateKey)?.slots.map((s) => s.time) ?? [];
}

afterEach(async () => {
  for (const clinicId of clinicIds) {
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.scheduleException.deleteMany({ where: { clinicId } });
    await prisma.workingHours.deleteMany({ where: { clinicId } });
    await prisma.calendarBlock.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.service.deleteMany({ where: { clinicId } });
    await prisma.resource.deleteMany({ where: { clinicId } });
    await prisma.room.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

describe("grilla y horario de atención", () => {
  it("enumera los huecos de un día vacío respetando el horario", async () => {
    const { clinic } = await crearClinica();
    const result = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 30,
      now: ANTES,
    });

    const horas = horasDe(result, LUNES);
    expect(horas[0]).toBe("09:00");
    expect(horas).toContain("12:30");
    expect(horas).toContain("14:00");
    expect(horas[horas.length - 1]).toBe("17:30");
  });

  it("no ofrece un hueco que cruce el horario de comida", async () => {
    const { clinic } = await crearClinica();
    const result = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 30,
      now: ANTES,
    });

    const horas = horasDe(result, LUNES);
    expect(horas).not.toContain("12:45");
    expect(horas).not.toContain("13:00");
    expect(horas).not.toContain("13:30");
  });

  it("no ofrece un hueco que se pase del cierre", async () => {
    const { clinic } = await crearClinica();
    const result = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 30,
      now: ANTES,
    });

    expect(horasDe(result, LUNES)).not.toContain("17:45");
  });

  it("un servicio más largo deja menos huecos", async () => {
    const { clinic } = await crearClinica();
    const result = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 60,
      now: ANTES,
    });

    const horas = horasDe(result, LUNES);
    expect(horas).toContain("12:00");
    expect(horas).not.toContain("12:15");
    expect(horas[horas.length - 1]).toBe("17:00");
  });

  it("respeta el paso que le pasan por parámetro", async () => {
    const { clinic } = await crearClinica();
    const result = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 30,
      stepMinutes: 30,
      now: ANTES,
    });

    const horas = horasDe(result, LUNES);
    expect(horas).toContain("09:30");
    expect(horas).not.toContain("09:15");
  });

  it("arranca la grilla donde abre el tramo, no en la hora en punto", async () => {
    const { clinic } = await crearClinica({
      tramos: [{ startMinute: 9 * 60 + 10, endMinute: 13 * 60 }],
    });
    const result = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 30,
      now: ANTES,
    });

    expect(horasDe(result, LUNES)[0]).toBe("09:10");
  });

  it("usa la duración del catálogo y no el default de la clínica", async () => {
    const { clinic, patient, professionalIds } = await crearClinica();
    await prisma.service.create({
      data: {
        clinicId: clinic.id,
        name: "Limpieza",
        durationMinutes: 45,
        professionals: { connect: professionalIds.map((id) => ({ id })) },
      },
    });

    const result = await findSlotsForPatient({
      clinic,
      patient,
      requestedService: "limpieza",
      fromDateKey: LUNES,
      days: 1,
      now: ANTES,
    });

    expect(result.durationMinutes).toBe(45);
    const horas = horasDe(result, LUNES);
    expect(horas).toContain("12:15");
    expect(horas).not.toContain("12:30");
  });
});

describe("cuello de botella compartido", () => {
  it("descarta el hueco donde el profesional ya tiene un turno", async () => {
    const { clinic, patient, professionalIds } = await crearClinica();
    const [sala] = await salasDe(clinic.id);
    await ocupar({
      clinic,
      patient,
      professionalId: professionalIds[0],
      roomId: sala,
      dateKey: LUNES,
      desde: "10:00",
      hasta: "10:30",
    });

    const horas = horasDe(
      await findAvailableSlots({
        clinic,
        fromDateKey: LUNES,
        days: 1,
        durationMinutes: 30,
        now: ANTES,
      }),
      LUNES
    );

    expect(horas).not.toContain("10:00");
    expect(horas).toContain("10:30");
  });

  it("ofrece el hueco si otro profesional está libre a esa hora", async () => {
    const { clinic, patient, professionalIds } = await crearClinica({ profesionales: 2 });
    const [sala] = await salasDe(clinic.id);
    await ocupar({
      clinic,
      patient,
      professionalId: professionalIds[0],
      roomId: sala,
      dateKey: LUNES,
      desde: "10:00",
      hasta: "10:30",
    });

    const result = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 30,
      now: ANTES,
    });

    const slot = result.days[0].slots.find((s) => s.time === "10:00");
    expect(slot).toBeDefined();
    expect(slot?.professionalId).toBe(professionalIds[1]);
  });

  it("no ofrece el hueco si todas las salas están ocupadas, aunque haya un profesional libre", async () => {
    const { clinic, patient, professionalIds } = await crearClinica({
      profesionales: 3,
      salas: 2,
    });
    const salas = await salasDe(clinic.id);

    await ocupar({
      clinic,
      patient,
      professionalId: professionalIds[0],
      roomId: salas[0],
      dateKey: LUNES,
      desde: "10:00",
      hasta: "10:30",
    });
    await ocupar({
      clinic,
      patient,
      professionalId: professionalIds[1],
      roomId: salas[1],
      dateKey: LUNES,
      desde: "10:00",
      hasta: "10:30",
    });

    const horas = horasDe(
      await findAvailableSlots({
        clinic,
        fromDateKey: LUNES,
        days: 1,
        durationMinutes: 30,
        now: ANTES,
      }),
      LUNES
    );

    expect(horas).not.toContain("10:00");
    expect(horas).toContain("09:30");
    expect(horas).toContain("10:30");
  });

  it("los turnos de los demás ocupan sala aunque se busque solo la agenda de uno", async () => {
    const { clinic, patient, professionalIds } = await crearClinica({
      profesionales: 3,
      salas: 2,
    });
    const salas = await salasDe(clinic.id);

    await ocupar({
      clinic,
      patient,
      professionalId: professionalIds[1],
      roomId: salas[0],
      dateKey: LUNES,
      desde: "10:00",
      hasta: "10:30",
    });
    await ocupar({
      clinic,
      patient,
      professionalId: professionalIds[2],
      roomId: salas[1],
      dateKey: LUNES,
      desde: "10:00",
      hasta: "10:30",
    });

    // El profesional 1 está libre a las 10:00, pero no queda ninguna sala.
    const horas = horasDe(
      await findAvailableSlots({
        clinic,
        fromDateKey: LUNES,
        days: 1,
        durationMinutes: 30,
        professionalId: professionalIds[0],
        now: ANTES,
      }),
      LUNES
    );

    expect(horas).not.toContain("10:00");
  });

  it("los turnos de un profesional inactivo también ocupan sala", async () => {
    const { clinic, patient, professionalIds } = await crearClinica({
      profesionales: 2,
      salas: 1,
    });
    const [sala] = await salasDe(clinic.id);

    await ocupar({
      clinic,
      patient,
      professionalId: professionalIds[1],
      roomId: sala,
      dateKey: LUNES,
      desde: "10:00",
      hasta: "10:30",
    });
    await prisma.professional.update({
      where: { id: professionalIds[1] },
      data: { active: false },
    });

    const horas = horasDe(
      await findAvailableSlots({
        clinic,
        fromDateKey: LUNES,
        days: 1,
        durationMinutes: 30,
        now: ANTES,
      }),
      LUNES
    );

    expect(horas).not.toContain("10:00");
  });

  it("un turno que arranca antes del rango igual ocupa", async () => {
    const { clinic, patient, professionalIds } = await crearClinica({ salas: 1 });
    const [sala] = await salasDe(clinic.id);

    // Arranca el domingo por la noche y se mete en el lunes.
    const start = new Date("2030-06-17T08:45:00.000Z");
    await prisma.appointment.create({
      data: {
        clinicId: clinic.id,
        patientId: patient.id,
        professionalId: professionalIds[0],
        roomId: sala,
        service: "consulta",
        startTime: start,
        endTime: new Date("2030-06-17T09:45:00.000Z"),
      },
    });

    const horas = horasDe(
      await findAvailableSlots({
        clinic,
        fromDateKey: LUNES,
        days: 1,
        durationMinutes: 30,
        now: ANTES,
      }),
      LUNES
    );

    expect(horas).not.toContain("09:00");
    expect(horas).not.toContain("09:30");
    expect(horas).toContain("09:45");
  });

  it("ignora los turnos cancelados", async () => {
    const { clinic, patient, professionalIds } = await crearClinica({ salas: 1 });
    const [sala] = await salasDe(clinic.id);
    const start = clinicWallTimeToUtc(LUNES, "10:00", clinic.timezone);
    const end = clinicWallTimeToUtc(LUNES, "10:30", clinic.timezone);

    await prisma.appointment.create({
      data: {
        clinicId: clinic.id,
        patientId: patient.id,
        professionalId: professionalIds[0],
        roomId: sala,
        service: "consulta",
        status: "cancelado",
        startTime: start as Date,
        endTime: end as Date,
      },
    });

    expect(
      horasDe(
        await findAvailableSlots({
          clinic,
          fromDateKey: LUNES,
          days: 1,
          durationMinutes: 30,
          now: ANTES,
        }),
        LUNES
      )
    ).toContain("10:00");
  });

  it("no ofrece el hueco si no hay unidad libre del equipo requerido", async () => {
    const { clinic, patient, professionalIds } = await crearClinica({ profesionales: 2 });
    const [sala] = await salasDe(clinic.id);
    const laser = await prisma.resource.create({
      data: { clinicId: clinic.id, name: "Láser 1", type: "laser" },
    });

    await ocupar({
      clinic,
      patient,
      professionalId: professionalIds[0],
      roomId: sala,
      resourceId: laser.id,
      dateKey: LUNES,
      desde: "10:00",
      hasta: "10:30",
    });

    const horas = horasDe(
      await findAvailableSlots({
        clinic,
        fromDateKey: LUNES,
        days: 1,
        durationMinutes: 30,
        requiredResourceType: "laser",
        now: ANTES,
      }),
      LUNES
    );

    expect(horas).not.toContain("10:00");
    expect(horas).toContain("10:30");
  });

  it("ofrece el hueco si hay una segunda unidad del equipo libre", async () => {
    const { clinic, patient, professionalIds } = await crearClinica({ profesionales: 2 });
    const [sala] = await salasDe(clinic.id);
    const laser = await prisma.resource.create({
      data: { clinicId: clinic.id, name: "Láser 1", type: "laser" },
    });
    await prisma.resource.create({
      data: { clinicId: clinic.id, name: "Láser 2", type: "laser" },
    });

    await ocupar({
      clinic,
      patient,
      professionalId: professionalIds[0],
      roomId: sala,
      resourceId: laser.id,
      dateKey: LUNES,
      desde: "10:00",
      hasta: "10:30",
    });

    expect(
      horasDe(
        await findAvailableSlots({
          clinic,
          fromDateKey: LUNES,
          days: 1,
          durationMinutes: 30,
          requiredResourceType: "laser",
          now: ANTES,
        }),
        LUNES
      )
    ).toContain("10:00");
  });

  it("no ofrece nada si la clínica no tiene el equipo que pide el servicio", async () => {
    const { clinic } = await crearClinica();
    const result = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 30,
      requiredResourceType: "laser",
      now: ANTES,
    });

    expect(result.totalSlots).toBe(0);
    expect(result.days[0].reason).toBe("sin_equipo");
  });
});

describe("bloqueos de la agenda personal", () => {
  it("un bloqueo deja al profesional sin huecos en ese rato", async () => {
    const { clinic, professionalIds } = await crearClinica();
    await prisma.calendarBlock.create({
      data: {
        clinicId: clinic.id,
        professionalId: professionalIds[0],
        googleEventId: `evt-${Date.now()}`,
        startTime: clinicWallTimeToUtc(LUNES, "10:00", clinic.timezone) as Date,
        endTime: clinicWallTimeToUtc(LUNES, "11:00", clinic.timezone) as Date,
      },
    });

    const horas = horasDe(
      await findAvailableSlots({
        clinic,
        fromDateKey: LUNES,
        days: 1,
        durationMinutes: 30,
        now: ANTES,
      }),
      LUNES
    );

    expect(horas).not.toContain("10:00");
    expect(horas).not.toContain("10:30");
    expect(horas).toContain("11:00");
  });
});

describe("regla de primera vez y elección de profesional", () => {
  /**
   * Catálogo con un servicio de primera vez que solo hace el primer
   * profesional, y un "Control" que hacen todos.
   */
  async function conServicioDePrimeraVez(professionalIds: string[], clinicId: string) {
    await prisma.service.create({
      data: {
        clinicId,
        name: "Evaluación inicial",
        durationMinutes: 30,
        firstVisit: true,
        professionals: { connect: [{ id: professionalIds[0] }] },
      },
    });
    await prisma.service.create({
      data: {
        clinicId,
        name: "Control",
        durationMinutes: 30,
        professionals: { connect: professionalIds.map((id) => ({ id })) },
      },
    });
  }

  it("ofrece solo la agenda de quien hace el servicio de primera vez", async () => {
    const { clinic, patient, professionalIds } = await crearClinica({ profesionales: 2 });
    const [sala] = await salasDe(clinic.id);
    await conServicioDePrimeraVez(professionalIds, clinic.id);

    // El de la evaluación está ocupado a las 10:00; el otro está libre. El
    // turno es de OTRO paciente, para que el nuestro siga siendo de primera vez.
    await ocupar({
      clinic,
      patient: await otroPaciente(clinic.id),
      professionalId: professionalIds[0],
      roomId: sala,
      dateKey: LUNES,
      desde: "10:00",
      hasta: "10:30",
    });

    const result = await findSlotsForPatient({
      clinic,
      patient,
      requestedService: "Control",
      fromDateKey: LUNES,
      days: 1,
      now: ANTES,
    });

    expect(horasDe(result, LUNES)).not.toContain("10:00");
    expect(horasDe(result, LUNES).length).toBeGreaterThan(0);
    expect(result.days[0].slots.every((s) => s.professionalId === professionalIds[0])).toBe(
      true
    );
  });

  it("un paciente con turnos previos ve los huecos de todos los profesionales", async () => {
    const { clinic, patient, professionalIds } = await crearClinica({ profesionales: 2 });
    const [sala] = await salasDe(clinic.id);
    await conServicioDePrimeraVez(professionalIds, clinic.id);

    // Ese turno previo es lo que lo deja de hacer "de primera vez".
    await ocupar({
      clinic,
      patient,
      professionalId: professionalIds[0],
      roomId: sala,
      dateKey: LUNES,
      desde: "10:00",
      hasta: "10:30",
    });

    const result = await findSlotsForPatient({
      clinic,
      patient,
      requestedService: "Control",
      fromDateKey: LUNES,
      days: 1,
      now: ANTES,
    });

    expect(
      result.days[0].slots.some((s) => s.candidateProfessionalIds.includes(professionalIds[1]))
    ).toBe(true);
  });

  it("una urgencia no pasa por el servicio de primera vez", async () => {
    const { clinic, patient, professionalIds } = await crearClinica({ profesionales: 2 });
    await conServicioDePrimeraVez(professionalIds, clinic.id);

    const result = await findSlotsForPatient({
      clinic,
      patient,
      requestedService: "Control",
      isUrgent: true,
      fromDateKey: LUNES,
      days: 1,
      now: ANTES,
    });

    expect(
      result.days[0].slots.some((s) => s.candidateProfessionalIds.includes(professionalIds[1]))
    ).toBe(true);
  });

  it("respeta el profesional que pidió el paciente", async () => {
    const { clinic, patient, professionalIds } = await crearClinica({ profesionales: 2 });
    const result = await findSlotsForPatient({
      clinic,
      patient,
      requestedService: "consulta",
      requestedProfessionalId: professionalIds[1],
      fromDateKey: LUNES,
      days: 1,
      now: ANTES,
    });

    expect(result.restrictedToProfessionalId).toBe(professionalIds[1]);
    expect(result.days[0].slots.every((s) => s.professionalId === professionalIds[1])).toBe(
      true
    );
  });

  it("ignora a los profesionales inactivos al elegir quién atiende", async () => {
    const { clinic, professionalIds } = await crearClinica({ profesionales: 2 });
    await prisma.professional.update({
      where: { id: professionalIds[0] },
      data: { active: false },
    });

    const result = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 30,
      now: ANTES,
    });

    expect(result.days[0].slots.every((s) => s.professionalId === professionalIds[1])).toBe(
      true
    );
  });

  it("respeta el horario propio del profesional", async () => {
    const { clinic, professionalIds } = await crearClinica();
    await prisma.workingHours.createMany({
      data: DIAS_DE_SEMANA.map((weekday) => ({
        clinicId: clinic.id,
        professionalId: professionalIds[0],
        weekday,
        startMinute: 14 * 60,
        endMinute: 18 * 60,
      })),
    });

    const horas = horasDe(
      await findAvailableSlots({
        clinic,
        fromDateKey: LUNES,
        days: 1,
        durationMinutes: 30,
        now: ANTES,
      }),
      LUNES
    );

    expect(horas).not.toContain("09:00");
    expect(horas[0]).toBe("14:00");
  });

  it("el hueco tiene que entrar en la intersección de los dos horarios", async () => {
    const { clinic, professionalIds } = await crearClinica({
      tramos: [{ startMinute: 9 * 60, endMinute: 18 * 60 }],
    });
    await prisma.workingHours.createMany({
      data: DIAS_DE_SEMANA.map((weekday) => ({
        clinicId: clinic.id,
        professionalId: professionalIds[0],
        weekday,
        startMinute: 8 * 60,
        endMinute: 12 * 60,
      })),
    });

    const horas = horasDe(
      await findAvailableSlots({
        clinic,
        fromDateKey: LUNES,
        days: 1,
        durationMinutes: 30,
        now: ANTES,
      }),
      LUNES
    );

    // El profesional abre antes que la clínica y cierra antes: gana el más
    // restrictivo de cada lado.
    expect(horas[0]).toBe("09:00");
    expect(horas[horas.length - 1]).toBe("11:30");
  });
});

describe("excepciones por fecha", () => {
  it("no ofrece huecos un día cerrado por feriado y devuelve el motivo", async () => {
    const { clinic } = await crearClinica();
    await prisma.scheduleException.create({
      data: {
        clinicId: clinic.id,
        date: new Date(`${LUNES}T00:00:00.000Z`),
        reason: "Feriado nacional",
      },
    });

    const result = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 30,
      now: ANTES,
    });

    expect(result.totalSlots).toBe(0);
    expect(result.days[0].reason).toBe("clinica_cerrada");
    expect(result.days[0].exceptionReason).toBe("Feriado nacional");
  });

  it("una excepción de media jornada acota los huecos de ese día", async () => {
    const { clinic } = await crearClinica();
    await prisma.scheduleException.create({
      data: {
        clinicId: clinic.id,
        date: new Date(`${LUNES}T00:00:00.000Z`),
        reason: "Media jornada",
        startMinute: 9 * 60,
        endMinute: 12 * 60,
      },
    });

    const horas = horasDe(
      await findAvailableSlots({
        clinic,
        fromDateKey: LUNES,
        days: 1,
        durationMinutes: 30,
        now: ANTES,
      }),
      LUNES
    );

    expect(horas[horas.length - 1]).toBe("11:30");
    expect(horas).not.toContain("14:00");
  });

  it("devuelve los días que la clínica no atiende, con motivo y sin huecos", async () => {
    const { clinic } = await crearClinica();
    const result = await findAvailableSlots({
      clinic,
      fromDateKey: SABADO,
      days: 2,
      durationMinutes: 30,
      now: ANTES,
    });

    expect(result.days).toHaveLength(2);
    expect(result.days.every((d) => d.reason === "clinica_cerrada")).toBe(true);
    expect(result.totalSlots).toBe(0);
  });
});

describe("rango, presente y zona horaria", () => {
  it("no ofrece huecos anteriores a ahora", async () => {
    const { clinic } = await crearClinica();
    const result = await findAvailableSlots({
      // Sin anticipación mínima: este test es de la regla del pasado, aislada.
      // La anticipación (default 60) se prueba en tests/lead-time.test.ts.
      clinic: { ...clinic, minLeadMinutes: 0 },
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 30,
      now: new Date("2030-06-17T10:07:00.000Z"),
    });

    expect(horasDe(result, LUNES)[0]).toBe("10:15");
  });

  it("devuelve la cantidad de días pedida, en orden", async () => {
    const { clinic } = await crearClinica();
    const result = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 3,
      durationMinutes: 30,
      now: ANTES,
    });

    expect(result.days.map((d) => d.dateKey)).toEqual([LUNES, MARTES, "2030-06-19"]);
  });

  it("calcula los huecos en la hora de pared de la clínica", async () => {
    const { clinic } = await crearClinica({ timezone: "America/Argentina/Buenos_Aires" });
    const result = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 30,
      now: ANTES,
    });

    const primero = result.days[0].slots[0];
    expect(primero.time).toBe("09:00");
    expect(primero.start.toISOString()).toBe("2030-06-17T12:00:00.000Z");
  });

  it("cada hueco es coherente entre su instante y su hora local", async () => {
    const { clinic } = await crearClinica({ timezone: "America/Mexico_City" });
    const result = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 2,
      durationMinutes: 30,
      now: ANTES,
    });

    for (const day of result.days) {
      for (const slot of day.slots) {
        expect(clinicDateKey(slot.start, clinic.timezone)).toBe(day.dateKey);
        expect(formatWallTime(slot.start, clinic.timezone)).toBe(slot.time);
      }
    }
  });

  it("no ofrece la hora local que no existe por el cambio de horario", async () => {
    // 2030-03-10 es el domingo en que Nueva York adelanta: 02:00 no existe.
    const { clinic } = await crearClinica({ timezone: "America/New_York" });
    await prisma.scheduleException.create({
      data: {
        clinicId: clinic.id,
        date: new Date("2030-03-10T00:00:00.000Z"),
        reason: "Jornada especial",
        startMinute: 0,
        endMinute: 6 * 60,
      },
    });

    const horas = horasDe(
      await findAvailableSlots({
        clinic,
        fromDateKey: "2030-03-10",
        days: 1,
        durationMinutes: 30,
        now: new Date("2030-03-01T00:00:00.000Z"),
      }),
      "2030-03-10"
    );

    expect(horas).toContain("01:30");
    expect(horas).toContain("03:00");
    expect(horas).not.toContain("02:00");
    expect(horas).not.toContain("02:30");
  });
});

describe("consistencia con la validación que agenda", () => {
  it("todo hueco ofrecido pasa checkAvailability y checkWorkingHours", async () => {
    const { clinic, patient, professionalIds } = await crearClinica({
      profesionales: 2,
      salas: 2,
    });
    const salas = await salasDe(clinic.id);

    await ocupar({
      clinic,
      patient,
      professionalId: professionalIds[0],
      roomId: salas[0],
      dateKey: LUNES,
      desde: "10:00",
      hasta: "11:00",
    });
    await ocupar({
      clinic,
      patient,
      professionalId: professionalIds[1],
      roomId: salas[1],
      dateKey: LUNES,
      desde: "15:00",
      hasta: "15:30",
    });
    await prisma.calendarBlock.create({
      data: {
        clinicId: clinic.id,
        professionalId: professionalIds[1],
        googleEventId: `evt-${Date.now()}`,
        startTime: clinicWallTimeToUtc(LUNES, "09:00", clinic.timezone) as Date,
        endTime: clinicWallTimeToUtc(LUNES, "09:30", clinic.timezone) as Date,
      },
    });

    const result = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 30,
      now: ANTES,
    });

    expect(result.totalSlots).toBeGreaterThan(0);

    for (const slot of result.days[0].slots) {
      const disponibilidad = await checkAvailability({
        clinicId: clinic.id,
        professionalId: slot.professionalId,
        start: slot.start,
        end: slot.end,
      });
      expect(disponibilidad.available).toBe(true);

      const horario = await checkWorkingHours({
        clinicId: clinic.id,
        clinicTimezone: clinic.timezone,
        professionalId: slot.professionalId,
        start: slot.start,
        end: slot.end,
      });
      expect(horario.ok).toBe(true);
    }
  });

  it("un hueco ofrecido se puede agendar de verdad", async () => {
    const { clinic, patient } = await crearClinica();
    const result = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: clinic.defaultAppointmentMinutes,
      now: ANTES,
    });

    const slot = result.days[0].slots[0];
    const booking = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: slot.dateKey,
      requestedTime: slot.time,
      requestedService: "consulta",
      now: ANTES,
    });

    expect(booking.ok).toBe(true);
    if (!booking.ok) return;
    expect(booking.appointment.startTime.toISOString()).toBe(slot.start.toISOString());
    expect(booking.appointment.professionalId).toBe(slot.professionalId);
  });

  it("el hueco desaparece después de agendarlo", async () => {
    const { clinic, patient } = await crearClinica({ profesionales: 1, salas: 1 });
    const antes = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: clinic.defaultAppointmentMinutes,
      now: ANTES,
    });
    const slot = antes.days[0].slots[0];

    await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: slot.dateKey,
      requestedTime: slot.time,
      requestedService: "consulta",
      now: ANTES,
    });

    const despues = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: clinic.defaultAppointmentMinutes,
      now: ANTES,
    });

    expect(horasDe(despues, LUNES)).not.toContain(slot.time);
  });
});

describe("clínicas sin configurar", () => {
  it("una clínica sin horario cargado no inventa horarios", async () => {
    const { clinic } = await crearClinica();
    await prisma.workingHours.deleteMany({ where: { clinicId: clinic.id } });

    const result = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 30,
      now: ANTES,
    });

    expect(result.blocker).toBe("sin_horario_de_atencion");
    expect(result.totalSlots).toBe(0);
    expect(result.days).toEqual([]);
  });

  it("una clínica sin salas activas no ofrece huecos", async () => {
    const { clinic } = await crearClinica();
    await prisma.room.updateMany({ where: { clinicId: clinic.id }, data: { active: false } });

    const result = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 30,
      now: ANTES,
    });

    expect(result.blocker).toBe("sin_espacios_activos");
  });

  it("una clínica sin profesionales activos no ofrece huecos", async () => {
    const { clinic } = await crearClinica();
    await prisma.professional.updateMany({
      where: { clinicId: clinic.id },
      data: { active: false },
    });

    const result = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 30,
      now: ANTES,
    });

    expect(result.blocker).toBe("sin_profesionales_activos");
  });

  it("un día enteramente ocupado se devuelve con motivo completo", async () => {
    const { clinic, patient, professionalIds } = await crearClinica({
      profesionales: 1,
      salas: 1,
      tramos: [{ startMinute: 9 * 60, endMinute: 10 * 60 }],
    });
    const [sala] = await salasDe(clinic.id);

    await ocupar({
      clinic,
      patient,
      professionalId: professionalIds[0],
      roomId: sala,
      dateKey: LUNES,
      desde: "09:00",
      hasta: "10:00",
    });

    const result = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 30,
      now: ANTES,
    });

    expect(result.days[0].slots).toEqual([]);
    expect(result.days[0].reason).toBe("sin_profesional_disponible");
  });
});


describe("reprogramar: excludeAppointmentId", () => {
  it("la cita que se mueve no cuenta como ocupada (9:00-9:45 → se puede ofrecer 9:30)", async () => {
    const { clinic, patient, professionalIds } = await crearClinica({ salas: 1 });
    const sala = await prisma.room.findFirstOrThrow({ where: { clinicId: clinic.id } });
    await ocupar({
      clinic,
      patient,
      professionalId: professionalIds[0],
      roomId: sala.id,
      dateKey: LUNES,
      desde: "09:00",
      hasta: "09:45",
    });
    const cita = await prisma.appointment.findFirstOrThrow({ where: { clinicId: clinic.id } });

    const sin = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 30,
      now: ANTES,
    });
    expect(horasDe(sin, LUNES)).not.toContain("09:30");

    const con = await findAvailableSlots({
      clinic,
      fromDateKey: LUNES,
      days: 1,
      durationMinutes: 30,
      excludeAppointmentId: cita.id,
      now: ANTES,
    });
    expect(horasDe(con, LUNES)).toContain("09:30");
  });
});
