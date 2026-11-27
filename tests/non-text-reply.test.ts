import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import {
  REPLY_COOLDOWN_MS,
  RESPUESTA_A_ARCHIVO,
  RESPUESTA_A_AUDIO,
  replyForNonTextType,
  replyToNonTextMessage,
} from "../src/services/non-text-reply";

/** Qué se le contesta a quien manda un audio, una imagen o un archivo (antes se lo dejaba en visto). */

const clinicIds: string[] = [];

async function crearClinica() {
  const c = await prisma.clinic.create({
    data: {
      name: `Clínica audio ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `na-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "t@x.test",
      timezone: "UTC",
      services: "x",
    },
  });
  clinicIds.push(c.id);
  return c;
}

afterEach(async () => {
  for (const id of clinicIds) {
    await prisma.conversationMessage.deleteMany({ where: { clinicId: id } });
    await prisma.clinic.delete({ where: { id } });
  }
  clinicIds.length = 0;
});

describe("replyForNonTextType", () => {
  it("contesta audios y archivos; no contesta reacciones, stickers ni lo desconocido", () => {
    expect(replyForNonTextType("audio")).toBe(RESPUESTA_A_AUDIO);
    for (const t of ["image", "video", "document"]) expect(replyForNonTextType(t)).toBe(RESPUESTA_A_ARCHIVO);
    for (const t of ["reaction", "sticker", "system", "unsupported", "text", undefined]) expect(replyForNonTextType(t)).toBeNull();
  });

  it("va de usted", () => {
    expect(RESPUESTA_A_AUDIO).toMatch(/podría|le ayudo/);
    expect(RESPUESTA_A_AUDIO).not.toMatch(/puedes|podés|escríbeme/i);
  });
});

describe("replyToNonTextMessage", () => {
  it("manda el aviso y lo deja en el historial como mensaje del asistente", async () => {
    const c = await crearClinica();
    const enviados: string[] = [];
    const ok = await replyToNonTextMessage({ clinicId: c.id, from: "5215511112222", type: "audio" }, { send: async (t) => void enviados.push(t) });
    expect(ok).toBe(true);
    expect(enviados).toEqual([RESPUESTA_A_AUDIO]);
    const historial = await prisma.conversationMessage.findMany({ where: { clinicId: c.id } });
    expect(historial.map((m) => [m.role, m.content])).toEqual([["assistant", RESPUESTA_A_AUDIO]]);
  });

  it("no lo repite si manda varios audios seguidos, pero sí pasado el tiempo", async () => {
    const c = await crearClinica();
    const enviados: string[] = [];
    const send = async (t: string) => void enviados.push(t);
    const args = { clinicId: c.id, from: "5215511112222", type: "audio" };
    expect(await replyToNonTextMessage(args, { send })).toBe(true);
    expect(await replyToNonTextMessage(args, { send })).toBe(false);
    expect(enviados).toHaveLength(1);
    const despues = new Date(Date.now() + REPLY_COOLDOWN_MS + 60_000);
    expect(await replyToNonTextMessage(args, { send, now: despues })).toBe(true);
    expect(enviados).toHaveLength(2);
  });

  it("otra persona (otro número) recibe el suyo", async () => {
    const c = await crearClinica();
    const enviados: string[] = [];
    const send = async (t: string) => void enviados.push(t);
    await replyToNonTextMessage({ clinicId: c.id, from: "5215511112222", type: "audio" }, { send });
    await replyToNonTextMessage({ clinicId: c.id, from: "5215533334444", type: "audio" }, { send });
    expect(enviados).toHaveLength(2);
  });

  it("no contesta una reacción ni un teléfono de prueba, y nunca lanza si el envío falla", async () => {
    const c = await crearClinica();
    const enviados: string[] = [];
    const send = async (t: string) => void enviados.push(t);
    expect(await replyToNonTextMessage({ clinicId: c.id, from: "5215511112222", type: "reaction" }, { send })).toBe(false);
    expect(await replyToNonTextMessage({ clinicId: c.id, from: "prueba:u1", type: "audio" }, { send })).toBe(false);
    expect(enviados).toHaveLength(0);
    const falla = await replyToNonTextMessage(
      { clinicId: c.id, from: "5215511112222", type: "audio" },
      { send: async () => { throw new Error("Meta caído"); } }
    );
    expect(falla).toBe(false);
  });
});
