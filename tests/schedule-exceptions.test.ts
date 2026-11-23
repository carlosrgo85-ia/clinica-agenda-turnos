import { afterEach, describe, expect, it } from "vitest";
import type { Clinic, Patient, Weekday } from "@prisma/client";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import { createAppointmentFromRequest } from "../src/services/booking";
import { alertClinicsMissingWorkingHours } from "../src/jobs/config-alerts";
import {
  deleteScheduleException,
  listScheduleExceptions,
  upsertScheduleException,
  WorkingHoursValidationError,
} from "../src/services/working-hours";

/**
 * Excepciones de horario por fecha (feriados, jornadas especiales) y el
 * aviso a las clínicas que no cargaron horario.
 *
 * Va contra el Postgres local: docker compose up -d db
 */

const LUNES = "2030-06-17";
const OTRO_LUNES = "2030-06-24";
const DIAS_DE_SEMANA: Weekday[] = ["lunes", "martes", "miercoles", "jueves", "viernes"];

const clinicIds: string[] = [];

async function crearClinica(options?: { profesionales?: number }): Promise<{
  clinic: Clinic;
  patient: Patient;
  professionalIds: string[];
}> {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica exc ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `exc-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: "UTC",
      services: "Consulta",
      professionals: {
        create: Array.from({ length: options?.profesionales ?? 1 }, (_, i) => ({
          name: `Profesional ${i + 1}`,
        })),
      },
      rooms: { create: [{ name: "Sala 1" }, { name: "Sala 2" }] },
      workingHours: {
        create: DIAS_DE_SEMANA.flatMap((weekday) => [
          { weekday, startMinute: 9 * 60, endMinute: 13 * 60 },
          { weekday, startMinute: 14 * 60, endMinute: 18 * 60 },
        ]),
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

async function nuevoPaciente(clinicId: string): Promise<Patient> {
  return prisma.patient.create({
    data: {
      clinicId,
      phone: `5492${Math.floor(Math.random() * 1e9)}`,
      name: "Otro",
    },
  });
}

afterEach(async () => {
  for (const clinicId of clinicIds) {
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.scheduleException.deleteMany({ where: { clinicId } });
    await prisma.workingHours.deleteMany({ where: { clinicId } });
    await prisma.calendarBlock.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.room.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

describe("feriados y días cerrados", () => {
  it("no agenda en un día marcado como feriado", async () => {
    const { clinic, patient } = await crearClinica();

    // Sin tramos = cerrado todo el día.
    await upsertScheduleException({
      clinicId: clinic.id,
      input: { dateKey: LUNES, reason: "Feriado nacional" },
    });

    const result = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: LUNES,
      requestedTime: "10:00",
      requestedService: "consulta",
    });

    expect(result).toEqual({ ok: false, reason: "clinica_cerrada" });
  });

  it("el feriado afecta solo a esa fecha, no al resto de los lunes", async () => {
    const { clinic, patient } = await crearClinica();

    await upsertScheduleException({
      clinicId: clinic.id,
      input: { dateKey: LUNES, reason: "Jornada de capacitación" },
    });

    const otroLunes = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: OTRO_LUNES,
      requestedTime: "10:00",
      requestedService: "consulta",
    });

    expect(otroLunes.ok).toBe(true);
  });

  it("borrar la excepción devuelve el día al horario semanal", async () => {
    const { clinic, patient } = await crearClinica();

    await upsertScheduleException({
      clinicId: clinic.id,
      input: { dateKey: LUNES, reason: "Feriado" },
    });
    await deleteScheduleException({ clinicId: clinic.id, dateKey: LUNES });

    const result = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: LUNES,
      requestedTime: "10:00",
      requestedService: "consulta",
    });

    expect(result.ok).toBe(true);
  });
});

describe("día con horario especial", () => {
  it("reemplaza el horario semanal, no lo suma", async () => {
    const { clinic, patient } = await crearClinica();

    // Media jornada: solo de 9 a 12. La tarde del horario semanal
    // (14 a 18) deja de valer ese día.
    await upsertScheduleException({
      clinicId: clinic.id,
      input: {
        dateKey: LUNES,
        reason: "Media jornada por inventario",
        tramos: [{ startMinute: 9 * 60, endMinute: 12 * 60 }],
      },
    });

    const dentro = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: LUNES,
      requestedTime: "10:00",
      requestedService: "consulta",
    });
    expect(dentro.ok).toBe(true);

    // 15:00 estaría dentro del horario semanal pero fuera del especial.
    const fuera = await createAppointmentFromRequest({
      clinic,
      patient: await nuevoPaciente(clinic.id),
      requestedDate: LUNES,
      requestedTime: "15:00",
      requestedService: "consulta",
    });
    expect(fuera).toEqual({ ok: false, reason: "clinica_cerrada" });
  });

  it("puede abrir en un horario en el que normalmente está cerrada", async () => {
    const { clinic, patient } = await crearClinica();

    // Un sábado, que normalmente no se atiende.
    await upsertScheduleException({
      clinicId: clinic.id,
      input: {
        dateKey: "2030-06-22", // sábado
        reason: "Jornada especial de atención",
        tramos: [{ startMinute: 10 * 60, endMinute: 14 * 60 }],
      },
    });

    const result = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: "2030-06-22",
      requestedTime: "11:00",
      requestedService: "consulta",
    });

    expect(result.ok).toBe(true);
  });

  it("una excepción con tramos también respeta el hueco entre ellos", async () => {
    const { clinic, patient } = await crearClinica();

    await upsertScheduleException({
      clinicId: clinic.id,
      input: {
        dateKey: LUNES,
        reason: "Día especial con corte largo",
        tramos: [
          { startMinute: 9 * 60, endMinute: 11 * 60 },
          { startMinute: 16 * 60, endMinute: 18 * 60 },
        ],
      },
    });

    const enElHueco = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: LUNES,
      requestedTime: "13:00",
      requestedService: "consulta",
    });
    expect(enElHueco).toEqual({ ok: false, reason: "clinica_cerrada" });

    const enElSegundoTramo = await createAppointmentFromRequest({
      clinic,
      patient: await nuevoPaciente(clinic.id),
      requestedDate: LUNES,
      requestedTime: "16:30",
      requestedService: "consulta",
    });
    expect(enElSegundoTramo.ok).toBe(true);
  });

  it("cargar la misma fecha de nuevo sobrescribe la excepción anterior", async () => {
    const { clinic, patient } = await crearClinica();

    await upsertScheduleException({
      clinicId: clinic.id,
      input: { dateKey: LUNES, reason: "Feriado" },
    });
    // Se corrige: en realidad se atiende media jornada.
    await upsertScheduleException({
      clinicId: clinic.id,
      input: {
        dateKey: LUNES,
        reason: "Media jornada",
        tramos: [{ startMinute: 9 * 60, endMinute: 12 * 60 }],
      },
    });

    const excepciones = await listScheduleExceptions({ clinicId: clinic.id });
    expect(excepciones).toHaveLength(1);
    expect(excepciones[0].cerradoTodoElDia).toBe(false);
    expect(excepciones[0].reason).toBe("Media jornada");

    const result = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: LUNES,
      requestedTime: "10:00",
      requestedService: "consulta",
    });
    expect(result.ok).toBe(true);
  });
});

describe("excepción de un solo profesional", () => {
  it("no afecta al resto del equipo", async () => {
    const { clinic, patient, professionalIds } = await crearClinica({ profesionales: 2 });

    // El primero se toma el día.
    await upsertScheduleException({
      clinicId: clinic.id,
      input: {
        dateKey: LUNES,
        reason: "Día personal",
        professionalId: professionalIds[0],
      },
    });

    const result = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: LUNES,
      requestedTime: "10:00",
      requestedService: "consulta",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Le tocó al segundo, porque el primero no atiende ese día.
    expect(result.appointment.professionalId).toBe(professionalIds[1]);
  });

  it("si es el único profesional, no hay turno", async () => {
    const { clinic, patient, professionalIds } = await crearClinica({ profesionales: 1 });

    await upsertScheduleException({
      clinicId: clinic.id,
      input: {
        dateKey: LUNES,
        reason: "Día personal",
        professionalId: professionalIds[0],
      },
    });

    const result = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: LUNES,
      requestedTime: "10:00",
      requestedService: "consulta",
    });

    expect(result).toEqual({ ok: false, reason: "sin_profesional_disponible" });
  });

  it("un profesional que hereda el horario puede tener su propia excepción", async () => {
    // La herencia del horario semanal y las excepciones son independientes.
    const { clinic, patient, professionalIds } = await crearClinica({ profesionales: 1 });

    // No tiene WorkingHours propio: hereda el de la clínica.
    const tramosPropios = await prisma.workingHours.count({
      where: { clinicId: clinic.id, professionalId: professionalIds[0] },
    });
    expect(tramosPropios).toBe(0);

    await upsertScheduleException({
      clinicId: clinic.id,
      input: {
        dateKey: LUNES,
        reason: "Congreso",
        professionalId: professionalIds[0],
      },
    });

    const eseLunes = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: LUNES,
      requestedTime: "10:00",
      requestedService: "consulta",
    });
    expect(eseLunes).toEqual({ ok: false, reason: "sin_profesional_disponible" });

    // El lunes siguiente sigue heredando el horario de la clínica.
    const otroLunes = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: OTRO_LUNES,
      requestedTime: "10:00",
      requestedService: "consulta",
    });
    expect(otroLunes.ok).toBe(true);
  });
});

describe("validación de excepciones", () => {
  it("exige un motivo", async () => {
    const { clinic } = await crearClinica();
    await expect(
      upsertScheduleException({
        clinicId: clinic.id,
        input: { dateKey: LUNES, reason: "  " },
      })
    ).rejects.toThrow(WorkingHoursValidationError);
  });

  it("rechaza una fecha con formato inválido", async () => {
    const { clinic } = await crearClinica();
    await expect(
      upsertScheduleException({
        clinicId: clinic.id,
        input: { dateKey: "17/06/2030", reason: "Feriado" },
      })
    ).rejects.toThrow(WorkingHoursValidationError);
  });

  it("rechaza tramos solapados dentro de la excepción", async () => {
    const { clinic } = await crearClinica();
    await expect(
      upsertScheduleException({
        clinicId: clinic.id,
        input: {
          dateKey: LUNES,
          reason: "Día raro",
          tramos: [
            { startMinute: 540, endMinute: 800 },
            { startMinute: 780, endMinute: 1080 },
          ],
        },
      })
    ).rejects.toThrow(WorkingHoursValidationError);
  });
});

describe("aviso a las clínicas sin horario cargado", () => {
  it("no avisa a una clínica que ya tiene horario", async () => {
    const { clinic } = await crearClinica();
    // Se limita a esta clínica para no depender de qué otras haya cargadas.
    const avisadas = await alertClinicsMissingWorkingHours(new Date(), {
      clinicIds: [clinic.id],
    });
    expect(avisadas).toBe(0);

    const despues = await prisma.clinic.findUniqueOrThrow({ where: { id: clinic.id } });
    expect(despues.workingHoursAlertSentAt).toBeNull();
  });

  it("los tramos de un profesional no cuentan como horario de la clínica", async () => {
    // Sin el horario de la clínica no hay con qué validar, aunque un
    // profesional tenga el suyo.
    const { clinic, professionalIds } = await crearClinica();
    await prisma.workingHours.deleteMany({
      where: { clinicId: clinic.id, professionalId: null },
    });
    await prisma.workingHours.create({
      data: {
        clinicId: clinic.id,
        professionalId: professionalIds[0],
        weekday: "lunes",
        startMinute: 540,
        endMinute: 1080,
      },
    });

    const pendiente = await prisma.clinic.findFirst({
      where: { id: clinic.id, workingHours: { none: { professionalId: null } } },
    });
    expect(pendiente).not.toBeNull();
  });

  it("no repite el aviso antes de las 24 horas", async () => {
    const { clinic } = await crearClinica();
    await prisma.workingHours.deleteMany({ where: { clinicId: clinic.id } });

    const ahora = new Date();
    await prisma.clinic.update({
      where: { id: clinic.id },
      // Se avisó hace una hora.
      data: { workingHoursAlertSentAt: new Date(ahora.getTime() - 60 * 60 * 1000) },
    });

    const antes = await prisma.clinic.findUniqueOrThrow({ where: { id: clinic.id } });
    await alertClinicsMissingWorkingHours(ahora, { clinicIds: [clinic.id] });
    const despues = await prisma.clinic.findUniqueOrThrow({ where: { id: clinic.id } });

    // No se tocó la marca, así que no se mandó nada.
    expect(despues.workingHoursAlertSentAt?.toISOString()).toBe(
      antes.workingHoursAlertSentAt?.toISOString()
    );
  });
});
