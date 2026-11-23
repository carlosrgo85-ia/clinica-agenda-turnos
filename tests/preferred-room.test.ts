import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import { checkAvailability, findAvailableRoom } from "../src/services/availability";

/**
 * El espacio habitual de un profesional.
 *
 * Es una PREFERENCIA, no una restricción: si está ocupado se le asigna otro
 * libre y el turno queda marcado. Eso es lo que hace que **no cambie la
 * disponibilidad** — los mismos horarios se ofrecen y se aceptan que antes—
 * y por eso el enumerador de huecos no necesita saber nada de esto.
 */

const INICIO = new Date("2030-06-17T13:00:00.000Z");
const FIN = new Date("2030-06-17T13:30:00.000Z");
const clinicIds: string[] = [];

async function crearEscenario() {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica espacios ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `espacios-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "espacios@example.com",
      timezone: "UTC",
      services: "Consulta",
      rooms: { create: [{ name: "Consultorio 1" }, { name: "Consultorio 2" }] },
    },
  });
  clinicIds.push(clinic.id);

  const [sala1, sala2] = await prisma.room.findMany({
    where: { clinicId: clinic.id },
    orderBy: { name: "asc" },
  });
  const profesional = await prisma.professional.create({
    data: { clinicId: clinic.id, name: "Dra. Uno", preferredRoomId: sala2.id },
  });
  const patient = await prisma.patient.create({
    data: { clinicId: clinic.id, phone: "549110000000" },
  });

  return { clinic, sala1, sala2, profesional, patient };
}

/** Ocupa un espacio en el mismo rango, con otro profesional. */
async function ocupar(ctx: Awaited<ReturnType<typeof crearEscenario>>, roomId: string) {
  const otro = await prisma.professional.create({
    data: { clinicId: ctx.clinic.id, name: `Otro ${Math.random()}` },
  });
  return prisma.appointment.create({
    data: {
      clinicId: ctx.clinic.id,
      patientId: ctx.patient.id,
      professionalId: otro.id,
      roomId,
      service: "Consulta",
      startTime: INICIO,
      endTime: FIN,
    },
  });
}

afterEach(async () => {
  for (const clinicId of clinicIds) {
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.professional.updateMany({ where: { clinicId }, data: { preferredRoomId: null } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.room.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

describe("findAvailableRoom con espacio preferido", () => {
  it("le da el suyo cuando está libre, aunque no sea el primero de la lista", async () => {
    const ctx = await crearEscenario();

    const roomId = await findAvailableRoom(ctx.clinic.id, INICIO, FIN, prisma, ctx.sala2.id);

    expect(roomId).toBe(ctx.sala2.id);
  });

  it("le da cualquier otro cuando el suyo está ocupado", async () => {
    const ctx = await crearEscenario();
    await ocupar(ctx, ctx.sala2.id);

    const roomId = await findAvailableRoom(ctx.clinic.id, INICIO, FIN, prisma, ctx.sala2.id);

    expect(roomId).toBe(ctx.sala1.id);
  });

  it("sin preferencia se comporta como siempre: el primero libre", async () => {
    const ctx = await crearEscenario();

    const roomId = await findAvailableRoom(ctx.clinic.id, INICIO, FIN, prisma, null);

    expect(roomId).toBe(ctx.sala1.id);
  });

  it("no inventa un espacio cuando están todos ocupados", async () => {
    const ctx = await crearEscenario();
    await ocupar(ctx, ctx.sala1.id);
    await ocupar(ctx, ctx.sala2.id);

    const roomId = await findAvailableRoom(ctx.clinic.id, INICIO, FIN, prisma, ctx.sala2.id);

    expect(roomId).toBeNull();
  });

  it("ignora un espacio desactivado aunque sea el preferido", async () => {
    const ctx = await crearEscenario();
    await prisma.room.update({ where: { id: ctx.sala2.id }, data: { active: false } });

    const roomId = await findAvailableRoom(ctx.clinic.id, INICIO, FIN, prisma, ctx.sala2.id);

    expect(roomId).toBe(ctx.sala1.id);
  });
});

describe("checkAvailability marca cuándo no le tocó el suyo", () => {
  it("no marca nada si le tocó su espacio", async () => {
    const ctx = await crearEscenario();

    const r = await checkAvailability({
      clinicId: ctx.clinic.id,
      professionalId: ctx.profesional.id,
      start: INICIO,
      end: FIN,
      preferredRoomId: ctx.sala2.id,
    });

    expect(r.available).toBe(true);
    expect(r.roomId).toBe(ctx.sala2.id);
    expect(r.preferredRoomUnavailable).toBe(false);
  });

  it("marca el turno cuando su espacio estaba ocupado", async () => {
    const ctx = await crearEscenario();
    await ocupar(ctx, ctx.sala2.id);

    const r = await checkAvailability({
      clinicId: ctx.clinic.id,
      professionalId: ctx.profesional.id,
      start: INICIO,
      end: FIN,
      preferredRoomId: ctx.sala2.id,
    });

    expect(r.available).toBe(true);
    expect(r.roomId).toBe(ctx.sala1.id);
    expect(r.preferredRoomUnavailable).toBe(true);
  });

  it("sin preferencia nunca marca nada", async () => {
    const ctx = await crearEscenario();

    const r = await checkAvailability({
      clinicId: ctx.clinic.id,
      professionalId: ctx.profesional.id,
      start: INICIO,
      end: FIN,
      preferredRoomId: null,
    });

    expect(r.preferredRoomUnavailable).toBe(false);
  });

  /**
   * Lo que hace que esto sea seguro: una preferencia no puede quitar
   * disponibilidad. Si quedaba un espacio libre, el horario sigue estando
   * disponible — que es exactamente lo que ya calculó el enumerador de
   * huecos, que no mira preferencias.
   */
  it("una preferencia ocupada no vuelve indisponible el horario", async () => {
    const ctx = await crearEscenario();
    await ocupar(ctx, ctx.sala2.id);

    const conPreferencia = await checkAvailability({
      clinicId: ctx.clinic.id,
      professionalId: ctx.profesional.id,
      start: INICIO,
      end: FIN,
      preferredRoomId: ctx.sala2.id,
    });
    const sinPreferencia = await checkAvailability({
      clinicId: ctx.clinic.id,
      professionalId: ctx.profesional.id,
      start: INICIO,
      end: FIN,
      preferredRoomId: null,
    });

    expect(conPreferencia.available).toBe(sinPreferencia.available);
    expect(conPreferencia.available).toBe(true);
  });
});
