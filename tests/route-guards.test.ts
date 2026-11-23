import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import cookieParser from "cookie-parser";
import express, { Router, type Router as RouterType } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db/client";
import { dashboardRouter } from "../src/routes/dashboard";
import { platformRouter } from "../src/routes/platform";
import { rolesRouter } from "../src/routes/roles";
import { usersRouter } from "../src/routes/users";
import { ensureClinicAdminRole } from "../src/repositories/roles.repository";
import { requirePermission } from "../src/middleware/authorize";
import { hashPassword, SESSION_COOKIE_NAME, signSession } from "../src/services/auth";
import { encryptToken } from "../src/services/crypto";

/**
 * Las puertas de la API: que ninguna ruta quede abierta sin sesión, sin el permiso o sin ser
 * super-admin. Con cientos de rutas, "acordarse de ponerle `requirePermission`" no escala: este test
 * RECORRE todas las rutas de cada router (sin llamar a mano a ninguna), así una ruta nueva sin
 * puerta hace fallar la suite en vez de salir a producción abierta.
 *
 * Dos comprobaciones: **estática** (cada ruta lleva la puerta que le corresponde) y **de
 * comportamiento** (pegarle por HTTP sin sesión, con la sesión equivocada y desde otra clínica).
 * Contra el Postgres local: docker compose up -d db
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 20_000 });

interface Ruta {
  metodo: string;
  path: string;
  /** Los nombres de los manejadores de la ruta, en orden: `requirePermission:<permiso>`, etc. */
  manejadores: string[];
}

/** Todas las rutas que declara un router de Express, con los nombres de sus manejadores. */
function rutasDe(router: RouterType): Ruta[] {
  const capas = (router as unknown as { stack: Array<{ route?: { path: unknown; methods: Record<string, boolean>; stack: Array<{ name: string }> } }> }).stack;
  const rutas: Ruta[] = [];
  for (const capa of capas) {
    if (!capa.route) continue;
    if (typeof capa.route.path !== "string") throw new Error(`Ruta con un path que no es texto: ${String(capa.route.path)}`);
    for (const metodo of Object.keys(capa.route.methods)) {
      rutas.push({ metodo: metodo.toUpperCase(), path: capa.route.path, manejadores: capa.route.stack.map((s) => s.name) });
    }
  }
  return rutas;
}

/** Los nombres de las capas de un router, en orden (los `use` y las rutas). */
const capasDe = (router: RouterType): string[] =>
  (router as unknown as { stack: Array<{ name: string; route?: unknown }> }).stack.map((c) => (c.route ? "<ruta>" : c.name));

const clinicaDe = (r: Ruta) => r.path.includes(":clinicId");
const nombre = (r: Ruta) => `${r.metodo} ${r.path}`;
/** Reemplaza los parámetros de la ruta por valores que no existen. */
const urlDe = (r: Ruta, clinicId = "clinica-que-no-existe") => r.path.replace(":clinicId", clinicId).replace(/:[A-Za-z]+/g, "x");

const ROUTERS_DE_CLINICA: Array<{ nombre: string; router: RouterType; montaje: string }> = [
  { nombre: "dashboard", router: dashboardRouter, montaje: "/dashboard" },
  { nombre: "usuarios", router: usersRouter, montaje: "/dashboard" },
  { nombre: "roles", router: rolesRouter, montaje: "/dashboard" },
];

/**
 * Rutas que a propósito NO piden un permiso concreto. Hoy ninguna: todo lo de una clínica pide uno. Sumar
 * una acá es una decisión que se revisa, no un olvido.
 */
const SIN_PERMISO_A_PROPOSITO: string[] = [];

/**
 * Rutas de plataforma que no llevan un permiso propio además de ser solo del super-admin. Va todo lo
 * demás con `requirePermission`; estas son las excepciones, con su motivo.
 */
const PLATAFORMA_SIN_PERMISO_PROPIO: Record<string, string> = {
  "POST /google-business/preview": "Es una consulta a Places para prellenar un formulario; la puerta es ser super-admin.",
};

describe("puertas estáticas: cada ruta lleva la que le corresponde", () => {
  it("el recorrido de verdad detecta una ruta sin puerta (si no, los demás tests no probarían nada)", () => {
    const router = Router();
    router.get("/clinics/:clinicId/abierta", (_req, res) => res.json({}));
    router.get("/clinics/:clinicId/cerrada", requirePermission("pacientes.ver"), (_req, res) => res.json({}));
    const rutas = rutasDe(router);
    expect(rutas.map(nombre)).toEqual(["GET /clinics/:clinicId/abierta", "GET /clinics/:clinicId/cerrada"]);
    expect(rutas.filter((r) => !r.manejadores.some((m) => m.startsWith("requirePermission:"))).map(nombre)).toEqual(["GET /clinics/:clinicId/abierta"]);
    expect(rutas[1].manejadores[0]).toBe("requirePermission:pacientes.ver");
  });

  it.each(ROUTERS_DE_CLINICA)("el router de $nombre empieza exigiendo sesión", ({ router }) => {
    expect(capasDe(router)[0]).toBe("authenticate");
  });

  it.each(ROUTERS_DE_CLINICA)("toda ruta del router de $nombre exige un permiso y es de una clínica", ({ router }) => {
    const rutas = rutasDe(router);
    expect(rutas.length).toBeGreaterThan(0);
    const sinPermiso = rutas.filter((r) => !r.manejadores.some((m) => m.startsWith("requirePermission:"))).map(nombre);
    expect(sinPermiso.filter((n) => !SIN_PERMISO_A_PROPOSITO.includes(n)), "rutas sin requirePermission").toEqual([]);
    // Sin `:clinicId` en la ruta, `requirePermission` no puede comprobar que el usuario sea de esa clínica.
    expect(rutas.filter((r) => !clinicaDe(r)).map(nombre), "rutas que no son de una clínica").toEqual([]);
  });

  it("el router de plataforma exige sesión y ser super-admin ANTES de cualquier ruta", () => {
    const capas = capasDe(platformRouter);
    expect(capas.slice(0, 2)).toEqual(["authenticate", "requireSuperAdmin"]);
    expect(capas.slice(2).includes("authenticate")).toBe(false);
  });

  it("toda ruta de plataforma exige un permiso, salvo las excepciones listadas", () => {
    const rutas = rutasDe(platformRouter);
    expect(rutas.length).toBeGreaterThan(30);
    const sinPermiso = rutas.filter((r) => !r.manejadores.some((m) => m.startsWith("requirePermission:"))).map(nombre);
    expect(sinPermiso.sort()).toEqual(Object.keys(PLATAFORMA_SIN_PERMISO_PROPIO).sort());
  });
});

describe("puertas de comportamiento: pegarle a todas las rutas por HTTP", () => {
  const clinicIds: string[] = [];
  const userIds: string[] = [];
  let server: Server;
  let base = "";

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    for (const { router, montaje } of ROUTERS_DE_CLINICA) app.use(montaje, router);
    app.use("/platform", platformRouter);
    await new Promise<void>((r) => {
      server = app.listen(0, r);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

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

  async function adminDeClinica() {
    const clinic = await prisma.clinic.create({
      data: {
        name: `Clínica puertas ${Date.now()}-${Math.random()}`,
        whatsappPhoneNumberId: `pu-${Date.now()}-${Math.random()}`,
        whatsappTokenEncrypted: encryptToken("test"),
        email: "test@example.com",
        timezone: "UTC",
        services: "x",
      },
    });
    clinicIds.push(clinic.id);
    const role = await ensureClinicAdminRole(clinic.id);
    const user = await prisma.user.create({
      data: {
        clinicId: clinic.id, email: `pu-${Math.random().toString(36).slice(2)}@puertas.test`, name: "Ana Puertas",
        passwordHash: await hashPassword("x-x-x-x-x-x"), roles: { create: [{ roleId: role.id }] },
      },
    });
    userIds.push(user.id);
    return { clinic, cookie: `${SESSION_COOKIE_NAME}=${signSession({ userId: user.id, clinicId: clinic.id })}` };
  }

  async function pegar(montaje: string, r: Ruta, cookie?: string, clinicId?: string) {
    const res = await fetch(`${base}${montaje}${urlDe(r, clinicId)}`, {
      method: r.metodo,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: ["GET", "HEAD", "DELETE"].includes(r.metodo) ? undefined : "{}",
    });
    return res.status;
  }

  const todas = [
    ...ROUTERS_DE_CLINICA.map((x) => ({ ...x, rutas: rutasDe(x.router) })),
    { nombre: "plataforma", router: platformRouter, montaje: "/platform", rutas: rutasDe(platformRouter) },
  ];

  it("hay rutas de verdad para recorrer (el recorrido no puede quedar vacío sin avisar)", () => {
    const por = Object.fromEntries(todas.map((t) => [t.nombre, t.rutas.length]));
    expect(por.dashboard).toBeGreaterThan(50);
    expect(por.plataforma).toBeGreaterThan(30);
    expect(por.usuarios).toBeGreaterThan(0);
    expect(por.roles).toBeGreaterThan(0);
  });

  it("sin sesión, TODAS las rutas de la API de clínica y de plataforma responden 401", async () => {
    const abiertas: string[] = [];
    for (const { montaje, rutas, nombre: grupo } of todas) {
      for (const r of rutas) {
        const status = await pegar(montaje, r);
        if (status !== 401) abiertas.push(`${grupo}: ${nombre(r)} → ${status}`);
      }
    }
    expect(abiertas, "rutas que NO piden sesión").toEqual([]);
  });

  it("un administrador de CLÍNICA no puede entrar a ninguna ruta de plataforma: 403", async () => {
    const { cookie } = await adminDeClinica();
    const abiertas: string[] = [];
    for (const r of rutasDe(platformRouter)) {
      const status = await pegar("/platform", r, cookie);
      if (status !== 403) abiertas.push(`${nombre(r)} → ${status}`);
    }
    expect(abiertas, "rutas de plataforma abiertas a una clínica").toEqual([]);
  });

  it("el administrador de una clínica no puede tocar NINGUNA ruta de otra clínica: 403", async () => {
    const { cookie } = await adminDeClinica();
    const abiertas: string[] = [];
    for (const { montaje, rutas, nombre: grupo } of todas.filter((t) => t.nombre !== "plataforma")) {
      for (const r of rutas) {
        // Un id que no existe: si alguna ruta no comprobara la clínica, el manejador correría contra la nada
        // y no contra datos reales.
        const status = await pegar(montaje, r, cookie, "clinica-ajena");
        if (status !== 403) abiertas.push(`${grupo}: ${nombre(r)} → ${status}`);
      }
    }
    expect(abiertas, "rutas que no aíslan por clínica").toEqual([]);
  });
});
