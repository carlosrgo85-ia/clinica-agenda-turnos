import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import { addDaysToDateKey, clinicWallTimeToUtc } from "../src/services/time";

/**
 * El rango que consulta la pantalla "Calendario".
 *
 * Lo que se prueba es que "el día 15" sean las 24 horas del 15 **en la zona
 * de la clínica**. Con `new Date("2026-09-15")` el rango arrancaría a las
 * 18:00 del 14 en México, y la agenda del día mostraría la tarde anterior y
 * se comería las citas de la noche.
 */

const TZ = "America/Mexico_City";
const clinicIds: string[] = [];

async function crearClinica() {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica calendario ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `cal-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "cal@example.com",
      timezone: TZ,
      services: "Consulta",
      professionals: { create: [{ name: "Dra. Uno" }] },
      rooms: { create: [{ name: "Consultorio 1" }] },
    },
  });
  clinicIds.push(clinic.id);

  const professional = await prisma.professional.findFirstOrThrow({
    where: { clinicId: clinic.id },
  });
  const room = await prisma.room.findFirstOrThrow({ where: { clinicId: clinic.id } });
  const patient = await prisma.patient.create({
    data: { clinicId: clinic.id, phone: "5215500000000", name: "Ana" },
  });

  return { clinic, professional, room, patient };
}

/** Una cita a una hora de pared de la clínica. */
async function crearCita(
  ctx: Awaited<ReturnType<typeof crearClinica>>,
  dateKey: string,
  hora: string,
  status: "confirmado" | "cancelado" = "confirmado"
) {
  const start = clinicWallTimeToUtc(dateKey, hora, TZ);
  if (!start) throw new Error("hora inválida en el fixture");
  return prisma.appointment.create({
    data: {
      clinicId: ctx.clinic.id,
      patientId: ctx.patient.id,
      professionalId: ctx.professional.id,
      roomId: ctx.room.id,
      service: "Consulta",
      startTime: start,
      endTime: new Date(start.getTime() + 30 * 60 * 1000),
      status,
    },
  });
}

/** El mismo rango que arma la ruta. */
function rangoDelDia(dateKey: string) {
  const inicio = clinicWallTimeToUtc(dateKey, "00:00", TZ);
  const fin = clinicWallTimeToUtc(addDaysToDateKey(dateKey, 1)!, "00:00", TZ);
  return { gte: inicio!, lt: fin! };
}

function citasDe(clinicId: string, dateKey: string) {
  return prisma.appointment.findMany({
    where: { clinicId, startTime: rangoDelDia(dateKey), status: { not: "cancelado" } },
    orderBy: { startTime: "asc" },
  });
}

afterEach(async () => {
  for (const clinicId of clinicIds) {
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.room.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

describe("rango del calendario", () => {
  it("trae las citas del día en la zona de la clínica", async () => {
    const ctx = await crearClinica();
    await crearCita(ctx, "2030-06-17", "09:00");
    await crearCita(ctx, "2030-06-17", "17:30");

    const citas = await citasDe(ctx.clinic.id, "2030-06-17");

    expect(citas).toHaveLength(2);
  });

  /**
   * El caso que justifica convertir con la zona: en México, la medianoche
   * local del 17 son las 06:00 UTC del 17, así que una cita de las 20:00 del
   * 16 cae en el 16 local aunque su instante UTC ya sea del 17.
   */
  it("no se cuela la noche del día anterior", async () => {
    const ctx = await crearClinica();
    const anterior = await crearCita(ctx, "2030-06-16", "20:00");

    const citas = await citasDe(ctx.clinic.id, "2030-06-17");

    expect(citas).toEqual([]);
    // Y sí aparece en su propio día.
    const suyas = await citasDe(ctx.clinic.id, "2030-06-16");
    expect(suyas.map((c) => c.id)).toEqual([anterior.id]);
  });

  it("incluye la última cita de la noche", async () => {
    const ctx = await crearClinica();
    await crearCita(ctx, "2030-06-17", "23:30");

    const citas = await citasDe(ctx.clinic.id, "2030-06-17");

    expect(citas).toHaveLength(1);
  });

  it("no muestra las canceladas, que no ocupan lugar en la agenda", async () => {
    const ctx = await crearClinica();
    await crearCita(ctx, "2030-06-17", "09:00");
    await crearCita(ctx, "2030-06-17", "10:00", "cancelado");

    const citas = await citasDe(ctx.clinic.id, "2030-06-17");

    expect(citas).toHaveLength(1);
  });

  it("la semana son los siete días", async () => {
    const ctx = await crearClinica();
    // Lunes 2030-06-17 a domingo 2030-06-23.
    await crearCita(ctx, "2030-06-17", "09:00");
    await crearCita(ctx, "2030-06-23", "09:00");
    // Fuera de la semana.
    await crearCita(ctx, "2030-06-24", "09:00");

    const inicio = clinicWallTimeToUtc("2030-06-17", "00:00", TZ)!;
    const fin = clinicWallTimeToUtc("2030-06-24", "00:00", TZ)!;
    const citas = await prisma.appointment.findMany({
      where: { clinicId: ctx.clinic.id, startTime: { gte: inicio, lt: fin } },
    });

    expect(citas).toHaveLength(2);
  });

  /**
   * Regresión del buscador de "Citas" (2026-09-15): buscar del 11 al 15 no
   * devolvía ninguna cita del 15.
   *
   * `hasta` se convertía con `new Date("2026-09-15")`, o sea la medianoche
   * UTC del 15 — las 18:00 del 14 en México — y se comparaba con `lte`. El
   * resultado era que el día elegido como tope quedaba entero afuera.
   * Ahora `hasta` es la medianoche del día SIGUIENTE en hora de la clínica,
   * comparada con `lt`.
   */
  it("el día elegido como 'hasta' entra completo", async () => {
    const ctx = await crearClinica();
    await crearCita(ctx, "2030-06-17", "09:00");
    // La del último día, a la tarde: es la que se perdía.
    const delTope = await crearCita(ctx, "2030-06-19", "15:00");
    await crearCita(ctx, "2030-06-20", "09:00");

    const desde = clinicWallTimeToUtc("2030-06-17", "00:00", TZ)!;
    const hasta = clinicWallTimeToUtc(addDaysToDateKey("2030-06-19", 1)!, "00:00", TZ)!;
    const citas = await prisma.appointment.findMany({
      where: { clinicId: ctx.clinic.id, startTime: { gte: desde, lt: hasta } },
      orderBy: { startTime: "asc" },
    });

    expect(citas).toHaveLength(2);
    expect(citas.map((c) => c.id)).toContain(delTope.id);
  });

  it("incluye una cita a las 23:59 del día tope", async () => {
    const ctx = await crearClinica();
    const tarde = await crearCita(ctx, "2030-06-19", "23:30");

    const hasta = clinicWallTimeToUtc(addDaysToDateKey("2030-06-19", 1)!, "00:00", TZ)!;
    const citas = await prisma.appointment.findMany({
      where: { clinicId: ctx.clinic.id, startTime: { lt: hasta } },
    });

    expect(citas.map((c) => c.id)).toContain(tarde.id);
  });

  /** El filtro plural, que es lo que va a usar el filtro por sucursal. */
  it("filtra por una lista de profesionales", async () => {
    const ctx = await crearClinica();
    const otro = await prisma.professional.create({
      data: { clinicId: ctx.clinic.id, name: "Dr. Dos" },
    });
    await crearCita(ctx, "2030-06-17", "09:00");
    await prisma.appointment.create({
      data: {
        clinicId: ctx.clinic.id,
        patientId: ctx.patient.id,
        professionalId: otro.id,
        roomId: ctx.room.id,
        service: "Consulta",
        startTime: clinicWallTimeToUtc("2030-06-17", "11:00", TZ)!,
        endTime: clinicWallTimeToUtc("2030-06-17", "11:30", TZ)!,
      },
    });

    const soloDelOtro = await prisma.appointment.findMany({
      where: {
        clinicId: ctx.clinic.id,
        startTime: rangoDelDia("2030-06-17"),
        professionalId: { in: [otro.id] },
      },
    });

    expect(soloDelOtro).toHaveLength(1);
    expect(soloDelOtro[0].professionalId).toBe(otro.id);
  });
});
