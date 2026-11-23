import { afterEach, describe, expect, it } from "vitest";
import type { Clinic, Patient, Weekday } from "@prisma/client";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import { createAppointmentFromRequest } from "../src/services/booking";
import { checkWorkingHours, getEffectiveIntervals } from "../src/services/working-hours";

/**
 * Horario de atención aplicado a la creación de turnos. Va contra el
 * Postgres local (docker compose up -d db).
 *
 * Lo que más importa acá es la herencia (un profesional sin horario propio
 * usa el de la clínica) y la intersección (los dos niveles tienen que
 * permitir el turno).
 */

const LUNES = "2030-06-17"; // lunes
const SABADO = "2030-06-22";
const DOMINGO = "2030-06-23";

const DIAS_DE_SEMANA: Weekday[] = ["lunes", "martes", "miercoles", "jueves", "viernes"];

const clinicIds: string[] = [];

/** Clínica de 9 a 13 y de 14 a 18, lunes a viernes. Comida de 13 a 14. */
async function crearClinica(options?: { profesionales?: number }): Promise<{
  clinic: Clinic;
  patient: Patient;
  professionalIds: string[];
}> {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica horarios ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `wh-${Date.now()}-${Math.random()}`,
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

afterEach(async () => {
  for (const clinicId of clinicIds) {
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.workingHours.deleteMany({ where: { clinicId } });
    await prisma.calendarBlock.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.room.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

describe("creación de turnos contra el horario de atención", () => {
  it("agenda dentro del horario", async () => {
    const { clinic, patient } = await crearClinica();
    const result = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: LUNES,
      requestedTime: "10:00",
      requestedService: "consulta",
    });
    expect(result.ok).toBe(true);
  });

  it("rechaza un turno en el horario de comida", async () => {
    const { clinic, patient } = await crearClinica();
    const result = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: LUNES,
      requestedTime: "13:15",
      requestedService: "consulta",
    });
    expect(result).toEqual({ ok: false, reason: "clinica_cerrada" });
  });

  it("rechaza un turno que se pasa del corte de comida", async () => {
    const { clinic, patient } = await crearClinica();
    // 12:45 + 30' = 13:15, se mete en la comida.
    const result = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: LUNES,
      requestedTime: "12:45",
      requestedService: "consulta",
    });
    expect(result).toEqual({ ok: false, reason: "clinica_cerrada" });
  });

  it("acepta el turno que termina justo cuando arranca la comida", async () => {
    const { clinic, patient } = await crearClinica();
    const result = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: LUNES,
      requestedTime: "12:30",
      requestedService: "consulta",
    });
    expect(result.ok).toBe(true);
  });

  it("rechaza un turno que se pasa del cierre", async () => {
    const { clinic, patient } = await crearClinica();
    // 17:45 + 30' = 18:15, después de cerrar.
    const result = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: LUNES,
      requestedTime: "17:45",
      requestedService: "consulta",
    });
    expect(result).toEqual({ ok: false, reason: "clinica_cerrada" });
  });

  it("rechaza un turno de madrugada", async () => {
    // El caso que motivó todo esto: sin horario estructurado, un turno a
    // las 3 de la mañana se creaba igual.
    const { clinic, patient } = await crearClinica();
    const result = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: LUNES,
      requestedTime: "03:00",
      requestedService: "consulta",
    });
    expect(result).toEqual({ ok: false, reason: "clinica_cerrada" });
  });

  it("rechaza un turno un día que la clínica no atiende", async () => {
    const { clinic, patient } = await crearClinica();
    for (const fecha of [SABADO, DOMINGO]) {
      const result = await createAppointmentFromRequest({
        clinic,
        patient,
        requestedDate: fecha,
        requestedTime: "10:00",
        requestedService: "consulta",
      });
      expect(result).toEqual({ ok: false, reason: "clinica_cerrada" });
    }
  });

  it("una clínica sin horario cargado NO agenda: el horario es obligatorio", async () => {
    // Antes se saltaba el chequeo (compatibilidad con las clínicas anteriores a
    // WorkingHours) y se aceptaban turnos a las 3 de la madrugada. Ahora se
    // rechaza con un motivo propio: no es "clínica cerrada", lo que falta es el
    // dato.
    const { clinic, patient } = await crearClinica();
    await prisma.workingHours.deleteMany({ where: { clinicId: clinic.id } });

    const result = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: DOMINGO,
      requestedTime: "03:00",
      requestedService: "consulta",
    });
    expect(result).toEqual({ ok: false, reason: "clinica_sin_horario" });
    expect(await prisma.appointment.count({ where: { clinicId: clinic.id } })).toBe(0);
  });
});

describe("horario propio del profesional", () => {
  it("un profesional sin horario propio hereda el de la clínica", async () => {
    const { clinic, professionalIds } = await crearClinica();

    const { professional, heredado } = await getEffectiveIntervals({
      clinicId: clinic.id,
      professionalId: professionalIds[0],
      weekday: "lunes",
    });

    expect(heredado).toBe(true);
    expect(professional.intervals).toEqual([
      { startMinute: 540, endMinute: 780 },
      { startMinute: 840, endMinute: 1080 },
    ]);
    expect(professional.exceptionReason).toBeNull();
  });

  it("respeta el horario reducido de un profesional", async () => {
    const { clinic, patient, professionalIds } = await crearClinica();

    // Este profesional solo atiende de 9 a 12, lunes.
    await prisma.workingHours.create({
      data: {
        clinicId: clinic.id,
        professionalId: professionalIds[0],
        weekday: "lunes",
        startMinute: 9 * 60,
        endMinute: 12 * 60,
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

    const otro = await prisma.patient.create({
      data: { clinicId: clinic.id, phone: "5491166666666", name: "Otro" },
    });
    // 15:00 está dentro del horario de la clínica pero fuera del suyo.
    const fuera = await createAppointmentFromRequest({
      clinic,
      patient: otro,
      requestedDate: LUNES,
      requestedTime: "15:00",
      requestedService: "consulta",
    });
    expect(fuera).toEqual({ ok: false, reason: "sin_profesional_disponible" });
  });

  it("el horario propio no habilita nada fuera del horario de la clínica", async () => {
    // La intersección es lo que manda: aunque el profesional diga que
    // atiende hasta las 22, con la clínica cerrada no se agenda.
    const { clinic, patient, professionalIds } = await crearClinica();

    await prisma.workingHours.create({
      data: {
        clinicId: clinic.id,
        professionalId: professionalIds[0],
        weekday: "lunes",
        startMinute: 9 * 60,
        endMinute: 22 * 60,
      },
    });

    const result = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: LUNES,
      requestedTime: "20:00",
      requestedService: "consulta",
    });
    // El motivo es "cerrada" y no "sin profesional": el horario de la
    // clínica se chequea primero justamente para que el motivo sea el útil.
    expect(result).toEqual({ ok: false, reason: "clinica_cerrada" });
  });

  it("el horario propio tampoco habilita el corte de comida de la clínica", async () => {
    const { clinic, patient, professionalIds } = await crearClinica();

    // Este profesional no corta al mediodía, pero la clínica sí.
    await prisma.workingHours.create({
      data: {
        clinicId: clinic.id,
        professionalId: professionalIds[0],
        weekday: "lunes",
        startMinute: 9 * 60,
        endMinute: 18 * 60,
      },
    });

    const result = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: LUNES,
      requestedTime: "13:15",
      requestedService: "consulta",
    });
    expect(result).toEqual({ ok: false, reason: "clinica_cerrada" });
  });

  it("un profesional con horario propio NO hereda los días que no definió", async () => {
    // La herencia es todo o nada. Si fuera por día, este profesional
    // heredaría el martes de la clínica y lo agendarían un día que no
    // trabaja.
    const { clinic, professionalIds } = await crearClinica();

    await prisma.workingHours.create({
      data: {
        clinicId: clinic.id,
        professionalId: professionalIds[0],
        weekday: "lunes",
        startMinute: 9 * 60,
        endMinute: 13 * 60,
      },
    });

    const martes = await getEffectiveIntervals({
      clinicId: clinic.id,
      professionalId: professionalIds[0],
      weekday: "martes",
    });

    expect(martes.heredado).toBe(false);
    expect(martes.professional.intervals).toEqual([]);
    // La clínica sí atiende los martes; el profesional no.
    expect(martes.clinic.intervals).toHaveLength(2);
  });

  it("cae al segundo profesional si el primero no atiende a esa hora", async () => {
    const { clinic, patient, professionalIds } = await crearClinica({ profesionales: 2 });

    // El primero solo a la mañana.
    await prisma.workingHours.create({
      data: {
        clinicId: clinic.id,
        professionalId: professionalIds[0],
        weekday: "lunes",
        startMinute: 9 * 60,
        endMinute: 13 * 60,
      },
    });

    const result = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: LUNES,
      requestedTime: "15:00",
      requestedService: "consulta",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // El segundo hereda el horario completo de la clínica.
    expect(result.appointment.professionalId).toBe(professionalIds[1]);
  });

  it("un profesional puede tener su comida en otro horario", async () => {
    const { clinic, professionalIds } = await crearClinica();

    // Come de 12 a 13 en vez de 13 a 14, expresado como dos tramos.
    await prisma.workingHours.createMany({
      data: [
        {
          clinicId: clinic.id,
          professionalId: professionalIds[0],
          weekday: "lunes",
          startMinute: 9 * 60,
          endMinute: 12 * 60,
        },
        {
          clinicId: clinic.id,
          professionalId: professionalIds[0],
          weekday: "lunes",
          startMinute: 13 * 60,
          endMinute: 18 * 60,
        },
      ],
    });

    // 12:15: él está comiendo.
    const suComida = await checkWorkingHours({
      clinicId: clinic.id,
      clinicTimezone: "UTC",
      professionalId: professionalIds[0],
      start: new Date("2030-06-17T12:15:00.000Z"),
      end: new Date("2030-06-17T12:45:00.000Z"),
    });
    expect(suComida).toEqual({ ok: false, reason: "profesional_fuera_de_horario" });

    // 13:15: él ya volvió, pero la clínica está en su corte.
    const comidaDeLaClinica = await checkWorkingHours({
      clinicId: clinic.id,
      clinicTimezone: "UTC",
      professionalId: professionalIds[0],
      start: new Date("2030-06-17T13:15:00.000Z"),
      end: new Date("2030-06-17T13:45:00.000Z"),
    });
    expect(comidaDeLaClinica).toEqual({ ok: false, reason: "clinica_cerrada" });

    // 11:00: los dos abiertos.
    const ambos = await checkWorkingHours({
      clinicId: clinic.id,
      clinicTimezone: "UTC",
      professionalId: professionalIds[0],
      start: new Date("2030-06-17T11:00:00.000Z"),
      end: new Date("2030-06-17T11:30:00.000Z"),
    });
    expect(ambos).toEqual({ ok: true });
  });
});

describe("el día de la semana se calcula en la zona de la clínica", () => {
  it("usa el día local de la clínica, no el del instante UTC", async () => {
    // Nueva York en junio es EDT (UTC-4). Una clínica que solo atiende los
    // lunes, hasta las 22.
    const clinic = await prisma.clinic.create({
      data: {
        name: `Clínica TZ ${Date.now()}`,
        whatsappPhoneNumberId: `tz-${Date.now()}-${Math.random()}`,
        whatsappTokenEncrypted: encryptToken("test"),
        email: "test@example.com",
        timezone: "America/New_York",
        services: "Consulta",
        professionals: { create: [{ name: "Profesional 1" }] },
        rooms: { create: [{ name: "Sala 1" }] },
        workingHours: { create: [{ weekday: "lunes", startMinute: 9 * 60, endMinute: 22 * 60 }] },
      },
      include: { professionals: true },
    });
    clinicIds.push(clinic.id);

    const patient = await prisma.patient.create({
      data: { clinicId: clinic.id, phone: "5491155555555", name: "Paciente" },
    });

    // Lunes 21:00 en Nueva York es MARTES 01:00 UTC. Si el día de la semana
    // se calculara sobre el instante UTC, buscaría el horario del martes —
    // que no existe — y rechazaría un turno perfectamente válido.
    const result = await createAppointmentFromRequest({
      clinic,
      patient,
      requestedDate: "2030-06-17", // lunes
      requestedTime: "21:00",
      requestedService: "consulta",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appointment.startTime.toISOString()).toBe("2030-06-18T01:00:00.000Z");
  });
});
