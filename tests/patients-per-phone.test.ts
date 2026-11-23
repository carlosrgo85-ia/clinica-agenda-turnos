import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import {
  findPatientsByPhone,
  getOrCreateConversationPatient,
  normalizarNombre,
  resolvePatientForBooking,
} from "../src/repositories/patients.repository";

/**
 * Varias personas en un mismo WhatsApp.
 *
 * El caso real (2026-09-14): Carlos pidió un turno "para Nieves de García" y
 * quedó a su propio nombre, porque `Patient` estaba identificado por
 * teléfono. Además de arruinar el nombre, eso rompía la regla de primera vez
 * —el número ya tenía turnos, así que Nieves no era "nueva"— y mezclaba el
 * CRM de toda la familia en una ficha.
 */

const TELEFONO = "5215564000000";
const clinicIds: string[] = [];

async function crearClinica(): Promise<string> {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica familia ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `familia-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "familia@example.com",
      timezone: "UTC",
      services: "Consulta",
    },
  });
  clinicIds.push(clinic.id);
  return clinic.id;
}

afterEach(async () => {
  for (const clinicId of clinicIds) {
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

describe("normalizarNombre", () => {
  it("ignora acentos, mayúsculas y espacios de más", () => {
    expect(normalizarNombre("NIEVES DE GARCÍA")).toBe(normalizarNombre("  Nieves de Garcia "));
  });

  it("no confunde dos personas distintas", () => {
    expect(normalizarNombre("Nieves de García")).not.toBe(normalizarNombre("Carlos García"));
  });
});

describe("getOrCreateConversationPatient", () => {
  it("crea el titular en el primer mensaje", async () => {
    const clinicId = await crearClinica();

    const titular = await getOrCreateConversationPatient(clinicId, TELEFONO);

    expect(titular.phone).toBe(TELEFONO);
    expect(await findPatientsByPhone(clinicId, TELEFONO)).toHaveLength(1);
  });

  it("devuelve siempre la misma ficha, aunque el número tenga varias", async () => {
    const clinicId = await crearClinica();
    const titular = await getOrCreateConversationPatient(clinicId, TELEFONO);
    await prisma.patient.create({
      data: { clinicId, phone: TELEFONO, name: "Nieves de García" },
    });

    const otraVez = await getOrCreateConversationPatient(clinicId, TELEFONO);

    // El titular es la ficha MÁS VIEJA: la conversación es suya.
    expect(otraVez.id).toBe(titular.id);
  });
});

describe("resolvePatientForBooking", () => {
  it("sin nombre, el turno es del titular", async () => {
    const clinicId = await crearClinica();
    const titular = await getOrCreateConversationPatient(clinicId, TELEFONO);

    const resuelto = await resolvePatientForBooking({
      clinicId,
      phone: TELEFONO,
      nombre: null,
      titular,
    });

    expect(resuelto.id).toBe(titular.id);
  });

  /** El caso que faltaba: el titular se presenta por primera vez. */
  it("le pone el nombre al titular si todavía no tenía", async () => {
    const clinicId = await crearClinica();
    const titular = await getOrCreateConversationPatient(clinicId, TELEFONO);

    const resuelto = await resolvePatientForBooking({
      clinicId,
      phone: TELEFONO,
      nombre: "Carlos García Ortiz",
      titular,
    });

    expect(resuelto.id).toBe(titular.id);
    expect(resuelto.name).toBe("Carlos García Ortiz");
    // Y no creó una ficha de más.
    expect(await findPatientsByPhone(clinicId, TELEFONO)).toHaveLength(1);
  });

  /**
   * El bug exacto que se reportó: Carlos ya tenía nombre y pidió un turno
   * para Nieves. Antes esto devolvía la ficha de Carlos.
   */
  it("crea una ficha nueva para otra persona del mismo número", async () => {
    const clinicId = await crearClinica();
    const titular = await getOrCreateConversationPatient(clinicId, TELEFONO);
    await prisma.patient.update({
      where: { id: titular.id },
      data: { name: "Carlos García Ortiz" },
    });
    const conNombre = await prisma.patient.findUniqueOrThrow({ where: { id: titular.id } });

    const resuelto = await resolvePatientForBooking({
      clinicId,
      phone: TELEFONO,
      nombre: "Nieves de García",
      titular: conNombre,
    });

    expect(resuelto.id).not.toBe(titular.id);
    expect(resuelto.name).toBe("Nieves de García");
    expect(resuelto.phone).toBe(TELEFONO);

    // Y la ficha de Carlos quedó intacta: no se renombró.
    const carlos = await prisma.patient.findUniqueOrThrow({ where: { id: titular.id } });
    expect(carlos.name).toBe("Carlos García Ortiz");
  });

  it("reusa la ficha que ya existe en vez de duplicarla", async () => {
    const clinicId = await crearClinica();
    const titular = await getOrCreateConversationPatient(clinicId, TELEFONO);
    await prisma.patient.update({ where: { id: titular.id }, data: { name: "Carlos" } });
    const conNombre = await prisma.patient.findUniqueOrThrow({ where: { id: titular.id } });
    const nieves = await prisma.patient.create({
      data: { clinicId, phone: TELEFONO, name: "Nieves de García" },
    });

    // Escrito distinto: sin acento y en mayúsculas.
    const resuelto = await resolvePatientForBooking({
      clinicId,
      phone: TELEFONO,
      nombre: "NIEVES DE GARCIA",
      titular: conNombre,
    });

    expect(resuelto.id).toBe(nieves.id);
    expect(await findPatientsByPhone(clinicId, TELEFONO)).toHaveLength(2);
  });

  it("no mezcla personas de dos números distintos", async () => {
    const clinicId = await crearClinica();
    const titular = await getOrCreateConversationPatient(clinicId, TELEFONO);
    await prisma.patient.update({ where: { id: titular.id }, data: { name: "Carlos" } });
    const conNombre = await prisma.patient.findUniqueOrThrow({ where: { id: titular.id } });
    // Una Nieves de OTRO teléfono: no es la misma persona.
    await prisma.patient.create({
      data: { clinicId, phone: "5215599999999", name: "Nieves de García" },
    });

    const resuelto = await resolvePatientForBooking({
      clinicId,
      phone: TELEFONO,
      nombre: "Nieves de García",
      titular: conNombre,
    });

    expect(resuelto.phone).toBe(TELEFONO);
    expect(await findPatientsByPhone(clinicId, TELEFONO)).toHaveLength(2);
  });

  /**
   * La consecuencia que más importa: con una ficha propia, la persona nueva
   * SÍ es primera vez, así que la política del profesional principal se le
   * aplica. Antes el número ya tenía turnos y la regla se salteaba.
   */
  it("la persona nueva no hereda el historial del titular", async () => {
    const clinicId = await crearClinica();
    const titular = await getOrCreateConversationPatient(clinicId, TELEFONO);
    await prisma.patient.update({ where: { id: titular.id }, data: { name: "Carlos" } });
    const conNombre = await prisma.patient.findUniqueOrThrow({ where: { id: titular.id } });

    const profesional = await prisma.professional.create({
      data: { clinicId, name: "Dra. Uno" },
    });
    const room = await prisma.room.create({ data: { clinicId, name: "Consultorio 1" } });
    await prisma.appointment.create({
      data: {
        clinicId,
        patientId: titular.id,
        professionalId: profesional.id,
        roomId: room.id,
        service: "Consulta",
        startTime: new Date("2030-06-17T13:00:00.000Z"),
        endTime: new Date("2030-06-17T13:30:00.000Z"),
      },
    });

    const nieves = await resolvePatientForBooking({
      clinicId,
      phone: TELEFONO,
      nombre: "Nieves de García",
      titular: conNombre,
    });

    const turnosDeNieves = await prisma.appointment.count({
      where: { clinicId, patientId: nieves.id },
    });
    expect(turnosDeNieves).toBe(0);

    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.room.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
  });
});
