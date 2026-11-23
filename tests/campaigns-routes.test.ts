import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import cookieParser from "cookie-parser";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db/client";
import { auditRequests } from "../src/middleware/audit";
import { dashboardRouter } from "../src/routes/dashboard";
import { ensureClinicAdminRole } from "../src/repositories/roles.repository";
import { hashPassword, SESSION_COOKIE_NAME, signSession } from "../src/services/auth";
import { encryptToken } from "../src/services/crypto";
import { recordCampaignContact } from "../src/services/campaigns";
import { purgeAuditForClinics } from "./helpers/audit";

/**
 * Las rutas de campañas: permisos, validación, contactos y que quede en la auditoría sin el contenido de lo que
 * se escribió. Arma una app Express real con el router verdadero. Contra el Postgres local:
 * docker compose up -d db
 */

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const SECRETO = "PROMO-SECRETA-QUE-NO-DEBE-QUEDAR-EN-LA-AUDITORIA";
const clinicIds: string[] = [];
const userIds: string[] = [];
let server: Server;
let base = "";
let telefono = 5491100010000;

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

afterEach(async () => {
  await purgeAuditForClinics(clinicIds);
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  for (const clinicId of clinicIds) {
    await prisma.campaignLead.deleteMany({ where: { clinicId } });
    await prisma.campaign.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.service.deleteMany({ where: { clinicId } });
    await prisma.rolePermission.deleteMany({ where: { role: { clinicId } } });
    await prisma.role.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
  userIds.length = 0;
});

async function clinica() {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica rutas campañas ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `rc-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: "UTC",
      services: "x",
      professionals: { create: [{ name: "Gómez" }, { name: "Ruiz" }] },
    },
    include: { professionals: { orderBy: { name: "asc" } } },
  });
  clinicIds.push(clinic.id);
  const servicio = await prisma.service.create({
    data: { clinicId: clinic.id, name: "Blanqueamiento", durationMinutes: 60, professionals: { connect: [{ id: clinic.professionals[1].id }] } },
  });
  return { clinic, servicio, gomez: clinic.professionals[0], ruiz: clinic.professionals[1] };
}
type C = Awaited<ReturnType<typeof clinica>>;

/** Un usuario: admin de la clínica, o con un rol de solo los permisos que se pidan. */
async function usuario(c: C, permisos?: string[]) {
  let roleId: string;
  if (permisos) {
    const rol = await prisma.role.create({ data: { clinicId: c.clinic.id, name: `Rol ${Math.random()}`, permissions: { create: permisos.map((permissionId) => ({ permissionId })) } } });
    roleId = rol.id;
  } else {
    roleId = (await ensureClinicAdminRole(c.clinic.id)).id;
  }
  const user = await prisma.user.create({
    data: { clinicId: c.clinic.id, email: `rc-${Math.random().toString(36).slice(2)}@campanas.test`, name: "Ana", passwordHash: await hashPassword("x-x-x-x-x-x"), roles: { create: [{ roleId }] } },
  });
  userIds.push(user.id);
  return { user, cookie: `${SESSION_COOKIE_NAME}=${signSession({ userId: user.id, clinicId: c.clinic.id })}` };
}

async function http(path: string, init?: { method?: string; body?: unknown; cookie?: string }) {
  const res = await fetch(`${base}${path}`, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json", ...(init?.cookie ? { cookie: init.cookie } : {}) },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const url = (c: C, resto = "") => `/dashboard/clinics/${c.clinic.id}/campaigns${resto}`;
/** El cuerpo de una campaña válida: el servicio es obligatorio, así que por defecto lleva el de la clínica. */
const cuerpo = (c: C, extra: Record<string, unknown> = {}) => ({ name: "Blanqueamiento de verano", serviceId: c.servicio.id, triggers: [{ kind: "texto", value: "promo blanqueamiento" }], ...extra });

async function esperarAuditoria(where: Parameters<typeof prisma.auditLog.findFirst>[0] extends infer A ? NonNullable<A>["where"] : never) {
  for (let i = 0; i < 60; i++) {
    const fila = await prisma.auditLog.findFirst({ where, orderBy: { occurredAt: "desc" } });
    if (fila) return fila;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

describe("crear, listar y editar", () => {
  it("crea una campaña con su servicio, los profesionales que suma y sus formatos", async () => {
    const c = await clinica();
    const { cookie } = await usuario(c);
    const r = await http(url(c), {
      method: "POST", cookie,
      body: cuerpo(c, { channel: "Instagram", description: "20 %", serviceId: c.servicio.id, extraProfessionalIds: [c.gomez.id], startsOn: "2030-06-01", endsOn: "2030-06-30", followUpMaxAttempts: 3 }),
    });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: "Blanqueamiento de verano", channel: "Instagram", serviceId: c.servicio.id, followUpMaxAttempts: 3, active: true });
    expect(r.json.extraProfessionals.map((p: { id: string }) => p.id)).toEqual([c.gomez.id]);
    expect(r.json.triggers).toEqual([expect.objectContaining({ kind: "texto", value: "promo blanqueamiento" })]);
  });

  it("lista con el estado a hoy, las estadísticas y lo que necesita el formulario", async () => {
    const c = await clinica();
    const { cookie } = await usuario(c);
    await http(url(c), { method: "POST", cookie, body: cuerpo(c, { serviceId: c.servicio.id }) });
    await http(url(c), { method: "POST", cookie, body: cuerpo(c, { name: "Vieja", triggers: [{ kind: "texto", value: "frase vieja" }], endsOn: "2020-01-01" }) });
    await recordCampaignContact({ clinicId: c.clinic.id, phone: String(telefono++), text: "quiero la promo blanqueamiento" });

    const r = await http(url(c), { cookie });
    expect(r.status).toBe(200);
    const porNombre = Object.fromEntries(r.json.campanas.map((x: { name: string }) => [x.name, x]));
    expect(porNombre["Blanqueamiento de verano"]).toMatchObject({ estado: "vigente", estadisticas: { contacts: 1, newContacts: 1, converted: 0, open: 1 } });
    expect(porNombre["Vieja"]).toMatchObject({ estado: "vencida", estadisticas: { contacts: 0 } });
    expect(r.json.seguimientoHabilitado).toBe(false);
    expect(r.json.opciones.servicios).toEqual([{ id: c.servicio.id, name: "Blanqueamiento", profesionalIds: [c.ruiz.id] }]);
    expect(r.json.opciones.profesionales.map((p: { name: string }) => p.name)).toEqual(["Gómez", "Ruiz"]);
  });

  it("edita (también activar y desactivar) y una campaña de otra clínica no se puede tocar", async () => {
    const c = await clinica();
    const otra = await clinica();
    const { cookie } = await usuario(c);
    const { cookie: cookieOtra } = await usuario(otra);
    const creada = (await http(url(c), { method: "POST", cookie, body: cuerpo(c) })).json;

    expect((await http(url(c, `/${creada.id}`), { method: "PUT", cookie, body: { channel: "Radio" } })).json).toMatchObject({ channel: "Radio", name: "Blanqueamiento de verano" });
    expect((await http(url(c, `/${creada.id}`), { method: "PUT", cookie, body: { active: false } })).json.active).toBe(false);
    expect((await http(url(otra, `/${creada.id}`), { method: "PUT", cookie: cookieOtra, body: { name: "Robada" } })).status).toBe(404);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: creada.id } })).name).toBe("Blanqueamiento de verano");
  });

  it("valida: 400 con el motivo; nombre o formato repetido, 409", async () => {
    const c = await clinica();
    const { cookie } = await usuario(c);
    const sinProfesionales = await prisma.service.create({ data: { clinicId: c.clinic.id, name: "Sin profesionales", durationMinutes: 30 } });
    const malos: Array<[Record<string, unknown>, string]> = [
      [{ name: "" }, "nombre_requerido"],
      [{ startsOn: "2030-02-31" }, "fecha_invalida"],
      [{ serviceId: "no-existe" }, "servicio_no_encontrado"],
      [{ serviceId: null }, "servicio_requerido"],
      [{ serviceId: sinProfesionales.id }, "servicio_sin_profesional"],
      [{ triggers: [{ kind: "texto", value: "hola" }] }, "formato_invalido"],
      [{ followUpMaxAttempts: 9 }, "seguimiento_invalido"],
    ];
    for (const [extra, motivo] of malos) {
      const r = await http(url(c), { method: "POST", cookie, body: cuerpo(c, extra) });
      expect(r.status, motivo).toBe(400);
      expect(r.json.motivo).toBe(motivo);
    }
    expect((await http(url(c), { method: "POST", cookie, body: cuerpo(c) })).status).toBe(201);
    expect((await http(url(c), { method: "POST", cookie, body: cuerpo(c, { triggers: [{ kind: "texto", value: "otra frase" }] }) })).json.motivo).toBe("nombre_duplicado");
    const dup = await http(url(c), { method: "POST", cookie, body: cuerpo(c, { name: "Otra", triggers: [{ kind: "texto", value: "PROMO blanqueamiento" }] }) });
    expect(dup.status).toBe(409);
    expect(dup.json.motivo).toBe("formato_duplicado");
  });
});

describe("probar si un mensaje se reconocería", () => {
  const probar = (c: C, texto: string, cookie: string) => http(url(c, `/match?texto=${encodeURIComponent(texto)}`), { cookie });

  it("dice qué campaña se reconocería y por qué formato, con la misma regla que el webhook", async () => {
    const c = await clinica();
    const { cookie } = await usuario(c);
    const creada = (await http(url(c), { method: "POST", cookie, body: cuerpo(c, { triggers: [{ kind: "texto", value: "promoción en implantes" }] }) })).json;

    const si = await probar(c, "Hola, escribo por la PROMOCION en implantes dentales", cookie);
    expect(si.status).toBe(200);
    expect(si.json).toEqual({ reconocida: { id: creada.id, name: "Blanqueamiento de verano" }, formato: { kind: "texto", value: "promocion en implantes" } });

    expect((await probar(c, "hola, quiero un turno", cookie)).json).toEqual({ reconocida: null, formato: null });
  });

  it("no reconoce campañas desactivadas ni de otra clínica, y pide un mensaje", async () => {
    const c = await clinica();
    const otra = await clinica();
    const { cookie } = await usuario(c);
    const { cookie: cookieOtra } = await usuario(otra);
    const creada = (await http(url(c), { method: "POST", cookie, body: cuerpo(c) })).json;
    await http(url(c, `/${creada.id}`), { method: "PUT", cookie, body: { active: false } });

    expect((await probar(c, "promo blanqueamiento", cookie)).json.reconocida).toBeNull(); // desactivada
    expect((await probar(otra, "promo blanqueamiento", cookieOtra)).json.reconocida).toBeNull(); // es de otra clínica
    expect((await probar(c, "   ", cookie)).status).toBe(400);
  });

  it("pide `campanas.ver`, y no guarda ni audita el texto que se prueba", async () => {
    const c = await clinica();
    const { cookie: sin } = await usuario(c, ["turnos.ver"]);
    expect((await probar(c, "hola", sin)).status).toBe(403);

    const { cookie, user } = await usuario(c);
    await http(url(c), { method: "POST", cookie, body: cuerpo(c) });
    await probar(c, SECRETO, cookie);
    await new Promise((r) => setTimeout(r, 300));
    const filas = await prisma.auditLog.findMany({ where: { userId: user.id } });
    expect(filas.some((f) => f.route?.includes("/campaigns/match"))).toBe(false);
    expect(JSON.stringify(filas)).not.toContain("PROMO-SECRETA");
  });
});

describe("permisos", () => {
  it("con solo `campanas.ver` se lista pero no se crea ni se edita ni se cierra nada", async () => {
    const c = await clinica();
    const { cookie: admin } = await usuario(c);
    const { cookie: lector } = await usuario(c, ["campanas.ver"]);
    const creada = (await http(url(c), { method: "POST", cookie: admin, body: cuerpo(c) })).json;

    expect((await http(url(c), { cookie: lector })).status).toBe(200);
    expect((await http(url(c, "/leads"), { cookie: lector })).status).toBe(200);
    expect((await http(url(c), { method: "POST", cookie: lector, body: cuerpo(c, { name: "Otra", triggers: [{ kind: "texto", value: "otra frase" }] }) })).status).toBe(403);
    expect((await http(url(c, `/${creada.id}`), { method: "PUT", cookie: lector, body: { active: false } })).status).toBe(403);
    expect((await http(url(c, "/leads/x/close"), { method: "POST", cookie: lector, body: {} })).status).toBe(403);
  });

  it("sin ningún permiso de campañas, nada", async () => {
    const c = await clinica();
    const { cookie } = await usuario(c, ["turnos.ver"]);
    expect((await http(url(c), { cookie })).status).toBe(403);
    expect((await http(url(c, "/leads"), { cookie })).status).toBe(403);
  });

  it("el administrador de otra clínica no ve ni toca las campañas de esta", async () => {
    const c = await clinica();
    const otra = await clinica();
    const { cookie } = await usuario(otra);
    expect((await http(url(c), { cookie })).status).toBe(403);
    expect((await http(url(c), { method: "POST", cookie, body: cuerpo(c) })).status).toBe(403);
  });
});

describe("contactos y seguimiento", () => {
  it("lista los contactos con su estado, filtra por campaña y estado, y rechaza un estado inventado", async () => {
    const c = await clinica();
    const { cookie } = await usuario(c);
    const a = (await http(url(c), { method: "POST", cookie, body: cuerpo(c, { name: "A", triggers: [{ kind: "texto", value: "frase aaaa1" }] }) })).json;
    await http(url(c), { method: "POST", cookie, body: cuerpo(c, { name: "B", triggers: [{ kind: "texto", value: "frase bbbb1" }] }) });
    await recordCampaignContact({ clinicId: c.clinic.id, phone: "5491100010101", text: "frase aaaa1" });
    await recordCampaignContact({ clinicId: c.clinic.id, phone: "5491100010102", text: "frase bbbb1" });
    await prisma.campaignLead.updateMany({ where: { patientPhone: "5491100010102" }, data: { status: "convertido", convertedAt: new Date() } });

    expect((await http(url(c, "/leads"), { cookie })).json).toHaveLength(2);
    expect((await http(url(c, `/leads?campaignId=${a.id}`), { cookie })).json.map((l: { campaignName: string }) => l.campaignName)).toEqual(["A"]);
    expect((await http(url(c, "/leads?estado=convertido"), { cookie })).json.map((l: { campaignName: string }) => l.campaignName)).toEqual(["B"]);
    expect((await http(url(c, "/leads?estado=inventado"), { cookie })).status).toBe(400);
  });

  it("cerrar el seguimiento: una vez; uno cerrado, convertido o de otra clínica da 404", async () => {
    const c = await clinica();
    const otra = await clinica();
    const { cookie } = await usuario(c);
    const { cookie: cookieOtra } = await usuario(otra);
    await http(url(c), { method: "POST", cookie, body: cuerpo(c) });
    const lead = (await recordCampaignContact({ clinicId: c.clinic.id, phone: "5491100010201", text: "promo blanqueamiento" })).lead!;

    expect((await http(url(otra, `/leads/${lead.id}/close`), { method: "POST", cookie: cookieOtra, body: {} })).status).toBe(404);
    expect((await http(url(c, `/leads/${lead.id}/close`), { method: "POST", cookie, body: {} })).json).toEqual({ cerrado: true });
    expect(await prisma.campaignLead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ status: "cerrado", closedReason: "cerrado_por_la_clinica" });
    expect((await http(url(c, `/leads/${lead.id}/close`), { method: "POST", cookie, body: {} })).status).toBe(404);
  });
});

describe("la auditoría", () => {
  it("crear y editar quedan registrados con los nombres de los campos, nunca con lo que se escribió", async () => {
    const c = await clinica();
    const { cookie, user } = await usuario(c);
    const creada = (await http(url(c), { method: "POST", cookie, body: cuerpo(c, { description: SECRETO, triggers: [{ kind: "texto", value: SECRETO }] }) })).json;
    await http(url(c, `/${creada.id}`), { method: "PUT", cookie, body: { description: `${SECRETO} 2`, channel: "Radio" } });

    const alta = await esperarAuditoria({ userId: user.id, action: "campaign.create" });
    const edicion = await esperarAuditoria({ userId: user.id, action: "campaign.update" });
    expect(alta).toMatchObject({ outcome: "ok" });
    expect(([...((edicion?.details as { camposModificados: string[] }).camposModificados)]).sort()).toEqual(["channel", "description"]);
    for (const fila of [alta, edicion]) expect(JSON.stringify(fila)).not.toContain("PROMO-SECRETA");
  });

  it("ver los contactos (nombre y teléfono) queda como una lectura sensible", async () => {
    const c = await clinica();
    const { cookie, user } = await usuario(c);
    await http(url(c, "/leads"), { cookie });
    expect(await esperarAuditoria({ userId: user.id, route: "/dashboard/clinics/:clinicId/campaigns/leads" })).toMatchObject({ method: "GET", outcome: "ok" });
  });

  it("cerrar un contacto queda con su nombre de operación", async () => {
    const c = await clinica();
    const { cookie, user } = await usuario(c);
    await http(url(c), { method: "POST", cookie, body: cuerpo(c) });
    const lead = (await recordCampaignContact({ clinicId: c.clinic.id, phone: "5491100010301", text: "promo blanqueamiento" })).lead!;
    await http(url(c, `/leads/${lead.id}/close`), { method: "POST", cookie, body: {} });
    expect(await esperarAuditoria({ userId: user.id, action: "campaign.lead_close" })).toMatchObject({ outcome: "ok" });
  });
});
