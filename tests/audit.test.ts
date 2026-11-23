import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import cookieParser from "cookie-parser";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db/client";
import { auditRequests } from "../src/middleware/audit";
import { authRouter } from "../src/routes/auth";
import { dashboardRouter } from "../src/routes/dashboard";
import { rolesRouter } from "../src/routes/roles";
import { usersRouter } from "../src/routes/users";
import { CLINIC_ADMIN_PERMISSION_IDS, PLATFORM_ONLY_PERMISSIONS } from "../src/config/permissions";
import { ensureClinicAdminRole } from "../src/repositories/roles.repository";
import { hashPassword, SESSION_COOKIE_NAME, signSession } from "../src/services/auth";
import { encryptToken } from "../src/services/crypto";
import {
  actionLabel,
  auditFiltersFromQuery,
  bodyFieldNames,
  deriveFromRoute,
  isAuditable,
  listAudit,
  outcomeFromStatus,
  recordAudit,
  unmatchedDenied,
} from "../src/services/audit";

/**
 * La auditoría de toda la API. Arma una aplicación Express REAL con el middleware y
 * las rutas verdaderas, y le pega por HTTP: lo que se prueba es el recorrido
 * completo (quién, qué, resultado), incluido lo denegado, y que nunca se guarden
 * valores de lo que se escribió.
 */

// Estos tests levantan un servidor, esperan registros que se escriben después de
// responder y limpian con un trigger de por medio: necesitan más margen que el default.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const PASSWORD = "Contrasena-De-Prueba-123";
const OBSERVACION_SECRETA = "OBSERVACION-CLINICA-QUE-NO-DEBE-QUEDAR-EN-LA-AUDITORIA";

let server: Server;
let base = "";
const clinicIds: string[] = [];
const userIds: string[] = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(auditRequests);
  app.post("/webhook/ping", (_req, res) => res.json({ ok: true }));
  app.use("/auth", authRouter);
  app.use("/dashboard", dashboardRouter);
  app.use("/dashboard", usersRouter);
  app.use("/dashboard", rolesRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Borra auditoría de prueba: el trigger la protege, así que se declara mantenimiento. */
async function purgarAuditoria() {
  await prisma.$transaction([
    prisma.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`,
    prisma.auditLog.deleteMany({
      where: { OR: [{ clinicId: { in: clinicIds } }, { userId: { in: userIds } }, { userEmail: { contains: "@audit.test" } }] },
    }),
  ]);
}

afterEach(async () => {
  await purgarAuditoria();
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  for (const clinicId of clinicIds) {
    await prisma.patientComment.deleteMany({ where: { clinicId } });
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.package.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.rolePermission.deleteMany({ where: { role: { clinicId } } });
    await prisma.role.deleteMany({ where: { clinicId } });
    await prisma.room.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
  userIds.length = 0;
});

async function escenario(opts?: { sinPermisos?: boolean; activo?: boolean }) {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica auditoría ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `au-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: "UTC",
      services: "x",
      professionals: { create: [{ name: "Gómez" }] },
      rooms: { create: [{ name: "Sala 1" }] },
    },
    include: { professionals: true, rooms: true },
  });
  clinicIds.push(clinic.id);

  const adminRole = await ensureClinicAdminRole(clinic.id);
  const rol = opts?.sinPermisos
    ? await prisma.role.create({ data: { clinicId: clinic.id, name: "Sin permisos" } })
    : adminRole;
  const email = `usuario-${Math.random().toString(36).slice(2)}@audit.test`;
  const user = await prisma.user.create({
    data: {
      clinicId: clinic.id,
      email,
      name: "Ana Auditada",
      active: opts?.activo ?? true,
      passwordHash: await hashPassword(PASSWORD),
      roles: { create: [{ roleId: rol.id }] },
    },
  });
  userIds.push(user.id);
  return { clinic, user, email };
}
type E = Awaited<ReturnType<typeof escenario>>;

async function http(path: string, init?: { method?: string; body?: unknown; cookie?: string }) {
  const res = await fetch(`${base}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(init?.cookie ? { cookie: init.cookie } : {}),
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, setCookie: res.headers.get("set-cookie"), json: await res.json().catch(() => null) };
}

/**
 * Una sesión ya iniciada, con la cookie firmada directamente. El login real tiene un
 * límite de 10 por IP cada 15 minutos (protege contra fuerza bruta), así que los tests
 * que no son del login no pasan por él; `iniciarSesionReal` es para los que sí.
 */
function iniciarSesion(e: E): string {
  return `${SESSION_COOKIE_NAME}=${signSession({ userId: e.user.id, clinicId: e.clinic.id })}`;
}

async function iniciarSesionReal(e: E, password = PASSWORD): Promise<string> {
  const r = await http("/auth/login", { method: "POST", body: { email: e.email, password } });
  if (r.status !== 200 || !r.setCookie) throw new Error(`login falló (${r.status})`);
  return r.setCookie.split(";")[0];
}

/** La auditoría se escribe DESPUÉS de responder: se espera a que aparezca. */
async function esperarRegistro(where: Parameters<typeof prisma.auditLog.findFirst>[0] extends infer A ? NonNullable<A>["where"] : never) {
  for (let i = 0; i < 60; i++) {
    const fila = await prisma.auditLog.findFirst({ where, orderBy: { occurredAt: "desc" } });
    if (fila) return fila;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

/** Que NO haya registro: se da un margen para que, si fuera a escribirse, ya esté. */
async function noHayRegistro(where: Parameters<typeof prisma.auditLog.count>[0] extends infer A ? NonNullable<A>["where"] : never) {
  await new Promise((r) => setTimeout(r, 400));
  return (await prisma.auditLog.count({ where })) === 0;
}

describe("el login", () => {
  it("un inicio de sesión correcto deja quién, cuándo y desde dónde", async () => {
    const e = await escenario();
    await iniciarSesionReal(e);
    const fila = await esperarRegistro({ userId: e.user.id, action: "auth.login" });
    expect(fila).toMatchObject({
      // Todo lo que pasa por la API lo hace una persona desde el panel.
      origin: "panel",
      outcome: "ok",
      statusCode: 200,
      method: "POST",
      route: "/auth/login",
      userEmail: e.email,
      userName: "Ana Auditada",
      clinicId: e.clinic.id,
    });
    expect(fila?.ip).toBeTruthy();
  });

  it("NUNCA guarda la contraseña: ni el valor ni el nombre del campo", async () => {
    const e = await escenario();
    await iniciarSesionReal(e);
    const fila = await esperarRegistro({ userId: e.user.id, action: "auth.login" });
    expect(JSON.stringify(fila)).not.toContain(PASSWORD);
    expect(fila?.details).toMatchObject({ campos: ["email"], camposSensiblesOmitidos: true });
  });

  it("una contraseña incorrecta queda como denegada, con el motivo real y quién lo intentó", async () => {
    const e = await escenario();
    const r = await http("/auth/login", { method: "POST", body: { email: e.email, password: "mala" } });
    expect(r.status).toBe(401);
    const fila = await esperarRegistro({ userId: e.user.id, action: "auth.login" });
    expect(fila).toMatchObject({ outcome: "denegado", statusCode: 401, userEmail: e.email });
    expect(fila?.details).toMatchObject({ motivo: "contrasena_incorrecta" });
    // Al cliente se le dice siempre lo mismo: no se revela qué cuentas existen.
    expect(r.json).toEqual({ error: "Email o contraseña inválidos" });
  });

  it("una cuenta que no existe se registra con el email que se intentó", async () => {
    const email = `fantasma-${Math.random().toString(36).slice(2)}@audit.test`;
    await http("/auth/login", { method: "POST", body: { email, password: "x" } });
    const fila = await esperarRegistro({ userEmail: email });
    expect(fila).toMatchObject({ outcome: "denegado", userId: null, action: "auth.login" });
    expect(fila?.details).toMatchObject({ motivo: "cuenta_inexistente" });
  });

  it("una cuenta desactivada se distingue de una inexistente", async () => {
    const e = await escenario({ activo: false });
    await http("/auth/login", { method: "POST", body: { email: e.email, password: PASSWORD } });
    const fila = await esperarRegistro({ userEmail: e.email });
    expect(fila?.details).toMatchObject({ motivo: "cuenta_desactivada" });
  });

  it("el cierre de sesión queda a nombre de quien la tenía abierta", async () => {
    const e = await escenario();
    const cookie = await iniciarSesionReal(e);
    await http("/auth/logout", { method: "POST", cookie });
    const fila = await esperarRegistro({ userId: e.user.id, action: "auth.logout" });
    expect(fila).toMatchObject({ outcome: "ok", method: "POST" });
  });
});

describe("las operaciones que modifican algo", () => {
  it("cada POST, PUT, PATCH y DELETE queda registrado con quién, sobre qué y de qué clínica", async () => {
    const e = await escenario();
    const cookie = iniciarSesion(e);
    const r = await http(`/dashboard/clinics/${e.clinic.id}/patients`, {
      method: "POST",
      cookie,
      body: { firstName: "María", lastName: "López", phone: "5491100000077" },
    });
    expect(r.status).toBe(201);
    const fila = await esperarRegistro({ userId: e.user.id, action: "patient.create" });
    expect(fila).toMatchObject({
      outcome: "ok",
      statusCode: 201,
      method: "POST",
      clinicId: e.clinic.id,
      resourceType: "patients",
      userEmail: e.email,
    });
    expect(fila?.route).toBe("/dashboard/clinics/:clinicId/patients");
  });

  it("registra QUÉ CAMPOS cambiaron pero nunca sus valores", async () => {
    const e = await escenario();
    const cookie = iniciarSesion(e);
    const p = await prisma.patient.create({ data: { clinicId: e.clinic.id, phone: "5491100000078", name: "Juan Pérez" } });
    const r = await http(`/dashboard/clinics/${e.clinic.id}/patients/${p.id}`, {
      method: "PUT",
      cookie,
      body: { observations: OBSERVACION_SECRETA, suggestedNextVisitNote: "control" },
    });
    expect(r.status).toBe(200);
    const fila = await esperarRegistro({ userId: e.user.id, action: "patient.update" });
    expect(fila).toMatchObject({ resourceType: "patients", resourceId: p.id });
    // `campos` = lo que llegó en el pedido; `camposModificados` = lo que cambió de verdad.
    expect(fila?.details).toMatchObject({
      campos: ["observations", "suggestedNextVisitNote"],
      camposModificados: ["observations", "suggestedNextVisitNote"],
    });
    expect(JSON.stringify(fila)).not.toContain(OBSERVACION_SECRETA);
    expect(JSON.stringify(fila)).not.toContain("5491100000078");
  });

  it("si el pedido manda todos los campos pero solo cambió uno, registra solo ese en `camposModificados`", async () => {
    const e = await escenario();
    const cookie = iniciarSesion(e);
    const p = await prisma.patient.create({
      data: { clinicId: e.clinic.id, phone: "5491100000082", name: "Eva Gómez", firstName: "Eva", lastName: "Gómez", observations: "igual" },
    });
    // La ficha de la pantalla manda todo en cada guardado.
    await http(`/dashboard/clinics/${e.clinic.id}/patients/${p.id}`, {
      method: "PUT",
      cookie,
      body: { firstName: "Eva", lastName: "Gómez", observations: "igual", suggestedNextVisitNote: "control", outreachOptOut: false },
    });
    const fila = await esperarRegistro({ userId: e.user.id, action: "patient.update" });
    expect((fila?.details as { camposModificados: string[] }).camposModificados).toEqual(["suggestedNextVisitNote"]);
    expect((fila?.details as { campos: string[] }).campos).toHaveLength(5);
  });

  it("un cambio de permisos de un rol sí registra cuáles (es un catálogo fijo, no datos de nadie)", async () => {
    const e = await escenario();
    const cookie = iniciarSesion(e);
    const rol = await prisma.role.create({ data: { clinicId: e.clinic.id, name: "Rol de prueba" } });
    const r = await http(`/dashboard/clinics/${e.clinic.id}/roles/${rol.id}`, {
      method: "PUT",
      cookie,
      body: { permissionIds: ["turnos.ver", "pacientes.ver"] },
    });
    expect(r.status).toBe(200);
    const fila = await esperarRegistro({ userId: e.user.id, action: "role.update" });
    expect(fila?.details).toMatchObject({ permisos: ["turnos.ver", "pacientes.ver"] });
  });

  it("la cancelación con motivo queda en la auditoría Y en la cita, con su evento", async () => {
    const e = await escenario();
    const cookie = iniciarSesion(e);
    const paciente = await prisma.patient.create({ data: { clinicId: e.clinic.id, phone: "5491100000079", name: "Eva" } });
    const cita = await prisma.appointment.create({
      data: {
        clinicId: e.clinic.id, patientId: paciente.id, professionalId: e.clinic.professionals[0].id, roomId: e.clinic.rooms[0].id,
        service: "Limpieza", startTime: new Date("2030-06-17T10:00:00Z"), endTime: new Date("2030-06-17T10:30:00Z"),
      },
    });
    const r = await http(`/dashboard/clinics/${e.clinic.id}/appointments/${cita.id}/cancel`, {
      method: "POST",
      cookie,
      body: { reason: "  El paciente avisó que no puede venir  " },
    });
    expect(r.status).toBe(200);

    const fila = await esperarRegistro({ userId: e.user.id, action: "appointment.cancel" });
    expect(fila).toMatchObject({ resourceType: "appointments", resourceId: cita.id, outcome: "ok" });
    expect(fila?.details).toMatchObject({ motivo: "El paciente avisó que no puede venir" });

    const despues = await prisma.appointment.findUniqueOrThrow({ where: { id: cita.id } });
    expect(despues).toMatchObject({
      status: "cancelado",
      cancelledByKind: "clinica",
      cancelledByUserId: e.user.id,
      cancelReason: "El paciente avisó que no puede venir",
    });
    expect(despues.cancelledAt).toBeTruthy();
    const evento = await prisma.appointmentEvent.findFirstOrThrow({ where: { appointmentId: cita.id } });
    expect(evento).toMatchObject({ type: "cancelada", actorKind: "usuario", actorUserId: e.user.id, reason: "El paciente avisó que no puede venir" });
  });
});

describe("lo que NO se audita", () => {
  it("las lecturas comunes no llenan la tabla", async () => {
    const e = await escenario();
    const cookie = iniciarSesion(e);
    await http(`/dashboard/clinics/${e.clinic.id}/patients`, { cookie }); // la lista
    await http("/auth/me", { cookie });
    expect(await noHayRegistro({ userId: e.user.id, method: "GET" })).toBe(true);
  });

  it("el webhook de Meta y las rutas que no existen no se auditan", async () => {
    const antes = await prisma.auditLog.count({ where: { route: { startsWith: "/webhook" } } });
    await http("/webhook/ping", { method: "POST", body: { x: 1 } });
    await http("/no/existe", { method: "POST", body: { x: 1 } });
    await new Promise((r) => setTimeout(r, 400));
    expect(await prisma.auditLog.count({ where: { route: { startsWith: "/webhook" } } })).toBe(antes);
    expect(await prisma.auditLog.count({ where: { route: "/no/existe" } })).toBe(0);
  });
});

describe("las lecturas sensibles", () => {
  it("ver la ficha de un paciente queda registrado, y listar pacientes no", async () => {
    const e = await escenario();
    const cookie = iniciarSesion(e);
    const p = await prisma.patient.create({ data: { clinicId: e.clinic.id, phone: "5491100000080", name: "Luis" } });
    const r = await http(`/dashboard/clinics/${e.clinic.id}/patients/${p.id}`, { cookie });
    expect(r.status).toBe(200);
    const fila = await esperarRegistro({ userId: e.user.id, action: "patient.view" });
    expect(fila).toMatchObject({ method: "GET", resourceType: "patients", resourceId: p.id, outcome: "ok" });
  });
});

describe("lo denegado también queda", () => {
  it("un usuario sin el permiso: 403, a su nombre", async () => {
    const e = await escenario({ sinPermisos: true });
    const cookie = iniciarSesion(e);
    const r = await http(`/dashboard/clinics/${e.clinic.id}/patients`, {
      method: "POST",
      cookie,
      body: { firstName: "X", phone: "5491100000081" },
    });
    expect(r.status).toBe(403);
    const fila = await esperarRegistro({ userId: e.user.id, action: "patient.create" });
    expect(fila).toMatchObject({ outcome: "denegado", statusCode: 403, userEmail: e.email });
  });

  it("sin sesión: 401, sin usuario", async () => {
    const e = await escenario();
    const r = await http(`/dashboard/clinics/${e.clinic.id}/patients`, { method: "POST", body: { firstName: "X" } });
    expect(r.status).toBe(401);
    const fila = await esperarRegistro({ clinicId: e.clinic.id, action: "patient.create" });
    // `clinicId` sale del patrón de la ruta aunque no hubiera sesión.
    expect(fila).toMatchObject({ outcome: "denegado", statusCode: 401, userId: null });
  });

  it("una operación que falla (404 o 400) queda como error", async () => {
    const e = await escenario();
    const cookie = iniciarSesion(e);
    const r = await http(`/dashboard/clinics/${e.clinic.id}/patients/no-existe`, { method: "PUT", cookie, body: { observations: "x" } });
    expect(r.status).toBe(404);
    const fila = await esperarRegistro({ userId: e.user.id, action: "patient.update" });
    expect(fila).toMatchObject({ outcome: "error", statusCode: 404 });
  });
});

describe("el registro es de solo escritura", () => {
  it("la base rechaza editar un registro", async () => {
    await recordAudit({ action: "prueba.inmutable", outcome: "ok", userEmail: "inmutable@audit.test" });
    const fila = await esperarRegistro({ userEmail: "inmutable@audit.test" });
    await expect(prisma.auditLog.update({ where: { id: fila!.id }, data: { action: "otra" } })).rejects.toThrow(/solo escritura/);
    expect((await prisma.auditLog.findUniqueOrThrow({ where: { id: fila!.id } })).action).toBe("prueba.inmutable");
  });

  it("la base rechaza borrarlo, y deleteMany también", async () => {
    await recordAudit({ action: "prueba.inborrable", outcome: "ok", userEmail: "inborrable@audit.test" });
    const fila = await esperarRegistro({ userEmail: "inborrable@audit.test" });
    await expect(prisma.auditLog.delete({ where: { id: fila!.id } })).rejects.toThrow(/solo escritura/);
    await expect(prisma.auditLog.deleteMany({ where: { id: fila!.id } })).rejects.toThrow(/solo escritura/);
    expect(await prisma.auditLog.count({ where: { id: fila!.id } })).toBe(1);
  });

  it("solo una sesión que declara mantenimiento puede borrar", async () => {
    await recordAudit({ action: "prueba.mantenimiento", outcome: "ok", userEmail: "mant@audit.test" });
    const fila = await esperarRegistro({ userEmail: "mant@audit.test" });
    await prisma.$transaction([
      prisma.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`,
      prisma.auditLog.deleteMany({ where: { id: fila!.id } }),
    ]);
    expect(await prisma.auditLog.count({ where: { id: fila!.id } })).toBe(0);
  });
});

describe("consultar la auditoría", () => {
  it("acotado a una clínica, nunca devuelve lo de otra", async () => {
    const e = await escenario();
    const otra = await escenario();
    const cookie = iniciarSesion(e);
    const cookieOtra = iniciarSesion(otra);
    await http(`/dashboard/clinics/${e.clinic.id}/patients`, { method: "POST", cookie, body: { firstName: "A", phone: "5491100000091" } });
    await http(`/dashboard/clinics/${otra.clinic.id}/patients`, { method: "POST", cookie: cookieOtra, body: { firstName: "B", phone: "5491100000092" } });
    await esperarRegistro({ userId: otra.user.id, action: "patient.create" });
    await esperarRegistro({ userId: e.user.id, action: "patient.create" });

    const r = await listAudit({ clinicId: e.clinic.id });
    expect(r.registros.length).toBeGreaterThan(0);
    expect(r.registros.every((f) => f.clinicId === e.clinic.id)).toBe(true);
    expect(r.registros.some((f) => f.userEmail === otra.email)).toBe(false);
    expect(r.registros.map((f) => f.etiqueta)).toContain("Cargó un paciente");
  });

  it("una clínica no tiene pantalla ni ruta de auditoría: es solo de la plataforma", async () => {
    const e = await escenario();
    const cookie = iniciarSesion(e);
    // Ni siquiera su admin: trae IPs y user agents, datos técnicos que no le corresponden.
    expect((await http(`/dashboard/clinics/${e.clinic.id}/audit`, { cookie })).status).toBe(404);
    expect(PLATFORM_ONLY_PERMISSIONS).toContain("auditoria.ver");
    expect(CLINIC_ADMIN_PERMISSION_IDS).not.toContain("auditoria.ver");
  });

  it("consultar la auditoría de la plataforma también queda registrado", () => {
    expect(deriveFromRoute("GET", "/platform/audit", {})).toMatchObject({ action: "audit.view" });
    expect(isAuditable("GET", "/platform/audit")).toBe(true);
  });

  it("filtra por resultado, usuario y acción, y rechaza fechas que no entiende", async () => {
    const e = await escenario();
    await http("/auth/login", { method: "POST", body: { email: e.email, password: "mala" } });
    const cookie = await iniciarSesionReal(e);
    await esperarRegistro({ userId: e.user.id, action: "auth.login", outcome: "denegado" });
    await esperarRegistro({ userId: e.user.id, action: "auth.login", outcome: "ok" });

    const denegados = await listAudit({ clinicId: e.clinic.id, outcome: "denegado" });
    expect(denegados.registros.every((r) => r.outcome === "denegado")).toBe(true);
    expect(denegados.registros.length).toBeGreaterThan(0);

    const porUsuario = await listAudit({ userEmail: e.email.slice(0, 12) });
    expect(porUsuario.registros.every((r) => r.userEmail?.includes(e.email.slice(0, 12)))).toBe(true);

    const porAccion = await listAudit({ clinicId: e.clinic.id, action: "auth.login" });
    expect(porAccion.registros.every((r) => r.action === "auth.login")).toBe(true);

    expect(auditFiltersFromQuery({ desde: "ayer" }).ok).toBe(false);
  });

  it("pagina con el cursor, del más nuevo al más viejo", async () => {
    const e = await escenario();
    for (let i = 0; i < 3; i++) {
      await recordAudit({ action: `paginacion.${i}`, outcome: "ok", clinicId: e.clinic.id });
      await new Promise((r) => setTimeout(r, 5));
    }
    const primera = await listAudit({ clinicId: e.clinic.id, limit: 2 });
    expect(primera.registros.map((r) => r.action)).toEqual(["paginacion.2", "paginacion.1"]);
    expect(primera.siguiente).not.toBeNull();
    const segunda = await listAudit({ clinicId: e.clinic.id, limit: 2, before: new Date(primera.siguiente!) });
    expect(segunda.registros.map((r) => r.action)).toEqual(["paginacion.0"]);
    expect(segunda.siguiente).toBeNull();
  });
});

describe("las piezas puras", () => {
  it("outcomeFromStatus", () => {
    expect(outcomeFromStatus(200)).toBe("ok");
    expect(outcomeFromStatus(302)).toBe("ok");
    expect(outcomeFromStatus(401)).toBe("denegado");
    expect(outcomeFromStatus(403)).toBe("denegado");
    expect(outcomeFromStatus(429)).toBe("denegado");
    expect(outcomeFromStatus(400)).toBe("error");
    expect(outcomeFromStatus(404)).toBe("error");
    expect(outcomeFromStatus(500)).toBe("error");
  });

  it("isAuditable: toda mutación, solo las lecturas sensibles, nunca el webhook ni lo que no tiene ruta", () => {
    expect(isAuditable("POST", "/dashboard/clinics/:clinicId/appointments")).toBe(true);
    expect(isAuditable("DELETE", "/platform/secrets/:key")).toBe(true);
    expect(isAuditable("GET", "/dashboard/clinics/:clinicId/patients")).toBe(false);
    expect(isAuditable("GET", "/dashboard/clinics/:clinicId/patients/:patientId")).toBe(true);
    expect(isAuditable("GET", "/dashboard/clinics/:clinicId/conversations/:patientPhone")).toBe(true);
    expect(isAuditable("GET", "/oauth/google/callback")).toBe(true);
    expect(isAuditable("POST", "/webhook")).toBe(false);
    expect(isAuditable("POST", null)).toBe(false);
  });

  it("deriveFromRoute saca la operación, el recurso y la clínica del patrón", () => {
    expect(deriveFromRoute("POST", "/dashboard/clinics/:clinicId/appointments/:appointmentId/cancel", { clinicId: "c1", appointmentId: "a1" })).toEqual({
      action: "appointment.cancel", resourceType: "appointments", resourceId: "a1", clinicId: "c1",
    });
    expect(deriveFromRoute("PUT", "/dashboard/clinics/:clinicId/working-hours", { clinicId: "c1" })).toEqual({
      action: "PUT /dashboard/clinics/:clinicId/working-hours", resourceType: "working-hours", resourceId: null, clinicId: "c1",
    });
    expect(deriveFromRoute("PUT", "/platform/clinics/:id", { id: "c9" })).toMatchObject({ action: "clinic.update", resourceType: "clinics", resourceId: "c9", clinicId: "c9" });
    expect(deriveFromRoute("PUT", "/platform/clinics/:id/membership", { id: "c9" })).toMatchObject({ resourceType: "membership", clinicId: "c9" });
    expect(deriveFromRoute("DELETE", "/platform/secrets/:key", { key: "microsoft" })).toMatchObject({ action: "platform.secret_delete", resourceType: "secrets", resourceId: "microsoft", clinicId: null });
    expect(deriveFromRoute("POST", "/auth/login", {})).toMatchObject({ action: "auth.login", resourceType: "login", clinicId: null });
    expect(deriveFromRoute("GET", "/oauth/google/callback", {})).toMatchObject({ action: "calendar.connect" });
  });

  it("unmatchedDenied arma el patrón de un pedido rechazado antes de llegar a una ruta", () => {
    expect(unmatchedDenied("POST", "/dashboard/clinics/cmwf123abc456def789ghij/patients?x=secreto", 401)).toEqual({
      pattern: "/dashboard/clinics/:clinicId/patients",
      clinicId: "cmwf123abc456def789ghij",
    });
    // Los ids de otros recursos se reemplazan, y el query string no queda.
    expect(unmatchedDenied("PUT", "/dashboard/clinics/c1/patients/cmwf123abc456def789ghij/comments/42", 403)?.pattern).toBe(
      "/dashboard/clinics/:clinicId/patients/:id/comments/:id"
    );
    // Solo lo que modifica y fue denegado, en la API: un 404 sin ruta o una lectura son ruido.
    expect(unmatchedDenied("GET", "/dashboard/clinics/c1/patients", 401)).toBeNull();
    expect(unmatchedDenied("POST", "/dashboard/clinics/c1/patients", 404)).toBeNull();
    expect(unmatchedDenied("POST", "/otra/cosa", 401)).toBeNull();
    expect(unmatchedDenied("POST", "/webhook", 401)).toBeNull();
  });

  it("bodyFieldNames deja los nombres y omite los de credenciales", () => {
    expect(bodyFieldNames({ name: "x", password: "y", whatsappToken: "z", clientSecret: "s", observations: "o" })).toEqual({
      campos: ["name", "observations"],
      omitidos: true,
    });
    expect(bodyFieldNames({ a: 1 })).toEqual({ campos: ["a"], omitidos: false });
    expect(bodyFieldNames(null)).toEqual({ campos: [], omitidos: false });
    expect(bodyFieldNames([1, 2])).toEqual({ campos: [], omitidos: false });
  });

  it("actionLabel usa la etiqueta conocida o arma una con el verbo y el recurso", () => {
    expect(actionLabel({ action: "appointment.cancel", method: "POST", resourceType: "appointments" })).toBe("Canceló una cita");
    expect(actionLabel({ action: "PUT /x", method: "PUT", resourceType: "working-hours" })).toBe("Modificó working-hours");
    // Las lecturas sensibles también se leen en español.
    expect(deriveFromRoute("GET", "/platform/audit", { clinicId: "c1" }).action).toBe("audit.view");
    expect(actionLabel({ action: "audit.view", method: "GET", resourceType: "audit" })).toBe("Consultó la auditoría");
    expect(deriveFromRoute("GET", "/dashboard/clinics/:clinicId/conversations/:patientPhone", { clinicId: "c1", patientPhone: "x" }).action).toBe("conversation.view");
    expect(actionLabel({ action: "DELETE /x", method: "DELETE", resourceType: null })).toBe("Eliminó");
  });

  it("auditFiltersFromQuery interpreta las fechas y 'hasta' incluye el día entero", () => {
    const r = auditFiltersFromQuery({ desde: "2030-06-01", hasta: "2030-06-15", resultado: "denegado", usuario: "ana" });
    expect(r.ok && r.filters.outcome).toBe("denegado");
    expect(r.ok && r.filters.userEmail).toBe("ana");
    expect(r.ok && r.filters.to?.toISOString()).toBe("2030-06-15T23:59:59.999Z");
    expect(auditFiltersFromQuery({ desde: "no-es-fecha" })).toMatchObject({ ok: false });
    // Un resultado inventado se ignora, no se pasa a la consulta.
    expect(auditFiltersFromQuery({ resultado: "cualquiera" })).toMatchObject({ ok: true, filters: { outcome: undefined } });
  });
});
