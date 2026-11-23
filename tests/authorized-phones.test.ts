import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import { applyBookingPhones, findPatientsByPhone, getOrCreateConversationPatient } from "../src/repositories/patients.repository";
import { normalizeWhatsAppNumber } from "../src/services/phone";
import { parseAgentResponse } from "../src/services/claude";
import { updatePatient } from "../src/services/patient-admin";

/**
 * Al agendar para otra persona se acuerda con qué número se la registra y quién más queda autorizado a consultar sus
 * citas. Lo que importa: lo autorizado es lo ÚNICO que se suma a lo que un número ve, y quien escribe no puede reescribir los
 * datos de contacto de alguien ya registrado.
 */

const ESCRIBE = "5215500000001";
const OTRO = "5215500000002";
const FAMILIAR = "5215500000003";
const clinicIds: string[] = [];

async function crearClinica() {
  const c = await prisma.clinic.create({
    data: {
      name: `Clínica autorizados ${Date.now()}-${Math.random()}`, whatsappPhoneNumberId: `aut-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("t"), email: "a@example.com", timezone: "UTC", services: "Consulta",
    },
  });
  clinicIds.push(c.id);
  return c.id;
}

afterEach(async () => {
  for (const id of clinicIds) {
    await prisma.appointment.deleteMany({ where: { clinicId: id } });
    await prisma.patient.deleteMany({ where: { clinicId: id } });
    await prisma.clinic.delete({ where: { id } });
  }
  clinicIds.length = 0;
});

describe("normalizeWhatsAppNumber", () => {
  it("deja solo los dígitos y descarta lo que no parece un número", () => {
    expect(normalizeWhatsAppNumber("+52 (55) 1234-5678")).toBe("525512345678");
    expect(normalizeWhatsAppNumber("12345")).toBeNull();
    expect(normalizeWhatsAppNumber("1".repeat(16))).toBeNull();
    expect(normalizeWhatsAppNumber("no tengo")).toBeNull();
  });

  it("parseAgentResponse normaliza los teléfonos del modelo y los vuelve null si no sirven", () => {
    const base = { intent: "agendar", requiere_horarios_disponibles: false, confirmacion_explicita: false, escalar_a_humano: false, respuesta_al_paciente: "ok" };
    const r = parseAgentResponse(JSON.stringify({ ...base, telefono_registro: "+52 55 0000 0002", telefono_autorizado: "abc" }))!;
    expect(r.telefono_registro).toBe("525500000002");
    expect(r.telefono_autorizado).toBeNull();
    expect(parseAgentResponse(JSON.stringify(base))!.telefono_registro).toBeNull();
  });
});

describe("applyBookingPhones", () => {
  async function familiar(clinicId: string) {
    await getOrCreateConversationPatient(clinicId, ESCRIBE);
    return prisma.patient.create({ data: { clinicId, phone: ESCRIBE, name: "Ana Ruiz" } });
  }

  it("registrar con OTRO número mueve la ficha y deja autorizado a quien agendó, que sigue viéndola", async () => {
    const clinicId = await crearClinica();
    const ana = await familiar(clinicId);
    const r = await applyBookingPhones({ patient: ana, writerPhone: ESCRIBE, registro: OTRO, autorizado: FAMILIAR });
    expect(r.phone).toBe(OTRO);
    expect(r.authorizedPhones.sort()).toEqual([ESCRIBE, FAMILIAR].sort());
    expect((await findPatientsByPhone(clinicId, ESCRIBE)).map((p) => p.id)).toContain(ana.id);
    expect((await findPatientsByPhone(clinicId, FAMILIAR)).map((p) => p.id)).toEqual([ana.id]);
    expect((await findPatientsByPhone(clinicId, OTRO)).map((p) => p.id)).toEqual([ana.id]);
    // Una auditoría sin los números.
    const audit = await prisma.auditLog.findFirst({ where: { clinicId, action: "patient.phones_set" } });
    expect(JSON.stringify(audit?.details)).not.toContain(OTRO);
  });

  it("el número de quien escribe sigue siendo el titular: lo autorizado se lista después de lo propio", async () => {
    const clinicId = await crearClinica();
    const titular = await getOrCreateConversationPatient(clinicId, FAMILIAR);
    const ana = await familiar(clinicId);
    await applyBookingPhones({ patient: ana, writerPhone: ESCRIBE, autorizado: FAMILIAR });
    const vistas = await findPatientsByPhone(clinicId, FAMILIAR);
    expect(vistas.map((p) => p.id)).toEqual([titular.id, ana.id]);
    expect((await getOrCreateConversationPatient(clinicId, FAMILIAR)).id).toBe(titular.id);
  });

  it("sin cambios de número, solo suma el autorizado y la ficha sigue en el número de quien escribe", async () => {
    const clinicId = await crearClinica();
    const ana = await familiar(clinicId);
    const r = await applyBookingPhones({ patient: ana, writerPhone: ESCRIBE, autorizado: FAMILIAR });
    expect(r.phone).toBe(ESCRIBE);
    expect(r.authorizedPhones).toEqual([FAMILIAR]);
  });

  it("no toca una ficha que ya tiene citas ni una que ya vive en otro número", async () => {
    const clinicId = await crearClinica();
    const ana = await familiar(clinicId);
    const prof = await prisma.professional.create({ data: { clinicId, name: "P" } });
    const room = await prisma.room.create({ data: { clinicId, name: "R" } });
    await prisma.appointment.create({
      data: { clinicId, patientId: ana.id, professionalId: prof.id, roomId: room.id, service: "x", startTime: new Date("2030-01-01T10:00:00Z"), endTime: new Date("2030-01-01T10:30:00Z") },
    });
    expect(await applyBookingPhones({ patient: ana, writerPhone: ESCRIBE, registro: OTRO })).toEqual(ana);
    const ajena = await prisma.patient.create({ data: { clinicId, phone: OTRO, name: "Otra" } });
    expect(await applyBookingPhones({ patient: ajena, writerPhone: ESCRIBE, autorizado: FAMILIAR })).toEqual(ajena);
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.room.delete({ where: { id: room.id } });
    await prisma.professional.delete({ where: { id: prof.id } });
  });

  it("en el chat de pruebas no mueve el número real (los avisos saldrían a un teléfono verdadero)", async () => {
    const clinicId = await crearClinica();
    const ana = await familiar(clinicId);
    const r = await applyBookingPhones({ patient: ana, writerPhone: ESCRIBE, registro: OTRO, autorizado: FAMILIAR, sandbox: true });
    expect(r.phone).toBe(ESCRIBE);
    expect(r.authorizedPhones).toEqual([FAMILIAR]);
  });
});

describe("el panel edita los números autorizados", () => {
  it("normaliza, descarta el propio y repetidos, valida y audita solo el nombre del campo", async () => {
    const clinicId = await crearClinica();
    const p = await prisma.patient.create({ data: { clinicId, phone: ESCRIBE, name: "Ana Ruiz" } });
    const ok = await updatePatient({ clinicId, patientId: p.id, changes: { authorizedPhones: [`+${FAMILIAR}`, FAMILIAR, ESCRIBE] } });
    expect(ok.ok && ok.value.authorizedPhones).toEqual([FAMILIAR]);
    expect(ok.ok && ok.changedFields).toContain("authorizedPhones");
    const mal = await updatePatient({ clinicId, patientId: p.id, changes: { authorizedPhones: ["abc"] } });
    expect(mal.ok).toBe(false);
    const muchos = await updatePatient({ clinicId, patientId: p.id, changes: { authorizedPhones: ["11111111", "22222222", "33333333", "44444444"] } });
    expect(muchos.ok).toBe(false);
  });
});
