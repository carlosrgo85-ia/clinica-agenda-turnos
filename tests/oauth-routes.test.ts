import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import cookieParser from "cookie-parser";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db/client";
import { ensureClinicAdminRole } from "../src/repositories/roles.repository";
import { hashPassword, SESSION_COOKIE_NAME, signSession } from "../src/services/auth";
import { encryptToken } from "../src/services/crypto";
import { buildOAuthState } from "../src/services/oauth-state";

// Ningún proveedor se llama de verdad: se simula el consentimiento y el canje del código.
const proveedor = vi.hoisted(() => ({
  configurado: { google: true, microsoft: true },
  consentUrl: vi.fn(),
  exchange: vi.fn(),
  sync: vi.fn(),
}));
vi.mock("../src/services/google-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/google-auth")>()),
  isOAuthConfigured: async () => proveedor.configurado.google,
  buildConsentUrl: async (clinicId: string, userId: string) => proveedor.consentUrl("google", clinicId, userId),
  exchangeCodeAndSaveAccount: async (p: unknown) => proveedor.exchange("google", p),
}));
vi.mock("../src/services/microsoft-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/microsoft-auth")>()),
  isMicrosoftOAuthConfigured: () => proveedor.configurado.microsoft,
  buildMicrosoftConsentUrl: (clinicId: string, userId: string) => proveedor.consentUrl("microsoft", clinicId, userId),
  exchangeCodeAndSaveMicrosoftAccount: async (p: unknown) => proveedor.exchange("microsoft", p),
}));
vi.mock("../src/jobs/calendar-sync", () => ({
  syncClinicBlocksNow: (...args: unknown[]) => proveedor.sync(...args),
}));

import { oauthRouter } from "../src/routes/oauth";

/**
 * Las rutas del OAuth de calendarios. Es SEGURIDAD: sin sesión y sin el permiso sobre la clínica,
 * cualquiera que conociera un id podía conectarle su propia cuenta y los turnos (paciente, servicio,
 * hora) se habrían espejado en un calendario ajeno. Arma una app Express real con el router verdadero y
 * le pega por HTTP, con la base real. Contra el Postgres local: docker compose up -d db
 */

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const clinicIds: string[] = [];
const userIds: string[] = [];
let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(cookieParser());
  app.use("/oauth", oauthRouter);
  await new Promise<void>((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  proveedor.configurado.google = true;
  proveedor.configurado.microsoft = true;
  proveedor.consentUrl.mockReset();
  proveedor.consentUrl.mockImplementation((p: string, clinicId: string) => `https://consentimiento.test/${p}?clinic=${clinicId}`);
  proveedor.exchange.mockReset();
  proveedor.exchange.mockResolvedValue({ email: "cuenta@clinica.test" });
  proveedor.sync.mockReset();
});

afterEach(async () => {
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  for (const clinicId of clinicIds) {
    await prisma.rolePermission.deleteMany({ where: { role: { clinicId } } });
    await prisma.role.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
  userIds.length = 0;
});

async function clinica() {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica oauth ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `oa-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: "UTC",
      services: "x",
    },
  });
  clinicIds.push(clinic.id);
  return clinic;
}

async function usuario(clinicId: string | null, opts?: { sinPermisos?: boolean }) {
  let roleId: string;
  if (clinicId === null) {
    const role = await prisma.role.findFirst({ where: { clinicId: null, name: "Super Admin" } });
    if (!role) throw new Error('Falta el rol "Super Admin": correr `npm run db:seed`.');
    roleId = role.id;
  } else if (opts?.sinPermisos) {
    roleId = (await prisma.role.create({ data: { clinicId, name: `Sin permisos ${Math.random()}` } })).id;
  } else {
    roleId = (await ensureClinicAdminRole(clinicId)).id;
  }
  const user = await prisma.user.create({
    data: {
      clinicId, email: `oa-${Math.random().toString(36).slice(2)}@oauth.test`, name: "Ana OAuth",
      passwordHash: await hashPassword("x-x-x-x-x-x"), roles: { create: [{ roleId }] },
    },
  });
  userIds.push(user.id);
  return { user, cookie: `${SESSION_COOKIE_NAME}=${signSession({ userId: user.id, clinicId })}` };
}

async function get(path: string, cookie?: string) {
  const res = await fetch(`${base}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe.each([
  { path: "google", kind: "google" as const, label: "Google" },
  { path: "microsoft", kind: "microsoft" as const, label: "Microsoft" },
])("el OAuth de $label: iniciar la conexión", ({ path, kind }) => {
  const start = (clinicId: string, cookie?: string) => get(`/oauth/${path}/start?clinicId=${clinicId}`, cookie);

  it("sin sesión: 401, y no se arma ninguna URL de consentimiento", async () => {
    const c = await clinica();
    expect((await start(c.id)).status).toBe(401);
    expect(proveedor.consentUrl).not.toHaveBeenCalled();
  });

  it("con permiso sobre la clínica: redirige al consentimiento del proveedor, con el usuario y la clínica", async () => {
    const c = await clinica();
    const { user, cookie } = await usuario(c.id);
    const r = await start(c.id, cookie);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`https://consentimiento.test/${kind}?clinic=${c.id}`);
    expect(proveedor.consentUrl).toHaveBeenCalledWith(kind, c.id, user.id);
  });

  it("la respuesta no se cachea ni se filtra por Referer (los links llevan code y state)", async () => {
    const c = await clinica();
    const { cookie } = await usuario(c.id);
    const r = await start(c.id, cookie);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("sin el permiso `calendarios.editar`: 403", async () => {
    const c = await clinica();
    const { cookie } = await usuario(c.id, { sinPermisos: true });
    expect((await start(c.id, cookie)).status).toBe(403);
    expect(proveedor.consentUrl).not.toHaveBeenCalled();
  });

  it("el administrador de OTRA clínica no puede conectar la de esta: 403", async () => {
    const a = await clinica();
    const b = await clinica();
    const { cookie } = await usuario(b.id);
    expect((await start(a.id, cookie)).status).toBe(403);
    expect(proveedor.consentUrl).not.toHaveBeenCalled();
  });

  it("la autorización va antes que la búsqueda: un id que no existe da 403 y no 404, para no revelar qué ids existen", async () => {
    const c = await clinica();
    const { cookie } = await usuario(c.id);
    expect((await start("clinica-que-no-existe", cookie)).status).toBe(403);
  });

  it("el super-admin puede conectar cualquier clínica, y si no existe, 404", async () => {
    const c = await clinica();
    const { cookie } = await usuario(null);
    expect((await start(c.id, cookie)).status).toBe(302);
    expect((await start("clinica-que-no-existe", cookie)).status).toBe(404);
  });

  it("sin clinicId: 400", async () => {
    const c = await clinica();
    const { cookie } = await usuario(c.id);
    expect((await get(`/oauth/${path}/start`, cookie)).status).toBe(400);
  });

  it("si el proveedor no está configurado en la plataforma: 503 con el motivo, sin redirigir", async () => {
    const c = await clinica();
    const { cookie } = await usuario(c.id);
    proveedor.configurado[kind] = false;
    const r = await start(c.id, cookie);
    expect(r.status).toBe(503);
    expect(r.text).toMatch(/no está configurado/);
    expect(proveedor.consentUrl).not.toHaveBeenCalled();
  });
});

describe.each([
  { path: "google", kind: "google" as const, label: "Google", otro: "microsoft" as const },
  { path: "microsoft", kind: "microsoft" as const, label: "Microsoft", otro: "google" as const },
])("el OAuth de $label: la vuelta (callback)", ({ path, kind, otro }) => {
  const callback = (query: string, cookie?: string) => get(`/oauth/${path}/callback?${query}`, cookie);
  const estado = (clinicId: string, userId: string, proveedorDelState = kind) => encodeURIComponent(buildOAuthState(proveedorDelState, clinicId, userId));

  it("sin sesión: 401, y no se canjea el código", async () => {
    const c = await clinica();
    const { user } = await usuario(c.id);
    expect((await callback(`code=abc&state=${estado(c.id, user.id)}`)).status).toBe(401);
    expect(proveedor.exchange).not.toHaveBeenCalled();
  });

  it("con el state de la misma sesión: canjea el código, conecta la cuenta e importa los bloqueos ya", async () => {
    const c = await clinica();
    const { user, cookie } = await usuario(c.id);
    const r = await callback(`code=el-codigo&state=${estado(c.id, user.id)}`, cookie);

    expect(r.status).toBe(200);
    expect(r.text).toContain("Cuenta conectada");
    expect(r.text).toContain("cuenta@clinica.test");
    expect(proveedor.exchange).toHaveBeenCalledWith(kind, { clinicId: c.id, code: "el-codigo" });
    expect(proveedor.sync).toHaveBeenCalledWith(c.id, expect.stringContaining(path === "google" ? "Google" : "Microsoft"));
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("el state de OTRO usuario no se puede completar desde esta sesión (login CSRF): 403", async () => {
    const c = await clinica();
    const { user: iniciador } = await usuario(c.id);
    const { cookie: otraSesion } = await usuario(c.id);
    const r = await callback(`code=abc&state=${estado(c.id, iniciador.id)}`, otraSesion);
    expect(r.status).toBe(403);
    expect(proveedor.exchange).not.toHaveBeenCalled();
    expect(proveedor.sync).not.toHaveBeenCalled();
  });

  it("si el usuario perdió el permiso en el medio del flujo: 403", async () => {
    const c = await clinica();
    const { user, cookie } = await usuario(c.id, { sinPermisos: true });
    const r = await callback(`code=abc&state=${estado(c.id, user.id)}`, cookie);
    expect(r.status).toBe(403);
    expect(proveedor.exchange).not.toHaveBeenCalled();
  });

  it("el state de una clínica que no es la del usuario: 403 (no se puede conectar una cuenta a una clínica ajena)", async () => {
    const a = await clinica();
    const b = await clinica();
    const { user, cookie } = await usuario(a.id);
    const r = await callback(`code=abc&state=${estado(b.id, user.id)}`, cookie);
    expect(r.status).toBe(403);
    expect(proveedor.exchange).not.toHaveBeenCalled();
  });

  it("un state emitido para el OTRO proveedor no sirve: 400", async () => {
    const c = await clinica();
    const { user, cookie } = await usuario(c.id);
    const r = await callback(`code=abc&state=${estado(c.id, user.id, otro)}`, cookie);
    expect(r.status).toBe(400);
    expect(r.text).toContain("venció");
    expect(proveedor.exchange).not.toHaveBeenCalled();
  });

  it("un state inventado o adulterado: 400", async () => {
    const c = await clinica();
    const { user, cookie } = await usuario(c.id);
    const bueno = decodeURIComponent(estado(c.id, user.id));
    for (const state of ["cualquier-cosa", "", `${bueno}x`, bueno.slice(0, -4)]) {
      const r = await callback(`code=abc&state=${encodeURIComponent(state)}`, cookie);
      expect(r.status, state).toBe(400);
    }
    expect(proveedor.exchange).not.toHaveBeenCalled();
  });

  it("sin code o sin state: 400", async () => {
    const c = await clinica();
    const { user, cookie } = await usuario(c.id);
    expect((await callback(`state=${estado(c.id, user.id)}`, cookie)).status).toBe(400);
    expect((await callback("code=abc", cookie)).status).toBe(400);
    expect((await callback("", cookie)).status).toBe(400);
  });

  it("si la persona apretó 'Cancelar' en el proveedor: 400 con el motivo, escapado (no se inyecta HTML)", async () => {
    const c = await clinica();
    const { cookie } = await usuario(c.id);
    const r = await callback(`error=${encodeURIComponent('<script>alert("x")</script>')}`, cookie);
    expect(r.status).toBe(400);
    expect(r.text).not.toContain("<script>");
    expect(r.text).toContain("&lt;script&gt;");
    expect(proveedor.exchange).not.toHaveBeenCalled();
  });

  it("si el canje falla: 500 con el motivo escapado, y no se importan bloqueos", async () => {
    const c = await clinica();
    const { user, cookie } = await usuario(c.id);
    proveedor.exchange.mockRejectedValue(new Error('invalid_grant <img src=x onerror="alert(1)">'));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const r = await callback(`code=abc&state=${estado(c.id, user.id)}`, cookie);
      expect(r.status).toBe(500);
      expect(r.text).toContain("invalid_grant");
      expect(r.text).not.toContain("<img");
    } finally {
      log.mockRestore();
    }
    expect(proveedor.sync).not.toHaveBeenCalled();
  });

  it("el email de la cuenta conectada se escapa en la página", async () => {
    const c = await clinica();
    const { user, cookie } = await usuario(c.id);
    proveedor.exchange.mockResolvedValue({ email: '<b onmouseover="x">a@b.test</b>' });
    const r = await callback(`code=abc&state=${estado(c.id, user.id)}`, cookie);
    expect(r.text).not.toContain("<b onmouseover");
    expect(r.text).toContain("&lt;b");
  });
});
