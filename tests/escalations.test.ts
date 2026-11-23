import { afterEach, describe, expect, it } from "vitest";
import type { Clinic, Patient } from "@prisma/client";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import {
  countPendingEscalations,
  createEscalation,
  listEscalations,
  markEscalationNotified,
  reopenEscalation,
  resolveEscalation,
  toEscalationReason,
} from "../src/repositories/escalations.repository";
import { getConfigHealth } from "../src/services/config-health";

/**
 * Derivaciones a una persona. Va contra el Postgres local
 * (docker compose up -d db).
 *
 * La garantía que importa: el asistente le PROMETE al paciente que alguien lo
 * va a contactar, así que el caso tiene que quedar registrado aunque el aviso
 * falle. Antes esto era un `console.warn` y una urgencia se perdía entera.
 */

const clinicIds: string[] = [];

async function crearClinica(options?: {
  urgencyNotifyEmail?: string | null;
}): Promise<{ clinic: Clinic; patient: Patient }> {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica derivaciones ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `esc-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "recepcion@example.com",
      urgencyNotifyEmail: options?.urgencyNotifyEmail ?? null,
      timezone: "UTC",
      services: "Consulta",
      workingHours: { create: [{ weekday: "lunes", startMinute: 540, endMinute: 1080 }] },
    },
  });
  clinicIds.push(clinic.id);

  const patient = await prisma.patient.create({
    data: {
      clinicId: clinic.id,
      phone: `549${Math.floor(Math.random() * 1e9)}`,
      name: "Carlos García",
    },
  });

  return { clinic, patient };
}

function datos(clinic: Clinic, patient: Patient, overrides?: Record<string, unknown>) {
  return {
    clinicId: clinic.id,
    patientId: patient.id,
    patientPhone: patient.phone,
    patientName: patient.name,
    reason: "urgencia" as const,
    patientMessage: "Hola me duele un diente",
    summary: "Escalamiento — urgencia",
    ...overrides,
  };
}

afterEach(async () => {
  for (const clinicId of clinicIds) {
    await prisma.escalation.deleteMany({ where: { clinicId } });
    await prisma.workingHours.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

describe("registro de derivaciones", () => {
  it("guarda el mensaje del paciente y su teléfono", async () => {
    const { clinic, patient } = await crearClinica();
    await createEscalation(datos(clinic, patient));

    const [derivacion] = await listEscalations({ clinicId: clinic.id });
    expect(derivacion.patientMessage).toBe("Hola me duele un diente");
    expect(derivacion.patientPhone).toBe(patient.phone);
    expect(derivacion.reason).toBe("urgencia");
    expect(derivacion.resolvedAt).toBeNull();
  });

  it("queda marcada como no avisada hasta que el mail sale", async () => {
    // Un pendiente sin aviso es el caso que hay que ir a buscar a mano.
    const { clinic, patient } = await crearClinica();
    const derivacion = await createEscalation(datos(clinic, patient));
    expect(derivacion.notifiedByEmail).toBe(false);

    await markEscalationNotified(derivacion.id);
    const [actualizada] = await listEscalations({ clinicId: clinic.id });
    expect(actualizada.notifiedByEmail).toBe(true);
  });

  it("no mezcla las derivaciones de dos clínicas", async () => {
    const una = await crearClinica();
    const otra = await crearClinica();
    await createEscalation(datos(una.clinic, una.patient));

    expect(await listEscalations({ clinicId: otra.clinic.id })).toEqual([]);
    expect(await countPendingEscalations(otra.clinic.id)).toBe(0);
  });
});

describe("cola de trabajo", () => {
  it("por default solo muestra las pendientes", async () => {
    const { clinic, patient } = await crearClinica();
    const pendiente = await createEscalation(datos(clinic, patient));
    const atendida = await createEscalation(
      datos(clinic, patient, { patientMessage: "Ya me lo resolvieron" })
    );
    await resolveEscalation(atendida.id, clinic.id, "admin@clinica.com");

    const soloPendientes = await listEscalations({ clinicId: clinic.id });
    expect(soloPendientes.map((e) => e.id)).toEqual([pendiente.id]);

    const todas = await listEscalations({ clinicId: clinic.id, incluirResueltos: true });
    expect(todas).toHaveLength(2);
  });

  it("marcar atendida guarda quién lo hizo", async () => {
    const { clinic, patient } = await crearClinica();
    const derivacion = await createEscalation(datos(clinic, patient));

    expect(await resolveEscalation(derivacion.id, clinic.id, "guardia@clinica.com")).toBe(true);
    const [actualizada] = await listEscalations({ clinicId: clinic.id, incluirResueltos: true });
    expect(actualizada.resolvedBy).toBe("guardia@clinica.com");
    expect(actualizada.resolvedAt).not.toBeNull();
    expect(await countPendingEscalations(clinic.id)).toBe(0);
  });

  it("marcar atendida dos veces no falla", async () => {
    // Dos personas de la clínica pueden tocar el botón a la vez.
    const { clinic, patient } = await crearClinica();
    const derivacion = await createEscalation(datos(clinic, patient));

    expect(await resolveEscalation(derivacion.id, clinic.id, "uno@clinica.com")).toBe(true);
    expect(await resolveEscalation(derivacion.id, clinic.id, "dos@clinica.com")).toBe(true);
  });

  it("se puede reabrir una derivación cerrada por error", async () => {
    const { clinic, patient } = await crearClinica();
    const derivacion = await createEscalation(datos(clinic, patient));
    await resolveEscalation(derivacion.id, clinic.id, "admin@clinica.com");

    expect(await reopenEscalation(derivacion.id, clinic.id)).toBe(true);
    expect(await countPendingEscalations(clinic.id)).toBe(1);
  });

  it("no deja tocar una derivación de otra clínica", async () => {
    const una = await crearClinica();
    const otra = await crearClinica();
    const derivacion = await createEscalation(datos(una.clinic, una.patient));

    expect(await resolveEscalation(derivacion.id, otra.clinic.id, "ajeno@clinica.com")).toBe(false);
  });
});

describe("toEscalationReason", () => {
  it("mapea los motivos conocidos", () => {
    expect(toEscalationReason("urgencia")).toBe("urgencia");
    expect(toEscalationReason("consulta_clinica")).toBe("consulta_clinica");
  });

  it("cualquier otra cosa cae en otro", () => {
    // `motivo_escalar` puede venir null del modelo; el enum no admite null.
    expect(toEscalationReason(null)).toBe("otro");
    expect(toEscalationReason(undefined)).toBe("otro");
    expect(toEscalationReason("inventado")).toBe("otro");
  });
});

describe("aviso de configuración", () => {
  it("no se queja si la clínica tiene mail donde avisar", async () => {
    const { clinic } = await crearClinica();
    const health = await getConfigHealth(clinic.id);
    expect(health?.issues.map((i) => i.code)).not.toContain("sin_destinatario_de_urgencias");
  });
});
