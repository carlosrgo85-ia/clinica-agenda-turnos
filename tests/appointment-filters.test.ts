import { afterEach, describe, expect, it } from "vitest";
import type { AppointmentStatus } from "@prisma/client";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";

/**
 * Los filtros del buscador de turnos, contra la base.
 *
 * Se arma el `where` igual que la ruta y se prueba el resultado: lo que
 * importa es que el filtro traiga lo que tiene que traer, no el ruteo de
 * Express (que no se testea en este proyecto, ver CLAUDE.md).
 *
 * El caso que justifica estos tests es el del servicio: filtrar por
 * `serviceId` dejaría afuera los turnos que no matchearon el catálogo, que
 * son la mayoría de los viejos.
 */

const clinicIds: string[] = [];

async function crearEscenario() {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica filtros ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `filtros-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "filtros@example.com",
      timezone: "UTC",
      services: "Limpieza",
      professionals: { create: [{ name: "Dra. Uno" }, { name: "Dr. Dos" }] },
      rooms: { create: [{ name: "Consultorio 1" }, { name: "Consultorio 2" }] },
    },
  });
  clinicIds.push(clinic.id);

  const [uno, dos] = await prisma.professional.findMany({
    where: { clinicId: clinic.id },
    orderBy: { name: "asc" },
  });
  const [sala1, sala2] = await prisma.room.findMany({
    where: { clinicId: clinic.id },
    orderBy: { name: "asc" },
  });
  const patient = await prisma.patient.create({
    data: { clinicId: clinic.id, phone: "549110000000", name: "Ana Pérez Gómez" },
  });

  // Un servicio del catálogo, para tener un turno con `serviceId` y otro sin.
  const catalogo = await prisma.service.create({
    data: { clinicId: clinic.id, name: "Limpieza", durationMinutes: 30 },
  });

  async function turno(params: {
    service: string;
    serviceId?: string;
    professionalId: string;
    roomId: string;
    status: AppointmentStatus;
    hora: number;
  }) {
    return prisma.appointment.create({
      data: {
        clinicId: clinic.id,
        patientId: patient.id,
        professionalId: params.professionalId,
        roomId: params.roomId,
        serviceId: params.serviceId ?? null,
        service: params.service,
        startTime: new Date(Date.UTC(2030, 5, 17, params.hora)),
        endTime: new Date(Date.UTC(2030, 5, 17, params.hora, 30)),
        status: params.status,
      },
    });
  }

  await turno({
    service: "Limpieza",
    serviceId: catalogo.id,
    professionalId: uno.id,
    roomId: sala1.id,
    status: "confirmado",
    hora: 9,
  });
  // Mismo servicio por nombre, pero sin catálogo: el caso que un filtro por
  // `serviceId` dejaría afuera.
  await turno({
    service: "Limpieza",
    professionalId: dos.id,
    roomId: sala2.id,
    status: "atendido",
    hora: 10,
  });
  await turno({
    service: "control",
    professionalId: uno.id,
    roomId: sala2.id,
    status: "cancelado",
    hora: 11,
  });

  return { clinicId: clinic.id, uno, dos, sala1, sala2 };
}

/** El mismo `where` que arma la ruta. */
function buscar(clinicId: string, filtros: Record<string, unknown>) {
  return prisma.appointment.findMany({
    where: { clinicId, ...filtros },
    orderBy: { startTime: "asc" },
  });
}

afterEach(async () => {
  for (const clinicId of clinicIds) {
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.service.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.room.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

describe("filtros del buscador de turnos", () => {
  it("filtra por estado", async () => {
    const { clinicId } = await crearEscenario();

    const atendidos = await buscar(clinicId, { status: "atendido" });

    expect(atendidos).toHaveLength(1);
    expect(atendidos[0].service).toBe("Limpieza");
  });

  /**
   * El motivo de filtrar por nombre y no por `serviceId`: los dos turnos de
   * "Limpieza" tienen que aparecer, aunque uno no esté en el catálogo.
   */
  it("filtra por servicio incluyendo los turnos sin catálogo", async () => {
    const { clinicId } = await crearEscenario();

    const limpiezas = await buscar(clinicId, {
      service: { equals: "Limpieza", mode: "insensitive" as const },
    });

    expect(limpiezas).toHaveLength(2);
    expect(limpiezas.filter((t) => t.serviceId === null)).toHaveLength(1);
  });

  it("el servicio no distingue mayúsculas", async () => {
    const { clinicId } = await crearEscenario();

    const controles = await buscar(clinicId, {
      service: { equals: "CONTROL", mode: "insensitive" as const },
    });

    expect(controles).toHaveLength(1);
  });

  it("filtra por profesional", async () => {
    const { clinicId, uno } = await crearEscenario();

    const deUno = await buscar(clinicId, { professionalId: uno.id });

    expect(deUno).toHaveLength(2);
  });

  it("filtra por espacio", async () => {
    const { clinicId, sala2 } = await crearEscenario();

    const enSala2 = await buscar(clinicId, { roomId: sala2.id });

    expect(enSala2).toHaveLength(2);
  });

  it("combina filtros", async () => {
    const { clinicId, uno, sala2 } = await crearEscenario();

    const combinado = await buscar(clinicId, {
      professionalId: uno.id,
      roomId: sala2.id,
      status: "cancelado",
    });

    expect(combinado).toHaveLength(1);
    expect(combinado[0].service).toBe("control");
  });

  /** El apellido entra por el mismo `q` que el nombre, sin filtro aparte. */
  it("busca por apellido dentro del nombre del paciente", async () => {
    const { clinicId } = await crearEscenario();

    const porApellido = await buscar(clinicId, {
      patient: { name: { contains: "Pérez", mode: "insensitive" as const } },
    });

    expect(porApellido).toHaveLength(3);
  });

  it("no devuelve turnos de otra clínica aunque el id de profesional exista", async () => {
    const propia = await crearEscenario();
    const ajena = await crearEscenario();

    // Se pide el profesional de la OTRA clínica, acotado a la propia.
    const resultado = await buscar(propia.clinicId, { professionalId: ajena.uno.id });

    expect(resultado).toEqual([]);
  });
});

describe("opciones de los filtros", () => {
  it("lista los servicios que la clínica realmente tiene, sin repetir", async () => {
    const { clinicId } = await crearEscenario();

    const servicios = await prisma.appointment.findMany({
      where: { clinicId },
      distinct: ["service"],
      select: { service: true },
      orderBy: { service: "asc" },
    });

    expect(servicios.map((s) => s.service)).toEqual(["Limpieza", "control"]);
  });
});
