import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import {
  DEBOUNCE_MS,
  MAX_WAIT_MS,
  claimConversationBatch,
  enqueueInboundMessage,
  joinBatch,
  reclaimRequeuedMessage,
  requeueMessageForRetry,
} from "../src/services/inbound-queue";

/**
 * El agrupado de mensajes que llegan seguidos.
 *
 * La regla es "me lo llevo solo si soy el último": cada intento pasa el
 * `receivedAt` del mensaje que lo disparó y se abstiene si llegó algo
 * después. Va contra la base de verdad porque la decisión la toma una
 * sentencia SQL, no el código — un mock no probaría nada.
 */

const TELEFONO = "5491100000001";
const clinicIds: string[] = [];

async function crearClinica(): Promise<string> {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica cola ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `cola-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "cola@example.com",
      timezone: "UTC",
      services: "Consulta",
    },
  });
  clinicIds.push(clinic.id);
  return clinic.id;
}

/** Un mensaje que llegó hace `haceMs`. Devuelve su `receivedAt`. */
async function encolarHace(
  clinicId: string,
  haceMs: number,
  text: string,
  phone = TELEFONO
): Promise<Date> {
  const fila = await prisma.pendingInboundMessage.create({
    data: {
      clinicId,
      patientPhone: phone,
      text,
      receivedAt: new Date(Date.now() - haceMs),
    },
  });
  return fila.receivedAt;
}

function quedanPendientes(clinicId: string): Promise<number> {
  return prisma.pendingInboundMessage.count({ where: { clinicId } });
}

afterEach(async () => {
  for (const clinicId of clinicIds) {
    await prisma.pendingInboundMessage.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

describe("claimConversationBatch", () => {
  it("se lleva el mensaje cuando no llegó ninguno después", async () => {
    const clinicId = await crearClinica();
    const mio = await encolarHace(clinicId, DEBOUNCE_MS + 1000, "Hola");

    const batch = await claimConversationBatch({
      clinicId,
      patientPhone: TELEFONO,
      notNewerThan: mio,
    });

    expect(batch.map((m) => m.text)).toEqual(["Hola"]);
    expect(await quedanPendientes(clinicId)).toBe(0);
  });

  /**
   * Regresión del 2026-09-14: un "hola" suelto quedó encolado sin respuesta.
   *
   * La versión anterior comparaba contra `ahora - DEBOUNCE_MS` calculado en
   * Node, mientras que `receivedAt` lo pone Postgres. Como el intento
   * despierta justo `DEBOUNCE_MS` después de encolar, los dos valores caían a
   * menos de un milisegundo y el mensaje se veía a sí mismo como más nuevo
   * que el corte: se abstenía, y nadie más iba a despertar. Salía o no según
   * la imprecisión del `setTimeout`.
   *
   * Por eso el intento se prueba con el `receivedAt` real que devolvió la
   * base y sin ningún margen: un mensaje nunca puede bloquearse a sí mismo.
   */
  it("un mensaje solo nunca se bloquea a sí mismo, sin importar el reloj", async () => {
    const clinicId = await crearClinica();
    const encolado = await enqueueInboundMessage({
      clinicId,
      patientPhone: TELEFONO,
      text: "hola",
    });

    const batch = await claimConversationBatch({
      clinicId,
      patientPhone: TELEFONO,
      notNewerThan: encolado.receivedAt,
      // El peor caso: el intento despierta en el instante exacto del mensaje.
      now: encolado.receivedAt,
    });

    expect(batch.map((m) => m.text)).toEqual(["hola"]);
  });

  it("no se lleva nada si el paciente siguió escribiendo", async () => {
    const clinicId = await crearClinica();
    const primero = await encolarHace(clinicId, DEBOUNCE_MS + 1000, "Agendar la cita");
    await encolarHace(clinicId, 500, "Para mañana");

    // Despierta el intento del PRIMER mensaje: llegó uno después, se abstiene.
    const batch = await claimConversationBatch({
      clinicId,
      patientPhone: TELEFONO,
      notNewerThan: primero,
    });

    expect(batch).toEqual([]);
    expect(await quedanPendientes(clinicId)).toBe(2);
  });

  it("junta los mensajes partidos en un solo lote, en orden", async () => {
    const clinicId = await crearClinica();
    await encolarHace(clinicId, DEBOUNCE_MS + 2000, "Agendar la cita");
    const ultimo = await encolarHace(clinicId, DEBOUNCE_MS + 1000, "Para mañana");

    // Despierta el intento del ÚLTIMO: se los lleva todos.
    const batch = await claimConversationBatch({
      clinicId,
      patientPhone: TELEFONO,
      notNewerThan: ultimo,
    });

    expect(batch.map((m) => m.text)).toEqual(["Agendar la cita", "Para mañana"]);
    expect(joinBatch(batch)).toBe("Agendar la cita\nPara mañana");
  });

  it("contesta igual a quien escribe sin parar, al llegar al tope", async () => {
    const clinicId = await crearClinica();
    const primero = await encolarHace(clinicId, MAX_WAIT_MS + 1000, "Uno");
    await encolarHace(clinicId, 200, "Dos");

    // El intento del primero se abstendría por el mensaje nuevo, pero el más
    // viejo ya pasó el tope: se contesta igual.
    const batch = await claimConversationBatch({
      clinicId,
      patientPhone: TELEFONO,
      notNewerThan: primero,
    });

    expect(batch.map((m) => m.text)).toEqual(["Uno", "Dos"]);
    expect(await quedanPendientes(clinicId)).toBe(0);
  });

  it("no mezcla dos conversaciones de la misma clínica", async () => {
    const clinicId = await crearClinica();
    const deAna = await encolarHace(clinicId, DEBOUNCE_MS + 1000, "De Ana", "5491100000002");
    await encolarHace(clinicId, DEBOUNCE_MS + 1000, "De Beto", "5491100000003");

    const batch = await claimConversationBatch({
      clinicId,
      patientPhone: "5491100000002",
      notNewerThan: deAna,
    });

    expect(batch.map((m) => m.text)).toEqual(["De Ana"]);
    expect(await quedanPendientes(clinicId)).toBe(1);
  });

  it("no mezcla el mismo teléfono en dos clínicas", async () => {
    const clinicaA = await crearClinica();
    const clinicaB = await crearClinica();
    const paraA = await encolarHace(clinicaA, DEBOUNCE_MS + 1000, "Para la A");
    await encolarHace(clinicaB, DEBOUNCE_MS + 1000, "Para la B");

    const batch = await claimConversationBatch({
      clinicId: clinicaA,
      patientPhone: TELEFONO,
      notNewerThan: paraA,
    });

    expect(batch.map((m) => m.text)).toEqual(["Para la A"]);
    expect(await quedanPendientes(clinicaB)).toBe(1);
  });

  it("no devuelve nada si no hay pendientes", async () => {
    const clinicId = await crearClinica();

    const batch = await claimConversationBatch({
      clinicId,
      patientPhone: TELEFONO,
      notNewerThan: new Date(),
    });

    expect(batch).toEqual([]);
  });

  /**
   * La garantía que hace que esto sirva con N instancias del webhook: dos
   * procesos que intentan a la vez no pueden contestar los dos. El
   * `DELETE ... RETURNING` decide y borra en una sola sentencia, así que uno
   * se lleva las filas y el otro encuentra cero.
   */
  it("con dos intentos simultáneos, solo uno se lleva el lote", async () => {
    const clinicId = await crearClinica();
    await encolarHace(clinicId, DEBOUNCE_MS + 1000, "Hola");
    const ultimo = await encolarHace(clinicId, DEBOUNCE_MS + 500, "¿Estás?");

    const [uno, otro] = await Promise.all([
      claimConversationBatch({ clinicId, patientPhone: TELEFONO, notNewerThan: ultimo }),
      claimConversationBatch({ clinicId, patientPhone: TELEFONO, notNewerThan: ultimo }),
    ]);

    const tamaños = [uno.length, otro.length].sort();
    expect(tamaños).toEqual([0, 2]);
    expect(await quedanPendientes(clinicId)).toBe(0);
  });
});

describe("enqueueInboundMessage", () => {
  it("deja el mensaje pendiente y devuelve la hora que le puso la base", async () => {
    const clinicId = await crearClinica();

    const encolado = await enqueueInboundMessage({
      clinicId,
      patientPhone: TELEFONO,
      text: "Hola",
    });

    expect(encolado.text).toBe("Hola");
    expect(encolado.receivedAt).toBeInstanceOf(Date);
    expect(await quedanPendientes(clinicId)).toBe(1);

    const fila = await prisma.pendingInboundMessage.findFirstOrThrow({ where: { clinicId } });
    // Es la hora real de la fila: con eso el webhook decide si le toca.
    expect(encolado.receivedAt.getTime()).toBe(fila.receivedAt.getTime());
  });
});

describe("el respaldo del reintento", () => {
  it("deja el mensaje otra vez en la cola, y quien lo reclama se queda con él una sola vez", async () => {
    const clinicId = await crearClinica();
    const id = await requeueMessageForRetry({ clinicId, patientPhone: TELEFONO, text: "Quiero un turno" });
    expect(await quedanPendientes(clinicId)).toBe(1);

    expect(await reclaimRequeuedMessage(id)).toBe(true);
    expect(await quedanPendientes(clinicId)).toBe(0);
    // Ya no está: el que llegue después (el barrido) no lo procesa de nuevo.
    expect(await reclaimRequeuedMessage(id)).toBe(false);
  });

  it("si otro turno lo juntó en su lote, el original no lo puede reclamar", async () => {
    const clinicId = await crearClinica();
    const id = await requeueMessageForRetry({ clinicId, patientPhone: TELEFONO, text: "Quiero un turno" });
    const nuevo = await encolarHace(clinicId, 0, "Para mañana");

    const lote = await claimConversationBatch({ clinicId, patientPhone: TELEFONO, notNewerThan: nuevo });
    expect(lote.map((m) => m.text).sort()).toEqual(["Para mañana", "Quiero un turno"]);
    expect(await reclaimRequeuedMessage(id)).toBe(false);
  });

  it("si el proceso murió, el barrido lo rescata como a cualquier lote abandonado", async () => {
    const clinicId = await crearClinica();
    const id = await requeueMessageForRetry({ clinicId, patientPhone: TELEFONO, text: "Quiero un turno" });
    // Pasaron más de 2 minutos y nadie lo reclamó.
    await prisma.pendingInboundMessage.update({ where: { id }, data: { receivedAt: new Date(Date.now() - 3 * 60_000) } });
    const lote = await claimConversationBatch({ clinicId, patientPhone: TELEFONO, notNewerThan: new Date(Date.now() - 2 * 60_000) });
    expect(lote.map((m) => m.text)).toEqual(["Quiero un turno"]);
  });
});

describe("joinBatch", () => {
  it("separa los mensajes por línea, para que se lean como mensajes distintos", () => {
    const batch = [
      { text: "Agendar la cita", receivedAt: new Date() },
      { text: "Para mañana", receivedAt: new Date() },
    ];

    expect(joinBatch(batch)).toBe("Agendar la cita\nPara mañana");
  });
});
