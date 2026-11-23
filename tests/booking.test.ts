import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clinic, Patient } from "@prisma/client";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import { createAppointmentFromRequest } from "../src/services/booking";

/**
 * Tests de integración contra el Postgres local (docker-compose.yml).
 *
 *   docker compose up -d db
 *   npm test
 *
 * Van contra la base de verdad a propósito: lo que más importa verificar acá
 * es que dos pedidos simultáneos no puedan quedarse con el mismo hueco, y
 * eso depende del aislamiento serializable de Postgres. Con la base mockeada
 * el test pasaría sin probar nada.
 *
 * Cada test crea su propia clínica y la borra al final, así que no toca los
 * datos que haya cargados.
 */

/** Un futuro fijo, para que los tests no dependan de la fecha en que corren. */
const FECHA = "2030-06-17"; // lunes
const HORA = "10:00";

interface Fixture {
  clinic: Clinic;
  patient: Patient;
  professionalIds: string[];
  roomIds: string[];
}

let fixture: Fixture;
const clinicIds: string[] = [];

async function crearClinica(options?: {
  profesionales?: number;
  espacios?: number;
  defaultAppointmentMinutes?: number;
}): Promise<Fixture> {
  const profesionales = options?.profesionales ?? 2;
  const espacios = options?.espacios ?? 2;

  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica de test ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `test-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      // UTC para que las aserciones de hora sean directas; la conversión de
      // zonas ya está cubierta en tests/time.test.ts.
      timezone: "UTC",
      services: "Consulta, limpieza",
      ...(options?.defaultAppointmentMinutes
        ? { defaultAppointmentMinutes: options.defaultAppointmentMinutes }
        : {}),
      professionals: {
        create: Array.from({ length: profesionales }, (_, i) => ({
          name: `Profesional ${i + 1}`,
        })),
      },
      rooms: {
        create: Array.from({ length: espacios }, (_, i) => ({ name: `Sala ${i + 1}` })),
      },
      // Abierta las 24 horas todos los días: estos tests son de espacios,
      // equipos y solapamientos, no de horario (eso está en
      // booking-working-hours.test.ts). Sin ningún tramo la clínica no agenda.
      workingHours: {
        create: (
          ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"] as const
        ).map((weekday) => ({ weekday, startMinute: 0, endMinute: 24 * 60 })),
      },
    },
    include: { professionals: { orderBy: { id: "asc" } }, rooms: true },
  });

  clinicIds.push(clinic.id);

  const patient = await prisma.patient.create({
    data: { clinicId: clinic.id, phone: `549110000${Math.floor(Math.random() * 100000)}`, name: "Paciente Test" },
  });

  return {
    clinic,
    patient,
    professionalIds: clinic.professionals.map((p) => p.id),
    roomIds: clinic.rooms.map((r) => r.id),
  };
}

beforeEach(async () => {
  fixture = await crearClinica();
});

afterEach(async () => {
  // Se borra en orden inverso a las dependencias.
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

function pedido(overrides?: Partial<Parameters<typeof createAppointmentFromRequest>[0]>) {
  return createAppointmentFromRequest({
    clinic: fixture.clinic,
    patient: fixture.patient,
    requestedDate: FECHA,
    requestedTime: HORA,
    requestedService: "consulta",
    ...overrides,
  });
}

describe("createAppointmentFromRequest", () => {
  it("crea el turno con la duración por default de la clínica", async () => {
    const result = await pedido();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.appointment.startTime.toISOString()).toBe("2030-06-17T10:00:00.000Z");
    // 30 minutos es el default del schema.
    expect(result.appointment.endTime.toISOString()).toBe("2030-06-17T10:30:00.000Z");
    expect(result.appointment.status).toBe("confirmado");
    expect(result.appointment.roomId).toBeTruthy();
    expect(result.appointment.resourceId).toBeNull();
    // Sin calendario enlazado no hay espejo, y el turno vale igual.
    expect(result.googleEventId).toBeNull();
    expect(result.mirrorError).toBeNull();
  });

  it("usa la duración del catálogo cuando el servicio matchea", async () => {
    await prisma.service.create({
      data: {
        clinicId: fixture.clinic.id,
        // Asignado a todos: lo que importa de estos tests no es quién lo hace.
        professionals: { connect: fixture.professionalIds.map((id) => ({ id })) },
        name: "Limpieza profunda",
        durationMinutes: 90,
      },
    });

    // El paciente dice "limpieza", no el nombre exacto del catálogo.
    const result = await pedido({ requestedService: "limpieza" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appointment.endTime.toISOString()).toBe("2030-06-17T11:30:00.000Z");
    expect(result.appointment.service).toBe("Limpieza profunda");
    expect(result.appointment.serviceId).toBeTruthy();
  });

  it("respeta la duración configurada de la clínica", async () => {
    const otra = await crearClinica({ defaultAppointmentMinutes: 15 });
    const result = await createAppointmentFromRequest({
      clinic: otra.clinic,
      patient: otra.patient,
      requestedDate: FECHA,
      requestedTime: HORA,
      requestedService: "consulta",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appointment.endTime.toISOString()).toBe("2030-06-17T10:15:00.000Z");
  });

  it("rechaza una fecha en el pasado", async () => {
    const result = await pedido({ requestedDate: "2020-01-15" });
    expect(result).toEqual({ ok: false, reason: "fecha_en_el_pasado" });
  });

  it("rechaza fecha u hora que no se pudieron interpretar", async () => {
    expect(await pedido({ requestedDate: null })).toEqual({
      ok: false,
      reason: "fecha_u_hora_invalida",
    });
    expect(await pedido({ requestedTime: null })).toEqual({
      ok: false,
      reason: "fecha_u_hora_invalida",
    });
    expect(await pedido({ requestedDate: "el martes" })).toEqual({
      ok: false,
      reason: "fecha_u_hora_invalida",
    });
  });

  it("no agenda dos turnos en el mismo espacio si no quedan libres", async () => {
    // 2 profesionales, 1 solo espacio: el segundo turno no entra aunque
    // haya un profesional libre. Es el cuello de botella que Google
    // Calendar no puede modelar.
    const una = await crearClinica({ profesionales: 2, espacios: 1 });

    const primero = await createAppointmentFromRequest({
      clinic: una.clinic,
      patient: una.patient,
      requestedDate: FECHA,
      requestedTime: HORA,
      requestedService: "consulta",
    });
    expect(primero.ok).toBe(true);

    const otroPaciente = await prisma.patient.create({
      data: { clinicId: una.clinic.id, phone: "5491199999999", name: "Otro" },
    });
    const segundo = await createAppointmentFromRequest({
      clinic: una.clinic,
      patient: otroPaciente,
      requestedDate: FECHA,
      requestedTime: HORA,
      requestedService: "consulta",
    });

    expect(segundo).toEqual({ ok: false, reason: "sin_espacios" });
  });

  it("no agenda si el único profesional ya tiene un turno solapado", async () => {
    const una = await crearClinica({ profesionales: 1, espacios: 5 });

    const primero = await createAppointmentFromRequest({
      clinic: una.clinic,
      patient: una.patient,
      requestedDate: FECHA,
      requestedTime: HORA,
      requestedService: "consulta",
    });
    expect(primero.ok).toBe(true);

    const otroPaciente = await prisma.patient.create({
      data: { clinicId: una.clinic.id, phone: "5491188888888", name: "Otro" },
    });
    // 10:15 se solapa con el turno de 10:00-10:30.
    const segundo = await createAppointmentFromRequest({
      clinic: una.clinic,
      patient: otroPaciente,
      requestedDate: FECHA,
      requestedTime: "10:15",
      requestedService: "consulta",
    });

    expect(segundo).toEqual({ ok: false, reason: "sin_profesional_disponible" });
  });

  it("no agenda encima de un bloqueo de la agenda personal", async () => {
    const una = await crearClinica({ profesionales: 1, espacios: 5 });

    await prisma.calendarBlock.create({
      data: {
        clinicId: una.clinic.id,
        professionalId: una.professionalIds[0],
        googleEventId: "algo-personal",
        startTime: new Date("2030-06-17T09:45:00.000Z"),
        endTime: new Date("2030-06-17T10:15:00.000Z"),
      },
    });

    const result = await createAppointmentFromRequest({
      clinic: una.clinic,
      patient: una.patient,
      requestedDate: FECHA,
      requestedTime: HORA,
      requestedService: "consulta",
    });

    expect(result).toEqual({ ok: false, reason: "sin_profesional_disponible" });
  });

  it("elige otro profesional si el primero está bloqueado", async () => {
    await prisma.calendarBlock.create({
      data: {
        clinicId: fixture.clinic.id,
        professionalId: fixture.professionalIds[0],
        googleEventId: "algo-personal",
        startTime: new Date("2030-06-17T09:00:00.000Z"),
        endTime: new Date("2030-06-17T11:00:00.000Z"),
      },
    });

    const result = await pedido();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appointment.professionalId).toBe(fixture.professionalIds[1]);
  });

  it("reserva la unidad de equipo que requiere el servicio", async () => {
    await prisma.resource.create({
      data: { clinicId: fixture.clinic.id, name: "Láser #1", type: "laser" },
    });
    await prisma.service.create({
      data: {
        clinicId: fixture.clinic.id,
        // Asignado a todos: lo que importa de estos tests no es quién lo hace.
        professionals: { connect: fixture.professionalIds.map((id) => ({ id })) },
        name: "Depilación láser",
        durationMinutes: 30,
        requiredResourceType: "laser",
      },
    });

    const result = await pedido({ requestedService: "depilación láser" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appointment.resourceId).toBeTruthy();
  });

  /**
   * Los dos casos se ven igual desde afuera —no hay equipo disponible— pero
   * significan cosas distintas y llevan a respuestas distintas: uno se
   * resuelve ofreciendo otro horario y el otro no se resuelve hasta que
   * alguien arregle el equipo. Ver `equipo_fuera_de_servicio`.
   */
  it("no agenda si la clínica no tiene ninguna unidad activa de ese equipo", async () => {
    await prisma.service.create({
      data: {
        clinicId: fixture.clinic.id,
        // Asignado a todos: lo que importa de estos tests no es quién lo hace.
        professionals: { connect: fixture.professionalIds.map((id) => ({ id })) },
        name: "Depilación láser",
        durationMinutes: 30,
        requiredResourceType: "laser",
      },
    });
    // No se crea ningún Resource de tipo "laser".

    const result = await pedido({ requestedService: "depilación láser" });
    expect(result).toEqual({ ok: false, reason: "equipo_fuera_de_servicio" });
  });

  it("distingue el equipo dado de baja del equipo ocupado", async () => {
    await prisma.service.create({
      data: {
        clinicId: fixture.clinic.id,
        // Asignado a todos: lo que importa de estos tests no es quién lo hace.
        professionals: { connect: fixture.professionalIds.map((id) => ({ id })) },
        name: "Depilación láser",
        durationMinutes: 30,
        requiredResourceType: "laser",
      },
    });
    const laser = await prisma.resource.create({
      data: { clinicId: fixture.clinic.id, name: "Láser #1", type: "laser" },
    });

    // Con el equipo en servicio y libre, el turno entra.
    const primero = await pedido({ requestedService: "depilación láser" });
    expect(primero.ok).toBe(true);

    // Un segundo pedido a la misma hora: el equipo existe pero está tomado.
    const otroPaciente = await prisma.patient.create({
      data: { clinicId: fixture.clinic.id, phone: "5491199999999", name: "Otra" },
    });
    const ocupado = await createAppointmentFromRequest({
      clinic: fixture.clinic,
      patient: otroPaciente,
      requestedDate: FECHA,
      requestedTime: HORA,
      requestedService: "depilación láser",
    });
    expect(ocupado).toEqual({ ok: false, reason: "sin_equipo" });

    // Y con el equipo dado de baja, el motivo es otro.
    await prisma.appointment.deleteMany({ where: { clinicId: fixture.clinic.id } });
    await prisma.resource.update({
      where: { id: laser.id },
      data: { active: false, inactiveReason: "Láser dañado" },
    });
    const roto = await pedido({ requestedService: "depilación láser" });
    expect(roto).toEqual({ ok: false, reason: "equipo_fuera_de_servicio" });
  });

  it("dos pedidos simultáneos por el último hueco: gana uno solo", async () => {
    // 1 profesional, 1 espacio. Si el chequeo y la inserción no fueran
    // atómicos, los dos pedidos pasarían el chequeo y quedarían dos turnos
    // encima del mismo espacio.
    const una = await crearClinica({ profesionales: 1, espacios: 1 });
    const otroPaciente = await prisma.patient.create({
      data: { clinicId: una.clinic.id, phone: "5491177777777", name: "Otro" },
    });

    const [a, b] = await Promise.all([
      createAppointmentFromRequest({
        clinic: una.clinic,
        patient: una.patient,
        requestedDate: FECHA,
        requestedTime: HORA,
        requestedService: "consulta",
      }),
      createAppointmentFromRequest({
        clinic: una.clinic,
        patient: otroPaciente,
        requestedDate: FECHA,
        requestedTime: HORA,
        requestedService: "consulta",
      }),
    ]);

    const exitosos = [a, b].filter((r) => r.ok);
    expect(exitosos).toHaveLength(1);

    // Y en la base quedó exactamente uno.
    const enBase = await prisma.appointment.count({
      where: { clinicId: una.clinic.id, status: "confirmado" },
    });
    expect(enBase).toBe(1);
  });
});


describe("reprogramar (replaceAppointmentId)", () => {
  it("mueve la cita a un horario que se pisa con la propia, y deja la vieja cancelada", async () => {
    // 10:00-10:30 con el primer profesional.
    const original = await pedido({ requestedProfessionalId: fixture.professionalIds[0] });
    expect(original.ok).toBe(true);
    if (!original.ok) return;

    // 10:15 se pisa con la cita que se está moviendo: sin la baja dentro de la
    // transacción, el profesional figuraría ocupado por la misma persona.
    const movida = await pedido({
      requestedTime: "10:15",
      requestedProfessionalId: fixture.professionalIds[0],
      replaceAppointmentId: original.appointment.id,
    });
    expect(movida.ok).toBe(true);
    if (!movida.ok) return;

    expect(movida.replacedAppointmentId).toBe(original.appointment.id);
    expect(movida.appointment.startTime.toISOString()).toBe("2030-06-17T10:15:00.000Z");

    const vieja = await prisma.appointment.findUniqueOrThrow({ where: { id: original.appointment.id } });
    expect(vieja.status).toBe("cancelado");
    const vigentes = await prisma.appointment.count({
      where: { clinicId: fixture.clinic.id, status: "confirmado" },
    });
    expect(vigentes).toBe(1);
  });

  it("si el horario nuevo no se puede, la cita vieja SIGUE vigente (la transacción se revierte)", async () => {
    const original = await pedido({ requestedProfessionalId: fixture.professionalIds[0] });
    expect(original.ok).toBe(true);
    if (!original.ok) return;

    // Otro paciente ocupa al mismo profesional a las 11:00.
    const otro = await prisma.patient.create({
      data: { clinicId: fixture.clinic.id, phone: `5491${Math.floor(Math.random() * 1e9)}`, name: "Otro" },
    });
    const ocupado = await pedido({
      patient: otro,
      requestedTime: "11:00",
      requestedProfessionalId: fixture.professionalIds[0],
    });
    expect(ocupado.ok).toBe(true);

    const intento = await pedido({
      requestedTime: "11:00",
      requestedProfessionalId: fixture.professionalIds[0],
      replaceAppointmentId: original.appointment.id,
    });
    expect(intento).toEqual({ ok: false, reason: "profesional_ocupado" });

    const vieja = await prisma.appointment.findUniqueOrThrow({ where: { id: original.appointment.id } });
    expect(vieja.status).toBe("confirmado");
  });

  it("no reprograma la cita de otra persona ni crea una nueva a cambio", async () => {
    const otro = await prisma.patient.create({
      data: { clinicId: fixture.clinic.id, phone: `5491${Math.floor(Math.random() * 1e9)}`, name: "Otro" },
    });
    const ajena = await pedido({ patient: otro });
    expect(ajena.ok).toBe(true);
    if (!ajena.ok) return;

    const antes = await prisma.appointment.count({ where: { clinicId: fixture.clinic.id } });
    const intento = await pedido({ requestedTime: "12:00", replaceAppointmentId: ajena.appointment.id });
    expect(intento).toEqual({ ok: false, reason: "turno_a_reprogramar_no_encontrado" });

    expect(await prisma.appointment.count({ where: { clinicId: fixture.clinic.id } })).toBe(antes);
    const intacta = await prisma.appointment.findUniqueOrThrow({ where: { id: ajena.appointment.id } });
    expect(intacta.status).toBe("confirmado");
  });
});


describe("una persona no puede tener dos citas que se pisan", () => {
  it("rechaza una segunda cita a la misma hora para la misma persona (aunque sea con otro profesional)", async () => {
    // El caso del 2026-11-06: se agendó a las 11:30 y después "mejor con la Dra. X"
    // creó una segunda cita en vez de mover la primera.
    const primera = await pedido({ requestedProfessionalId: fixture.professionalIds[0] });
    expect(primera.ok).toBe(true);

    const segunda = await pedido({ requestedProfessionalId: fixture.professionalIds[1] });
    expect(segunda).toEqual({ ok: false, reason: "paciente_con_turno_superpuesto" });

    const vigentes = await prisma.appointment.count({
      where: { clinicId: fixture.clinic.id, status: "confirmado" },
    });
    expect(vigentes).toBe(1);
  });

  it("citas que NO se pisan (una después de otra) sí se permiten", async () => {
    expect((await pedido({ requestedTime: "10:00" })).ok).toBe(true);
    expect((await pedido({ requestedTime: "10:30" })).ok).toBe(true);
  });

  it("reprogramar cambiando solo de profesional funciona: la cita propia no estorba", async () => {
    const original = await pedido({ requestedProfessionalId: fixture.professionalIds[0] });
    expect(original.ok).toBe(true);
    if (!original.ok) return;

    const movida = await pedido({
      requestedProfessionalId: fixture.professionalIds[1],
      replaceAppointmentId: original.appointment.id,
    });
    expect(movida.ok).toBe(true);
    if (movida.ok) expect(movida.appointment.professionalId).toBe(fixture.professionalIds[1]);

    expect(
      await prisma.appointment.count({ where: { clinicId: fixture.clinic.id, status: "confirmado" } })
    ).toBe(1);
  });
});
