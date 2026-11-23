import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import { ABANDONED_AFTER_MS, sweepAbandonedInbound } from "../src/jobs/inbound-sweeper";

/**
 * El rescate de los mensajes que dejó colgando una instancia caída.
 *
 * `runAgentTurn` se inyecta: lo que se prueba es a quién rescata y a quién
 * no, no lo que contesta el modelo.
 */

const TELEFONO = "5491100000009";
const clinicIds: string[] = [];

async function crearClinica(activa = true): Promise<string> {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica barrido ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `barrido-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "barrido@example.com",
      timezone: "UTC",
      services: "Consulta",
      active: activa,
    },
  });
  clinicIds.push(clinic.id);
  return clinic.id;
}

function encolarHace(clinicId: string, haceMs: number, text: string, phone = TELEFONO) {
  return prisma.pendingInboundMessage.create({
    data: {
      clinicId,
      patientPhone: phone,
      text,
      receivedAt: new Date(Date.now() - haceMs),
    },
  });
}

/** Registra los turnos que se habrían corrido, sin llamar al modelo. */
function fakeRunTurn() {
  const corridos: Array<{ clinicId: string; from: string; text: string }> = [];
  const runTurn = (async (input: { clinic: { id: string }; from: string; text: string }) => {
    corridos.push({ clinicId: input.clinic.id, from: input.from, text: input.text });
  }) as Parameters<typeof sweepAbandonedInbound>[1];
  return { corridos, runTurn };
}

afterEach(async () => {
  for (const clinicId of clinicIds) {
    await prisma.pendingInboundMessage.deleteMany({ where: { clinicId } });
    await prisma.conversationMessage.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

describe("sweepAbandonedInbound", () => {
  it("rescata un lote abandonado y lo manda junto", async () => {
    const clinicId = await crearClinica();
    await encolarHace(clinicId, ABANDONED_AFTER_MS + 10_000, "Agendar la cita");
    await encolarHace(clinicId, ABANDONED_AFTER_MS + 9_000, "Para mañana");
    const { corridos, runTurn } = fakeRunTurn();

    await sweepAbandonedInbound(new Date(), runTurn);

    expect(corridos).toHaveLength(1);
    expect(corridos[0].text).toBe("Agendar la cita\nPara mañana");
    expect(corridos[0].from).toBe(TELEFONO);
    expect(await prisma.pendingInboundMessage.count({ where: { clinicId } })).toBe(0);
  });

  /**
   * Lo más importante: el barrido no puede robarle el lote a un webhook que
   * todavía está esperando a que el paciente termine de escribir. Si lo
   * hiciera, la respuesta saldría partida — justo lo que esto viene a evitar.
   */
  it("no toca los mensajes recientes, que todavía espera el webhook", async () => {
    const clinicId = await crearClinica();
    await encolarHace(clinicId, 2_000, "Recién llegado");
    const { corridos, runTurn } = fakeRunTurn();

    await sweepAbandonedInbound(new Date(), runTurn);

    expect(corridos).toEqual([]);
    expect(await prisma.pendingInboundMessage.count({ where: { clinicId } })).toBe(1);
  });

  it("descarta los pendientes de una clínica dada de baja", async () => {
    const clinicId = await crearClinica(false);
    await encolarHace(clinicId, ABANDONED_AFTER_MS + 10_000, "Hola");
    const { corridos, runTurn } = fakeRunTurn();

    await sweepAbandonedInbound(new Date(), runTurn);

    expect(corridos).toEqual([]);
    // Se borran: si no, el barrido los reintentaría cada minuto para siempre.
    expect(await prisma.pendingInboundMessage.count({ where: { clinicId } })).toBe(0);
  });

  it("rescata cada conversación por separado", async () => {
    const clinicId = await crearClinica();
    await encolarHace(clinicId, ABANDONED_AFTER_MS + 10_000, "De Ana", "5491100000010");
    await encolarHace(clinicId, ABANDONED_AFTER_MS + 10_000, "De Beto", "5491100000011");
    const { corridos, runTurn } = fakeRunTurn();

    await sweepAbandonedInbound(new Date(), runTurn);

    expect(corridos).toHaveLength(2);
    expect(corridos.map((c) => c.text).sort()).toEqual(["De Ana", "De Beto"]);
  });

  it("una conversación que falla no frena a las demás", async () => {
    const clinicId = await crearClinica();
    await encolarHace(clinicId, ABANDONED_AFTER_MS + 10_000, "Primera", "5491100000012");
    await encolarHace(clinicId, ABANDONED_AFTER_MS + 10_000, "Segunda", "5491100000013");

    let llamadas = 0;
    const runTurn = (async () => {
      llamadas += 1;
      if (llamadas === 1) throw new Error("se cayó el modelo");
    }) as Parameters<typeof sweepAbandonedInbound>[1];

    await sweepAbandonedInbound(new Date(), runTurn);

    expect(llamadas).toBe(2);
  });
});
