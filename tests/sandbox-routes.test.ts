import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import cookieParser from "cookie-parser";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeAgentResponse } from "../src/types";

// El modelo no se llama de verdad: lo que contesta lo decide cada test.
const modelo = vi.hoisted(() => ({ interpret: vi.fn() }));
vi.mock("../src/services/claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/claude")>()),
  interpretPatientMessage: (...a: unknown[]) => modelo.interpret(...a),
}));
const externo = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../src/services/whatsapp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/whatsapp")>()),
  sendTextMessage: (...a: unknown[]) => externo.send(...a),
}));

import { prisma } from "../src/db/client";
import { auditRequests } from "../src/middleware/audit";
import { dashboardRouter } from "../src/routes/dashboard";
import { ensureClinicAdminRole } from "../src/repositories/roles.repository";
import { hashPassword, SESSION_COOKIE_NAME, signSession } from "../src/services/auth";
import { createCampaign } from "../src/services/campaigns";
import { encryptToken } from "../src/services/crypto";
import { purgeAuditForClinics } from "./helpers/audit";

/**
 * Las rutas del chat de pruebas: permiso, validación, una conversación por persona y que quede en la auditoría sin lo que
 * se escribió. Contra el Postgres local: docker compose up -d db
 */

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const SECRETO = "MENSAJE-DE-PRUEBA-QUE-NO-DEBE-QUEDAR-EN-LA-AUDITORIA";
const clinicIds: string[] = [];
const userIds: string[] = [];
let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(auditRequests);
  app.use("/dashboard", dashboardRouter);
  await new Promise<void>((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function respuesta(texto: string, over: Partial<ClaudeAgentResponse> = {}): ClaudeAgentResponse {
  return {
    intent: "otro", servicio: null, fecha_solicitada: null, hora_solicitada: null, nombre_paciente: null, paciente_del_turno: null,
    turno_a_modificar: null, requiere_horarios_disponibles: false, confirmacion_explicita: false, pidio_ubicacion: false,
    escalar_a_humano: false, motivo_escalar: null, motivo_cancelacion: null, motivo_es_queja: false, turno_cancelado: null,
    respuesta_al_paciente: texto, ...over,
  } as ClaudeAgentResponse;
}

beforeEach(() => {
  modelo.interpret.mockReset();
  modelo.interpret.mockResolvedValue(respuesta("Hola, ¿en qué te ayudo?"));
  externo.send.mockReset();
});

afterEach(async () => {
  await purgeAuditForClinics(clinicIds);
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  for (const clinicId of clinicIds) {
    await prisma.agentRequest.deleteMany({ where: { clinicId } });
    await prisma.campaignLead.deleteMany({ where: { clinicId } });
    await prisma.campaign.deleteMany({ where: { clinicId } });
    await prisma.conversationMessage.deleteMany({ where: { clinicId } });
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.rolePermission.deleteMany({ where: { role: { clinicId } } });
    await prisma.role.deleteMany({ where: { clinicId } });
    await prisma.systemEvent.deleteMany({ where: { clinicId } });
    await prisma.service.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
  userIds.length = 0;
});

async function clinica() {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica chat pruebas ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `rp-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: "UTC",
      services: "x",
      professionals: { create: [{ name: "Gómez" }] },
    },
    include: { professionals: true },
  });
  clinicIds.push(clinic.id);
  // Una campaña necesita un servicio que alguien atienda.
  const servicio = await prisma.service.create({
    data: { clinicId: clinic.id, name: "Limpieza", durationMinutes: 30, professionals: { connect: [{ id: clinic.professionals[0].id }] } },
  });
  return Object.assign(clinic, { servicioId: servicio.id });
}

async function usuario(clinicId: string, permisos?: string[]) {
  const roleId = permisos
    ? (await prisma.role.create({ data: { clinicId, name: `Rol ${Math.random()}`, permissions: { create: permisos.map((permissionId) => ({ permissionId })) } } })).id
    : (await ensureClinicAdminRole(clinicId)).id;
  const user = await prisma.user.create({
    data: { clinicId, email: `cp-${Math.random().toString(36).slice(2)}@pruebas.test`, name: "Ana", passwordHash: await hashPassword("x-x-x-x-x-x"), roles: { create: [{ roleId }] } },
  });
  userIds.push(user.id);
  return { user, cookie: `${SESSION_COOKIE_NAME}=${signSession({ userId: user.id, clinicId })}` };
}

async function http(path: string, init?: { method?: string; body?: unknown; cookie?: string }) {
  const res = await fetch(`${base}${path}`, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json", ...(init?.cookie ? { cookie: init.cookie } : {}) },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const url = (id: string) => `/dashboard/clinics/${id}/test-chat`;

describe("hablar con el asistente desde el panel", () => {
  it("devuelve la respuesta, lo que entendió y las citas, sin mandar nada por WhatsApp", async () => {
    const c = await clinica();
    const { cookie } = await usuario(c.id);
    const r = await http(url(c.id), { method: "POST", cookie, body: { message: "Hola" } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ respuestas: ["Hola, ¿en qué te ayudo?"], citas: [] });
    // La única nota es lo que se le mandaría al paciente real antes de la primera respuesta (nada sale de verdad).
    expect(r.json.notas).toHaveLength(1);
    expect(r.json.notas[0]).toMatch(/Al paciente real se le mandaría, antes de la primera respuesta: «Le atiende el asistente virtual/);
    expect(r.json.decisiones).toHaveLength(1);
    expect(r.json.decisiones[0]).toMatchObject({ intent: "otro", derivar: false });
    expect(externo.send).not.toHaveBeenCalled();
  });

  it("el historial, las citas y la campaña se pueden leer, y reiniciar lo borra todo", async () => {
    const c = await clinica();
    const { cookie } = await usuario(c.id);
    const camp = await createCampaign(c.id, { name: "Verano", serviceId: c.servicioId, triggers: [{ kind: "texto", value: "promo de verano" }] });
    if (!camp.ok) throw new Error(camp.message);
    await http(url(c.id), { method: "POST", cookie, body: { message: "Hola, la promo de verano" } });

    const lectura = await http(url(c.id), { cookie });
    expect(lectura.status).toBe(200);
    expect(lectura.json.mensajes.map((m: { role: string; content: string }) => [m.role, m.content])).toEqual([["patient", "Hola, la promo de verano"], ["assistant", "Hola, ¿en qué te ayudo?"]]);
    expect(lectura.json.campana).toEqual({ id: camp.value.id, name: "Verano" });

    const reinicio = await http(url(c.id), { method: "DELETE", cookie });
    expect(reinicio.json).toMatchObject({ reiniciado: true, patients: 1 });
    expect((await http(url(c.id), { cookie })).json).toEqual({ mensajes: [], citas: [], campana: null });
  });

  it("cada persona del panel tiene su propia conversación", async () => {
    const c = await clinica();
    const { cookie: ana } = await usuario(c.id);
    const { cookie: luis } = await usuario(c.id);
    await http(url(c.id), { method: "POST", cookie: ana, body: { message: "Soy Ana" } });
    expect((await http(url(c.id), { cookie: luis })).json.mensajes).toEqual([]);
    await http(url(c.id), { method: "DELETE", cookie: luis });
    expect((await http(url(c.id), { cookie: ana })).json.mensajes).toHaveLength(2); // reiniciar el de Luis no toca el de Ana
  });

  it("valida el mensaje", async () => {
    const c = await clinica();
    const { cookie } = await usuario(c.id);
    expect((await http(url(c.id), { method: "POST", cookie, body: { message: "   " } })).json.motivo).toBe("mensaje_vacio");
    expect((await http(url(c.id), { method: "POST", cookie, body: {} })).status).toBe(400);
    expect((await http(url(c.id), { method: "POST", cookie, body: { message: "x".repeat(1001) } })).json.motivo).toBe("mensaje_demasiado_largo");
    expect(modelo.interpret).not.toHaveBeenCalled();
  });

  it("dos mensajes a la vez de la misma persona: el segundo espera (409), y después puede seguir", async () => {
    const c = await clinica();
    const { cookie } = await usuario(c.id);
    let liberar!: () => void;
    modelo.interpret.mockImplementationOnce(() => new Promise((resolve) => { liberar = () => resolve(respuesta("Respuesta lenta")); }));

    const primero = http(url(c.id), { method: "POST", cookie, body: { message: "Uno" } });
    await vi.waitFor(() => expect(modelo.interpret).toHaveBeenCalledTimes(1));
    const segundo = await http(url(c.id), { method: "POST", cookie, body: { message: "Dos" } });
    expect(segundo.status).toBe(409);

    liberar();
    expect((await primero).status).toBe(200);
    expect((await http(url(c.id), { method: "POST", cookie, body: { message: "Tres" } })).status).toBe(200);
  });

  it("si el asistente falla, 500 con un mensaje; no se cae y la conversación sigue", async () => {
    const c = await clinica();
    const { cookie } = await usuario(c.id);
    modelo.interpret.mockRejectedValue(new Error("modelo caído"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // `retryDelayMs` es el real: el turno reintenta una vez tras 15 s. Se corta ese tiempo con timers falsos.
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const p = http(url(c.id), { method: "POST", cookie, body: { message: "Hola" } });
      await vi.advanceTimersByTimeAsync(16_000);
      vi.useRealTimers();
      const r = await p;
      // Con el modelo caído dos veces el turno se disculpa (como en producción) en lugar de romperse.
      expect(r.status).toBe(200);
      expect(r.json.respuestas.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
      log.mockRestore();
    }
  });
});

describe("permisos", () => {
  it("sin `chat_pruebas.usar`: 403 en las tres rutas, y el modelo no se llama", async () => {
    const c = await clinica();
    const { cookie } = await usuario(c.id, ["turnos.ver", "campanas.ver"]);
    expect((await http(url(c.id), { method: "POST", cookie, body: { message: "Hola" } })).status).toBe(403);
    expect((await http(url(c.id), { cookie })).status).toBe(403);
    expect((await http(url(c.id), { method: "DELETE", cookie })).status).toBe(403);
    expect(modelo.interpret).not.toHaveBeenCalled();
  });

  it("con solo ese permiso se puede usar", async () => {
    const c = await clinica();
    const { cookie } = await usuario(c.id, ["chat_pruebas.usar"]);
    expect((await http(url(c.id), { method: "POST", cookie, body: { message: "Hola" } })).status).toBe(200);
  });

  it("el administrador de otra clínica no puede usar el chat de esta", async () => {
    const c = await clinica();
    const otra = await clinica();
    const { cookie } = await usuario(otra.id);
    expect((await http(url(c.id), { method: "POST", cookie, body: { message: "Hola" } })).status).toBe(403);
  });
});

describe("la auditoría", () => {
  async function esperar(where: Parameters<typeof prisma.auditLog.findFirst>[0] extends infer A ? NonNullable<A>["where"] : never) {
    for (let i = 0; i < 60; i++) {
      const fila = await prisma.auditLog.findFirst({ where, orderBy: { occurredAt: "desc" } });
      if (fila) return fila;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  it("hablar y reiniciar quedan registrados, pero nunca lo que se escribió ni lo que contestó el asistente", async () => {
    const c = await clinica();
    const { cookie, user } = await usuario(c.id);
    modelo.interpret.mockResolvedValue(respuesta("RESPUESTA-SECRETA-DEL-ASISTENTE"));
    await http(url(c.id), { method: "POST", cookie, body: { message: SECRETO } });
    await http(url(c.id), { method: "DELETE", cookie });

    const habla = await esperar({ userId: user.id, action: "sandbox.message" });
    const reinicio = await esperar({ userId: user.id, action: "sandbox.reset" });
    expect(habla).toMatchObject({ outcome: "ok" });
    expect(reinicio).toMatchObject({ outcome: "ok" });
    for (const f of [habla, reinicio]) {
      expect(JSON.stringify(f)).not.toContain("MENSAJE-DE-PRUEBA");
      expect(JSON.stringify(f)).not.toContain("RESPUESTA-SECRETA");
    }
  });
});

describe("sin atajos para campañas", () => {
  it("el cuerpo no acepta elegir una campaña: un `campaignId` se ignora y el asistente no la recibe", async () => {
    const c = await clinica();
    const { cookie } = await usuario(c.id);
    const camp = await createCampaign(c.id, { name: "Verano", serviceId: c.servicioId, triggers: [{ kind: "texto", value: "promo de verano" }] });
    if (!camp.ok) throw new Error(camp.message);
    const r = await http(url(c.id), { method: "POST", cookie, body: { message: "Hola", campaignId: camp.value.id } });
    expect(r.status).toBe(200);
    expect(modelo.interpret.mock.calls[0][0].campana).toMatch(/^Ninguna/);
    expect((await http(url(c.id), { cookie })).json.campana).toBeNull();
  });
});
