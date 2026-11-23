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
import { csvCell, neutralizeFormula, toCsv } from "../src/services/csv";
import { buildReport, categorizarMotivo, parseReportFilters, reportToCsv, type ReportKind } from "../src/services/reports";
import { createCampaign } from "../src/services/campaigns";
import { purgeAuditForClinics } from "./helpers/audit";

/**
 * Reportes de citas. Lo que más importa son las DEFINICIONES: una cita que el paciente
 * movió a otra hora no es una cancelación, "atendida confirmada" no es lo mismo que "dada por
 * atendida por el sistema", y los períodos y el día de la semana son los de la clínica.
 */

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

/** Miércoles 12 de junio de 2030, mediodía UTC. */
const AHORA = new Date("2030-06-12T12:00:00.000Z");
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

afterEach(async () => {
  await purgeAuditForClinics(clinicIds);
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  for (const clinicId of clinicIds) {
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.campaignLead.deleteMany({ where: { clinicId } });
    await prisma.campaign.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.rolePermission.deleteMany({ where: { role: { clinicId } } });
    await prisma.role.deleteMany({ where: { clinicId } });
    await prisma.service.deleteMany({ where: { clinicId } });
    await prisma.systemEvent.deleteMany({ where: { clinicId } });
    await prisma.escalation.deleteMany({ where: { clinicId } });
    await prisma.workingHours.deleteMany({ where: { clinicId } });
    await prisma.scheduleException.deleteMany({ where: { clinicId } });
    await prisma.resource.deleteMany({ where: { clinicId } });
    await prisma.room.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
  userIds.length = 0;
});

async function escenario(timezone = "UTC") {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica reportes ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `rp-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone,
      services: "x",
      professionals: { create: [{ name: "Gómez" }, { name: "Ruiz" }] },
      rooms: { create: [{ name: "Sala 1" }] },
    },
    include: { professionals: { orderBy: { name: "asc" } }, rooms: true },
  });
  clinicIds.push(clinic.id);
  const [gomez, ruiz] = clinic.professionals;
  // Con un profesional cada uno: una campaña necesita un servicio que alguien atienda.
  const limpieza = await prisma.service.create({ data: { clinicId: clinic.id, name: "Limpieza", durationMinutes: 30, professionals: { connect: [{ id: gomez.id }] } } });
  const laser = await prisma.service.create({ data: { clinicId: clinic.id, name: "Láser", durationMinutes: 30, professionals: { connect: [{ id: gomez.id }] } } });
  const maria = await prisma.patient.create({ data: { clinicId: clinic.id, phone: "5491100000001", name: "María López" } });
  const juan = await prisma.patient.create({ data: { clinicId: clinic.id, phone: "5491100000002", name: "Juan Pérez" } });
  return { clinic, gomez, ruiz, sala: clinic.rooms[0], limpieza, laser, maria, juan };
}
type E = Awaited<ReturnType<typeof escenario>>;

interface CitaOpts {
  start: string;
  status?: "confirmado" | "cancelado" | "atendido";
  professionalId?: string;
  serviceId?: string;
  serviceName?: string;
  patientId?: string;
  roomId?: string;
  resourceId?: string;
  createdAt?: string;
  createdByUserId?: string;
  rescheduledFromId?: string;
  attendedAt?: string | null;
  cancelledAt?: string | null;
  cancelledByKind?: string | null;
  cancelReason?: string | null;
}

async function cita(e: E, o: CitaOpts) {
  const start = new Date(o.start);
  return prisma.appointment.create({
    data: {
      clinicId: e.clinic.id,
      patientId: o.patientId ?? e.maria.id,
      professionalId: o.professionalId ?? e.gomez.id,
      roomId: o.roomId ?? e.sala.id,
      resourceId: o.resourceId ?? null,
      ...(o.createdAt ? { createdAt: new Date(o.createdAt) } : {}),
      createdByUserId: o.createdByUserId ?? null,
      rescheduledFromId: o.rescheduledFromId ?? null,
      serviceId: o.serviceId ?? e.limpieza.id,
      service: o.serviceName ?? "Limpieza",
      startTime: start,
      endTime: new Date(start.getTime() + 30 * 60_000),
      status: o.status ?? "confirmado",
      attendedAt: o.attendedAt ? new Date(o.attendedAt) : null,
      cancelledAt: o.cancelledAt ? new Date(o.cancelledAt) : null,
      cancelledByKind: o.cancelledByKind ?? null,
      cancelReason: o.cancelReason ?? null,
    },
  });
}

const filtros = (e: E, q: Record<string, unknown> = {}) => {
  const r = parseReportFilters({ desde: "2030-06-10", hasta: "2030-06-16", ...q }, e.clinic, AHORA);
  if (!r.ok) throw new Error(r.error);
  return r.filters;
};
const informe = (e: E, kind: ReportKind, q: Record<string, unknown> = {}) =>
  buildReport({ kind, clinic: e.clinic, filters: filtros(e, q), now: AHORA });
const kpi = (r: Awaited<ReturnType<typeof informe>>, clave: string) => r.kpis.find((k) => k.clave === clave)?.valor;
const tabla = (r: Awaited<ReturnType<typeof informe>>, clave: string) => r.tablas.find((t) => t.clave === clave)!.filas;

describe("los filtros", () => {
  const clinicUtc = { timezone: "UTC" };
  const mexico = { timezone: "America/Mexico_City" };

  it("por defecto son los últimos 30 días, terminando hoy", () => {
    const r = parseReportFilters({}, clinicUtc, AHORA);
    expect(r.ok && r.filters).toMatchObject({ fromKey: "2030-05-14", toKey: "2030-06-12", base: "evento" });
  });

  it("'hoy' es el de la clínica, no el del servidor", () => {
    // 03:00 UTC del 12 es el 11 a las 21:00 en México.
    const r = parseReportFilters({}, mexico, new Date("2030-06-12T03:00:00.000Z"));
    expect(r.ok && r.filters.toKey).toBe("2030-06-11");
  });

  it("el período son las 24 horas locales de cada día, ambos incluidos", () => {
    const r = parseReportFilters({ desde: "2030-06-10", hasta: "2030-06-10" }, mexico, AHORA);
    expect(r.ok && r.filters.from.toISOString()).toBe("2030-06-10T06:00:00.000Z");
    expect(r.ok && r.filters.toExclusive.toISOString()).toBe("2030-06-11T06:00:00.000Z");
  });

  it("rechaza fechas imposibles, invertidas o con un período demasiado largo", () => {
    for (const q of [{ desde: "2030-02-31" }, { hasta: "2030-13-01" }, { desde: "ayer" }, { desde: "2030-06-20", hasta: "2030-06-10" }, { desde: "2028-01-01", hasta: "2030-06-10" }]) {
      expect(parseReportFilters(q, clinicUtc, AHORA).ok).toBe(false);
    }
    expect(parseReportFilters({ desde: "2029-06-12", hasta: "2030-06-12" }, clinicUtc, AHORA).ok).toBe(true); // 366 días
  });

  it("la base es 'evento' salvo que pidan 'cita'; los filtros se limpian", () => {
    const r = parseReportFilters({ base: "cualquiera", professionalId: "  p1 ", serviceId: "" }, clinicUtc, AHORA);
    expect(r.ok && r.filters).toMatchObject({ base: "evento", professionalId: "p1", serviceId: undefined });
    expect(parseReportFilters({ base: "cita" }, clinicUtc, AHORA).ok && true).toBe(true);
  });
});

describe("el resumen del período", () => {
  async function agenda(e: E) {
    await cita(e, { start: "2030-06-10T10:00:00Z", status: "atendido", attendedAt: "2030-06-10T10:30:00Z" }); // confirmada
    await cita(e, { start: "2030-06-10T11:00:00Z", status: "atendido" }); // automática
    await cita(e, { start: "2030-06-10T12:00:00Z", status: "cancelado", cancelledByKind: "paciente", cancelledAt: "2030-06-09T12:00:00Z" });
    await cita(e, { start: "2030-06-10T13:00:00Z", status: "cancelado", cancelledByKind: "clinica", cancelledAt: "2030-06-10T09:00:00Z" });
    await cita(e, { start: "2030-06-10T14:00:00Z", status: "cancelado" }); // anterior al registro: sin dato
    await cita(e, { start: "2030-06-10T15:00:00Z", status: "cancelado", cancelledByKind: "reprogramacion" }); // se movió: no cuenta
    await cita(e, { start: "2030-06-11T10:00:00Z", status: "confirmado" }); // pasada sin confirmar
    await cita(e, { start: "2030-06-15T10:00:00Z", status: "confirmado" }); // todavía por venir
  }

  it("cuenta cada resultado y excluye lo que se movió de hora", async () => {
    const e = await escenario();
    await agenda(e);
    const r = await informe(e, "resumen");
    expect(kpi(r, "citas")).toBe(7); // 8 menos la que se reprogramó
    expect(kpi(r, "atendidas")).toBe(2);
    expect(kpi(r, "atendidas_confirmadas")).toBe(1);
    expect(kpi(r, "atendidas_automaticas")).toBe(1);
    expect(kpi(r, "canceladas")).toBe(3);
    expect(kpi(r, "sin_confirmar")).toBe(1);
    expect(kpi(r, "futuras")).toBe(1);
  });

  it("las tasas: cancelación sobre todas, atención sobre las que ya pasaron", async () => {
    const e = await escenario();
    await agenda(e);
    const r = await informe(e, "resumen");
    expect(kpi(r, "tasa_cancelacion")).toBe(42.9); // 3 de 7
    expect(kpi(r, "tasa_atencion")).toBe(33.3); // 2 de las 6 que ya pasaron
    expect(r.kpis.find((k) => k.clave === "tasa_cancelacion")?.formato).toBe("porcentaje");
  });

  it("separa las canceladas por quién, con las anteriores al registro como 'sin dato'", async () => {
    const e = await escenario();
    await agenda(e);
    const r = await informe(e, "resumen");
    expect(tabla(r, "canceladas_por_quien").map((f) => f[1])).toEqual([1, 1, 1]);
  });

  it("con un período vacío no divide por cero", async () => {
    const e = await escenario();
    const r = await informe(e, "resumen");
    expect(kpi(r, "citas")).toBe(0);
    expect(kpi(r, "tasa_cancelacion")).toBeNull();
    expect(kpi(r, "tasa_atencion")).toBeNull();
  });

  it("filtra por profesional y por servicio", async () => {
    const e = await escenario();
    await cita(e, { start: "2030-06-10T10:00:00Z", professionalId: e.gomez.id });
    await cita(e, { start: "2030-06-10T11:00:00Z", professionalId: e.ruiz.id, serviceId: e.laser.id, serviceName: "Láser" });
    expect(kpi(await informe(e, "resumen", { professionalId: e.ruiz.id }), "citas")).toBe(1);
    expect(kpi(await informe(e, "resumen", { serviceId: e.laser.id }), "citas")).toBe(1);
    expect(kpi(await informe(e, "resumen", { professionalId: e.gomez.id, serviceId: e.laser.id }), "citas")).toBe(0);
  });

  it("no mezcla clínicas", async () => {
    const e = await escenario();
    const otra = await escenario();
    await cita(otra, { start: "2030-06-10T10:00:00Z" });
    expect(kpi(await informe(e, "resumen"), "citas")).toBe(0);
  });

  it("las reagendadas se cuentan desde los eventos, por el día de la cita", async () => {
    const e = await escenario();
    const c = await cita(e, { start: "2030-06-11T10:00:00Z" });
    await prisma.appointmentEvent.create({ data: { clinicId: e.clinic.id, appointmentId: c.id, type: "reagendada", actorKind: "paciente" } });
    expect(kpi(await informe(e, "resumen"), "reagendadas")).toBe(1);
  });
});

describe("las cancelaciones", () => {
  it("no cuentan las citas que el paciente movió a otra hora", async () => {
    const e = await escenario();
    await cita(e, { start: "2030-06-10T10:00:00Z", status: "cancelado", cancelledByKind: "reprogramacion", cancelledAt: "2030-06-09T10:00:00Z" });
    await cita(e, { start: "2030-06-10T11:00:00Z", status: "cancelado", cancelledByKind: "paciente", cancelledAt: "2030-06-09T10:00:00Z" });
    const r = await informe(e, "cancelaciones", { base: "cita" });
    expect(kpi(r, "canceladas")).toBe(1);
  });

  it("separa quién canceló, el motivo y la antelación", async () => {
    const e = await escenario();
    await cita(e, { start: "2030-06-10T10:00:00Z", status: "cancelado", cancelledByKind: "paciente", cancelledAt: "2030-06-09T10:00:00Z", cancelReason: "Me salió un viaje" });
    await cita(e, { start: "2030-06-10T12:00:00Z", status: "cancelado", cancelledByKind: "clinica", cancelledAt: "2030-06-10T09:00:00Z" });
    const r = await informe(e, "cancelaciones", { base: "cita" });
    expect(kpi(r, "por_paciente")).toBe(1);
    expect(kpi(r, "por_clinica")).toBe(1);
    expect(kpi(r, "con_motivo")).toBe(1);
    // La de la clínica avisó 3 horas antes: menos de 24 h.
    expect(kpi(r, "tardias")).toBe(1);
    const fila = r.detalle.filas.find((f) => f[5] === "El paciente (WhatsApp)")!;
    expect(fila[6]).toBe("Me salió un viaje");
    expect(fila[8]).toBe(24); // horas de aviso
  });

  it("marca las quejas desde el evento de cancelación", async () => {
    const e = await escenario();
    const c = await cita(e, { start: "2030-06-10T10:00:00Z", status: "cancelado", cancelledByKind: "paciente", cancelledAt: "2030-06-09T10:00:00Z", cancelReason: "Esperé una hora" });
    await prisma.appointmentEvent.create({ data: { clinicId: e.clinic.id, appointmentId: c.id, type: "cancelada", actorKind: "paciente", details: { queja: true } } });
    await cita(e, { start: "2030-06-10T11:00:00Z", status: "cancelado", cancelledByKind: "paciente", cancelledAt: "2030-06-09T10:00:00Z", cancelReason: "No puedo" });
    const r = await informe(e, "cancelaciones", { base: "cita" });
    expect(kpi(r, "quejas")).toBe(1);
    expect(r.detalle.filas.filter((f) => f[7] === "Sí").map((f) => f[6])).toEqual(["Esperé una hora"]);
  });

  it("por 'cuándo se canceló' las anteriores al registro no aparecen (no tienen fecha); por la cita sí, y lo avisa", async () => {
    const e = await escenario();
    await cita(e, { start: "2030-06-10T10:00:00Z", status: "cancelado" }); // sin cancelledAt
    const porEvento = await informe(e, "cancelaciones", { base: "evento" });
    const porCita = await informe(e, "cancelaciones", { base: "cita" });
    expect(kpi(porEvento, "canceladas")).toBe(0);
    expect(kpi(porCita, "canceladas")).toBe(1);
    expect(porCita.notas.join(" ")).toContain("anteriores al 13/11/2026");
    expect(porCita.detalle.filas[0][5]).toBe("Sin dato");
  });

  it("por 'cuándo se canceló', el día de la cita no importa", async () => {
    const e = await escenario();
    // La cita era el 30 de junio (fuera del período) pero se canceló el 11.
    await cita(e, { start: "2030-06-30T10:00:00Z", status: "cancelado", cancelledByKind: "paciente", cancelledAt: "2030-06-11T10:00:00Z" });
    expect(kpi(await informe(e, "cancelaciones", { base: "evento" }), "canceladas")).toBe(1);
    expect(kpi(await informe(e, "cancelaciones", { base: "cita" }), "canceladas")).toBe(0);
  });

  it("agrupa por profesional, por servicio y por día de la semana de la cita", async () => {
    const e = await escenario();
    const c = { status: "cancelado" as const, cancelledByKind: "paciente", cancelledAt: "2030-06-09T10:00:00Z" };
    await cita(e, { ...c, start: "2030-06-10T10:00:00Z", professionalId: e.gomez.id }); // lunes
    await cita(e, { ...c, start: "2030-06-10T11:00:00Z", professionalId: e.gomez.id }); // lunes
    await cita(e, { ...c, start: "2030-06-12T10:00:00Z", professionalId: e.ruiz.id, serviceId: e.laser.id, serviceName: "Láser" }); // miércoles
    const r = await informe(e, "cancelaciones", { base: "cita" });
    expect(tabla(r, "por_profesional")).toEqual([["Gómez", 2], ["Ruiz", 1]]);
    expect(tabla(r, "por_servicio")).toEqual([["Limpieza", 2], ["Láser", 1]]);
    const dias = Object.fromEntries(tabla(r, "por_dia").map((f) => [f[0], f[1]]));
    expect(dias).toMatchObject({ Lunes: 2, Miércoles: 1, Martes: 0 });
  });

  it("el día de la semana es el de la clínica, no el UTC", async () => {
    const e = await escenario("America/Mexico_City");
    // 02:00 UTC del martes 11 es el lunes 10 a las 20:00 en México.
    await cita(e, { start: "2030-06-11T02:00:00Z", status: "cancelado", cancelledByKind: "paciente", cancelledAt: "2030-06-09T10:00:00Z" });
    const r = await informe(e, "cancelaciones", { base: "cita" });
    const dias = Object.fromEntries(tabla(r, "por_dia").map((f) => [f[0], f[1]]));
    expect(dias).toMatchObject({ Lunes: 1, Martes: 0 });
  });

  it("filtra por profesional y por servicio", async () => {
    const e = await escenario();
    const c = { status: "cancelado" as const, cancelledByKind: "paciente", cancelledAt: "2030-06-09T10:00:00Z" };
    await cita(e, { ...c, start: "2030-06-10T10:00:00Z", professionalId: e.gomez.id });
    await cita(e, { ...c, start: "2030-06-10T11:00:00Z", professionalId: e.ruiz.id });
    expect(kpi(await informe(e, "cancelaciones", { base: "cita", professionalId: e.ruiz.id }), "canceladas")).toBe(1);
  });
});

describe("las reagendadas", () => {
  async function evento(e: E, over: Partial<{ occurredAt: string; actorKind: string; from: string; to: string; fromProf: string; toProf: string; cita: CitaOpts }> = {}) {
    const c = await cita(e, over.cita ?? { start: over.to ?? "2030-06-14T10:00:00Z" });
    return prisma.appointmentEvent.create({
      data: {
        clinicId: e.clinic.id, appointmentId: c.id, type: "reagendada", actorKind: over.actorKind ?? "paciente",
        occurredAt: new Date(over.occurredAt ?? "2030-06-11T10:00:00Z"),
        fromStartTime: over.from ? new Date(over.from) : null, toStartTime: over.to ? new Date(over.to) : null,
        fromProfessionalId: over.fromProf ?? e.gomez.id, toProfessionalId: over.toProf ?? e.gomez.id,
      },
    });
  }

  it("cuenta por quién, los cambios de profesional y hacia dónde se movieron", async () => {
    const e = await escenario();
    await evento(e, { actorKind: "paciente", from: "2030-06-12T10:00:00Z", to: "2030-06-14T10:00:00Z" }); // +2 días
    await evento(e, { actorKind: "usuario", from: "2030-06-15T10:00:00Z", to: "2030-06-14T10:00:00Z", toProf: e.ruiz.id }); // -1 día y otro profesional
    const r = await informe(e, "reagendadas");
    expect(kpi(r, "reagendadas")).toBe(2);
    expect(kpi(r, "por_paciente")).toBe(1);
    expect(kpi(r, "por_clinica")).toBe(1);
    expect(kpi(r, "cambio_profesional")).toBe(1);
    expect(kpi(r, "atrasadas")).toBe(1);
    expect(kpi(r, "adelantadas")).toBe(1);
    expect(kpi(r, "corrimiento")).toBe(1.5);
  });

  it("el detalle dice de qué hora a cuál y con qué profesional, y quién la movió", async () => {
    const e = await escenario();
    await evento(e, { from: "2030-06-12T10:00:00Z", to: "2030-06-14T15:30:00Z", toProf: e.ruiz.id });
    const [fila] = (await informe(e, "reagendadas")).detalle.filas;
    expect(fila).toEqual(["2030-06-11 10:00", "2030-06-12 10:00", "2030-06-14 15:30", "Gómez", "Ruiz", "El paciente (WhatsApp)", "María López", "Limpieza"]);
  });

  it("por 'cuándo se cambió' o por el día de la cita", async () => {
    const e = await escenario();
    // Se cambió el 11 (dentro), pero la cita quedó para el 30 (fuera).
    await evento(e, { occurredAt: "2030-06-11T10:00:00Z", to: "2030-06-30T10:00:00Z" });
    expect(kpi(await informe(e, "reagendadas", { base: "evento" }), "reagendadas")).toBe(1);
    expect(kpi(await informe(e, "reagendadas", { base: "cita" }), "reagendadas")).toBe(0);
  });

  it("sin eventos lo dice, y con eventos avisa desde cuándo hay datos", async () => {
    const e = await escenario();
    expect((await informe(e, "reagendadas")).notas.join(" ")).toContain("Todavía no hay reagendados");
    await evento(e, { to: "2030-06-14T10:00:00Z" });
    const r = await informe(e, "reagendadas");
    expect(r.desdeDatos).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.notas.join(" ")).toContain("no se guardaba y no se puede recuperar");
  });

  it("no mezcla clínicas", async () => {
    const e = await escenario();
    const otra = await escenario();
    await evento(otra, { to: "2030-06-14T10:00:00Z" });
    expect(kpi(await informe(e, "reagendadas"), "reagendadas")).toBe(0);
  });
});

describe("los atendidos por profesional", () => {
  it("separa lo confirmado por una persona de lo que dio por atendido el sistema, y cuenta pacientes distintos", async () => {
    const e = await escenario();
    // Gómez: María vino dos veces (una confirmada, una automática) y Juan una (confirmada).
    await cita(e, { start: "2030-06-10T10:00:00Z", status: "atendido", attendedAt: "2030-06-10T10:30:00Z", patientId: e.maria.id });
    await cita(e, { start: "2030-06-11T10:00:00Z", status: "atendido", patientId: e.maria.id });
    await cita(e, { start: "2030-06-11T11:00:00Z", status: "atendido", attendedAt: "2030-06-11T11:30:00Z", patientId: e.juan.id });
    // Ruiz: Juan, automática.
    await cita(e, { start: "2030-06-10T12:00:00Z", status: "atendido", professionalId: e.ruiz.id, patientId: e.juan.id });

    const r = await informe(e, "atendidos");
    expect(kpi(r, "atendidas")).toBe(4);
    expect(kpi(r, "pacientes")).toBe(2);
    expect(kpi(r, "confirmadas")).toBe(2);
    expect(kpi(r, "automaticas")).toBe(2);
    // [profesional, confirmadas, automáticas, total, pacientes distintos]
    expect(tabla(r, "por_profesional")).toEqual([["Gómez", 2, 1, 3, 2], ["Ruiz", 0, 1, 1, 1]]);
  });

  it("una asistencia que se deshizo ya no cuenta", async () => {
    const e = await escenario();
    // Desmarcada: la cita vuelve a 'confirmado'.
    await cita(e, { start: "2030-06-10T10:00:00Z", status: "confirmado" });
    expect(kpi(await informe(e, "atendidos"), "atendidas")).toBe(0);
  });

  it("el detalle dice si la confirmó una persona", async () => {
    const e = await escenario();
    await cita(e, { start: "2030-06-10T10:00:00Z", status: "atendido", attendedAt: "2030-06-10T10:30:00Z" });
    await cita(e, { start: "2030-06-10T11:00:00Z", status: "atendido" });
    const filas = (await informe(e, "atendidos")).detalle.filas.map((f) => f[4]);
    expect(filas).toEqual(expect.arrayContaining(["Sí, la confirmó una persona", "No, la dio por atendida el sistema"]));
  });

  it("filtra por profesional y por servicio, y no mezcla clínicas", async () => {
    const e = await escenario();
    const otra = await escenario();
    await cita(otra, { start: "2030-06-10T10:00:00Z", status: "atendido" });
    await cita(e, { start: "2030-06-10T10:00:00Z", status: "atendido", professionalId: e.ruiz.id, serviceId: e.laser.id, serviceName: "Láser" });
    await cita(e, { start: "2030-06-10T11:00:00Z", status: "atendido" });
    expect(kpi(await informe(e, "atendidos"), "atendidas")).toBe(2);
    expect(kpi(await informe(e, "atendidos", { professionalId: e.ruiz.id }), "atendidas")).toBe(1);
    expect(kpi(await informe(e, "atendidos", { serviceId: e.laser.id }), "atendidas")).toBe(1);
  });
});

describe("las citas sin confirmar", () => {
  it("lista las pasadas que nadie marcó ni canceló, y deja afuera lo demás", async () => {
    const e = await escenario();
    await cita(e, { start: "2030-06-10T10:00:00Z" }); // sin confirmar, hace 2 días
    await cita(e, { start: "2030-06-11T10:00:00Z", professionalId: e.ruiz.id }); // sin confirmar
    await cita(e, { start: "2030-06-10T11:00:00Z", status: "atendido" });
    await cita(e, { start: "2030-06-10T12:00:00Z", status: "cancelado" });
    await cita(e, { start: "2030-06-15T10:00:00Z" }); // todavía no pasó
    const r = await informe(e, "sin-confirmar");
    expect(kpi(r, "sin_confirmar")).toBe(2);
    expect(tabla(r, "por_profesional")).toEqual([["Gómez", 1], ["Ruiz", 1]]);
    expect(r.detalle.filas.map((f) => f[4]).sort()).toEqual([1, 2]); // días desde la cita
  });

  it("marca las que llevan más de 7 días", async () => {
    const e = await escenario();
    const r = await buildReport({
      kind: "sin-confirmar",
      clinic: e.clinic,
      filters: filtros(e, { desde: "2030-05-01", hasta: "2030-06-16" }),
      now: AHORA,
    });
    expect(kpi(r, "mas_de_7_dias")).toBe(0);
    await cita(e, { start: "2030-06-01T10:00:00Z" });
    const r2 = await buildReport({ kind: "sin-confirmar", clinic: e.clinic, filters: filtros(e, { desde: "2030-05-01", hasta: "2030-06-16" }), now: AHORA });
    expect(kpi(r2, "mas_de_7_dias")).toBe(1);
  });
});

describe("el CSV", () => {
  it("lleva el BOM de UTF-8 para que Excel muestre bien los acentos", () => {
    expect(toCsv(["a"], [["ñ"]]).charCodeAt(0)).toBe(0xfeff);
  });

  it("escapa comas, comillas y saltos de línea dentro de una celda", () => {
    expect(csvCell('hola, "mundo"')).toBe('"hola, ""mundo"""');
    expect(csvCell("línea 1\nlínea 2")).toBe('"línea 1\nlínea 2"');
    expect(csvCell("simple")).toBe("simple");
    expect(csvCell(null)).toBe("");
  });

  it("neutraliza las celdas que Excel leería como fórmula (viene de lo que escribió un paciente)", () => {
    expect(neutralizeFormula("=HYPERLINK(\"http://x\")")).toBe("'=HYPERLINK(\"http://x\")");
    expect(csvCell("+54 9 11")).toBe("'+54 9 11");
    expect(csvCell("-1+1")).toBe("'-1+1");
    expect(csvCell("@usuario")).toBe("'@usuario");
    // Un número negativo es un número, no una fórmula.
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell("María")).toBe("María");
  });

  it("el CSV de un reporte es su detalle, con sus encabezados", async () => {
    const e = await escenario();
    await cita(e, {
      start: "2030-06-10T10:00:00Z", status: "cancelado", cancelledByKind: "paciente", cancelledAt: "2030-06-09T10:00:00Z",
      cancelReason: "=cmd|' /C calc'!A0, y más",
    });
    const csv = reportToCsv(await informe(e, "cancelaciones", { base: "cita" }));
    const [encabezado, fila] = csv.slice(1).split("\r\n");
    expect(encabezado).toBe("Cuándo se canceló,Día de la cita,Paciente,Servicio,Profesional,Quién canceló,Motivo,Queja,Horas de aviso");
    // El motivo malicioso quedó neutralizado y entre comillas.
    expect(fila).toContain(`"'=cmd|' /C calc'!A0, y más"`);
    expect(fila).not.toMatch(/,=cmd/);
  });

  it("el resumen no tiene detalle: se exporta como indicadores", async () => {
    const e = await escenario();
    await cita(e, { start: "2030-06-10T10:00:00Z", status: "cancelado", cancelledByKind: "paciente" });
    const csv = reportToCsv(await informe(e, "resumen"));
    expect(csv).toContain("Indicador,Valor");
    expect(csv).toContain("Tasa de cancelación,100%");
  });
});

describe("la API", () => {
  async function conUsuario(e: E, opts?: { sinPermisos?: boolean }) {
    const adminRole = await ensureClinicAdminRole(e.clinic.id);
    const rol = opts?.sinPermisos ? await prisma.role.create({ data: { clinicId: e.clinic.id, name: "Sin permisos" } }) : adminRole;
    const user = await prisma.user.create({
      data: {
        clinicId: e.clinic.id, email: `rep-${Math.random().toString(36).slice(2)}@reportes.test`, name: "Ana Reportes",
        passwordHash: await hashPassword("x-x-x-x-x-x"), roles: { create: [{ roleId: rol.id }] },
      },
    });
    userIds.push(user.id);
    return { user, cookie: `${SESSION_COOKIE_NAME}=${signSession({ userId: user.id, clinicId: e.clinic.id })}` };
  }

  const get = async (path: string, cookie?: string) => {
    const r = await fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} });
    const buffer = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, headers: r.headers, bytes: buffer, texto: new TextDecoder().decode(buffer) };
  };
  const esperarFila = async (where: object) => {
    for (let i = 0; i < 60; i++) {
      const f = await prisma.auditLog.findFirst({ where, orderBy: { occurredAt: "desc" } });
      if (f) return f;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  };

  it("devuelve el reporte en JSON con indicadores, tablas y detalle", async () => {
    const e = await escenario();
    const { cookie } = await conUsuario(e);
    await cita(e, { start: "2030-06-10T10:00:00Z", status: "cancelado", cancelledByKind: "paciente", cancelledAt: "2030-06-09T10:00:00Z" });
    const r = await get(`/dashboard/clinics/${e.clinic.id}/reports/cancelaciones?desde=2030-06-10&hasta=2030-06-16&base=cita`, cookie);
    expect(r.status).toBe(200);
    const json = JSON.parse(r.texto);
    expect(json).toMatchObject({ informe: "cancelaciones", periodo: { desde: "2030-06-10", hasta: "2030-06-16", base: "cita" } });
    expect(json.kpis.find((k: { clave: string }) => k.clave === "canceladas").valor).toBe(1);
    expect(json.detalle.total).toBe(1);
  });

  it("sin el permiso, 403; sin sesión, 401; de otra clínica, 403", async () => {
    const e = await escenario();
    const otra = await escenario();
    const sin = await conUsuario(e, { sinPermisos: true });
    const deOtra = await conUsuario(otra);
    const ruta = `/dashboard/clinics/${e.clinic.id}/reports/resumen`;
    expect((await get(ruta, sin.cookie)).status).toBe(403);
    expect((await get(ruta)).status).toBe(401);
    expect((await get(ruta, deOtra.cookie)).status).toBe(403);
  });

  it("un reporte que no existe: 404; fechas que no se entienden: 400", async () => {
    const e = await escenario();
    const { cookie } = await conUsuario(e);
    expect((await get(`/dashboard/clinics/${e.clinic.id}/reports/inventado`, cookie)).status).toBe(404);
    const r = await get(`/dashboard/clinics/${e.clinic.id}/reports/resumen?desde=2030-02-31`, cookie);
    expect(r.status).toBe(400);
    expect(JSON.parse(r.texto).error).toContain("fechas");
  });

  it("?formato=csv descarga el detalle con el tipo y el nombre de archivo correctos", async () => {
    const e = await escenario();
    const { cookie } = await conUsuario(e);
    await cita(e, { start: "2030-06-10T10:00:00Z", status: "cancelado", cancelledByKind: "paciente", cancelledAt: "2030-06-09T10:00:00Z" });
    const r = await get(`/dashboard/clinics/${e.clinic.id}/reports/cancelaciones?desde=2030-06-10&hasta=2030-06-16&base=cita&formato=csv`, cookie);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/csv");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="reporte-cancelaciones-2030-06-10-2030-06-16.csv"');
    // `fetch().text()` descarta el BOM al decodificar: se verifica en los bytes.
    expect([...r.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(r.texto).toContain("María López");
  });

  it("las opciones de los filtros traen los profesionales y servicios de la clínica", async () => {
    const e = await escenario();
    const { cookie } = await conUsuario(e);
    const r = JSON.parse((await get(`/dashboard/clinics/${e.clinic.id}/reports/options`, cookie)).texto);
    expect(r.profesionales.map((p: { name: string }) => p.name)).toEqual(["Gómez", "Ruiz"]);
    expect(r.servicios.map((s: { name: string }) => s.name)).toEqual(["Láser", "Limpieza"]);
  });

  it("ver un reporte queda en la auditoría, con los parámetros y SIN los datos que muestra", async () => {
    const e = await escenario();
    const { cookie, user } = await conUsuario(e);
    await cita(e, { start: "2030-06-10T10:00:00Z", status: "cancelado", cancelledByKind: "paciente", cancelledAt: "2030-06-09T10:00:00Z", cancelReason: "MOTIVO-CLINICO-QUE-NO-DEBE-QUEDAR" });
    await get(`/dashboard/clinics/${e.clinic.id}/reports/cancelaciones?desde=2030-06-10&hasta=2030-06-16&base=cita&professionalId=${e.gomez.id}`, cookie);
    const fila = await esperarFila({ userId: user.id, action: "report.view" });
    expect(fila).toMatchObject({ origin: "panel", outcome: "ok", clinicId: e.clinic.id });
    expect(fila?.details).toMatchObject({
      reporte: "cancelaciones", formato: "pantalla", desde: "2030-06-10", hasta: "2030-06-16", base: "cita", filtraPorProfesional: true,
    });
    const todo = JSON.stringify(fila);
    for (const secreto of ["María López", "MOTIVO-CLINICO-QUE-NO-DEBE-QUEDAR", e.gomez.id]) expect(todo).not.toContain(secreto);
  });

  it("exportar queda como una acción distinta", async () => {
    const e = await escenario();
    const { cookie, user } = await conUsuario(e);
    await get(`/dashboard/clinics/${e.clinic.id}/reports/resumen?formato=csv`, cookie);
    const fila = await esperarFila({ userId: user.id, action: "report.export" });
    expect(fila?.details).toMatchObject({ reporte: "resumen", formato: "csv" });
  });
});


describe("la ocupación de espacios y equipos", () => {
  /** Lunes a viernes de 09:00 a 13:00: 240 minutos abiertos por día. */
  async function conHorario(e: E) {
    for (const weekday of ["lunes", "martes", "miercoles", "jueves", "viernes"] as const) {
      await prisma.workingHours.create({ data: { clinicId: e.clinic.id, weekday, startMinute: 540, endMinute: 780 } });
    }
  }
  const fila = (r: Awaited<ReturnType<typeof informe>>, clave: string, nombre: string) => tabla(r, clave).find((f) => f[0] === nombre)?.[1];

  it("mide el tiempo con cita sobre el tiempo abierto, y deja ver los espacios vacíos", async () => {
    const e = await escenario();
    await conHorario(e);
    const vacio = await prisma.room.create({ data: { clinicId: e.clinic.id, name: "Sala 2" } });
    // Lun 10, mar 11 y mié 12 (hasta las 12:00 UTC): 240 + 240 + 180 = 660 minutos abiertos.
    await cita(e, { start: "2030-06-10T09:00:00Z" });
    await cita(e, { start: "2030-06-11T10:00:00Z" });
    await cita(e, { start: "2030-06-12T10:00:00Z" });
    const r = await informe(e, "ocupacion");

    expect(fila(r, "uso_espacios", "Sala 1")).toBe(13.6); // 90 / 660
    expect(fila(r, "uso_espacios", "Sala 2")).toBe(0);
    expect(tabla(r, "uso_espacios").map((f) => f[0])).toEqual(["Sala 1", "Sala 2"]); // de más a menos usado
    expect(kpi(r, "espacios_sin_uso")).toBe(1);
    expect(kpi(r, "espacios_en_uso")).toBe(1);
    expect(kpi(r, "citas")).toBe(3);
    expect(kpi(r, "ocupacion")).toBe(6.8); // 90 / (660 × 2)
    expect(kpi(r, "horas_libres")).toBe(Math.round(((660 * 2 - 90) / 60) * 10) / 10);
    // El detalle trae días con citas y días abiertos sin citas.
    const det = r.detalle.filas.find((x) => x[0] === "Sala 1")!;
    expect(det.slice(2, 3)).toEqual([3]);
    expect(det[7]).toBe(3);
    expect(det[8]).toBe(0);
    expect(r.detalle.filas.find((x) => x[0] === vacio.name)![8]).toBe(3);
  });

  it("no cuenta lo que todavía no pasó ni las canceladas", async () => {
    const e = await escenario();
    await conHorario(e);
    await cita(e, { start: "2030-06-10T09:00:00Z" });
    await cita(e, { start: "2030-06-11T09:00:00Z", status: "cancelado", cancelledByKind: "paciente" });
    await cita(e, { start: "2030-06-14T09:00:00Z" }); // el viernes: todavía no llegó
    const r = await informe(e, "ocupacion");
    expect(kpi(r, "citas")).toBe(1);
    expect(fila(r, "uso_espacios", "Sala 1")).toBe(4.5); // 30 / 660
  });

  it("un feriado no cuenta como capacidad perdida", async () => {
    const e = await escenario();
    await conHorario(e);
    await prisma.scheduleException.create({ data: { clinicId: e.clinic.id, date: new Date("2030-06-11T00:00:00Z"), reason: "Feriado" } });
    await cita(e, { start: "2030-06-10T09:00:00Z" });
    const r = await informe(e, "ocupacion");
    expect(fila(r, "uso_espacios", "Sala 1")).toBe(7.1); // 30 / 420 (sin el martes)
  });

  it("separa los equipos y los muestra solo si la clínica tiene", async () => {
    const e = await escenario();
    await conHorario(e);
    expect(tabla(await informe(e, "ocupacion"), "uso_espacios")).toHaveLength(1);
    expect((await informe(e, "ocupacion")).tablas.some((t) => t.clave === "uso_equipos")).toBe(false);

    const laser = await prisma.resource.create({ data: { clinicId: e.clinic.id, name: "Láser 1", type: "laser" } });
    await prisma.resource.create({ data: { clinicId: e.clinic.id, name: "Láser 2", type: "laser" } });
    await cita(e, { start: "2030-06-10T09:00:00Z", resourceId: laser.id });
    const r = await informe(e, "ocupacion");
    expect(fila(r, "uso_equipos", "Láser 1")).toBe(4.5);
    expect(fila(r, "uso_equipos", "Láser 2")).toBe(0);
  });

  it("reparte el uso por día de la semana y por franja horaria, solo donde hay capacidad", async () => {
    const e = await escenario();
    await conHorario(e);
    await cita(e, { start: "2030-06-10T09:00:00Z" }); // lunes 9:00-9:30
    const r = await informe(e, "ocupacion");
    expect(tabla(r, "uso_por_dia").map((f) => f[0])).toEqual(["Lunes", "Martes", "Miércoles"]); // jueves y viernes no llegaron
    expect(fila(r, "uso_por_dia", "Lunes")).toBe(12.5); // 30 / 240
    expect(fila(r, "uso_por_dia", "Martes")).toBe(0);
    expect(tabla(r, "uso_por_hora").map((f) => f[0])).toEqual(["09:00", "10:00", "11:00", "12:00"]);
    expect(fila(r, "uso_por_hora", "09:00")).toBe(16.7); // 30 / (60 × 3 días)
    expect(fila(r, "uso_por_hora", "10:00")).toBe(0);
  });

  it("sin horario cargado no inventa capacidad: lo dice", async () => {
    const e = await escenario();
    await cita(e, { start: "2030-06-10T09:00:00Z" });
    const r = await informe(e, "ocupacion");
    expect(kpi(r, "ocupacion")).toBeNull();
    expect(r.notas.join(" ")).toMatch(/no tiene horario/);
  });

  it("un período que todavía no empezó no revienta", async () => {
    const e = await escenario();
    await conHorario(e);
    const r = await informe(e, "ocupacion", { desde: "2030-06-17", hasta: "2030-06-21" });
    expect(kpi(r, "citas")).toBe(0);
    expect(kpi(r, "ocupacion")).toBeNull();
  });

  it("el filtro por profesional mide el uso de los espacios por esas citas", async () => {
    const e = await escenario();
    await conHorario(e);
    await cita(e, { start: "2030-06-10T09:00:00Z", professionalId: e.gomez.id });
    await cita(e, { start: "2030-06-10T10:00:00Z", professionalId: e.ruiz.id });
    expect(fila(await informe(e, "ocupacion", { professionalId: e.ruiz.id }), "uso_espacios", "Sala 1")).toBe(4.5);
  });

  it("un espacio desactivado solo aparece si tuvo citas", async () => {
    const e = await escenario();
    await conHorario(e);
    const apagada = await prisma.room.create({ data: { clinicId: e.clinic.id, name: "Sala vieja", active: false } });
    expect(tabla(await informe(e, "ocupacion"), "uso_espacios").map((f) => f[0])).toEqual(["Sala 1"]);
    await cita(e, { start: "2030-06-10T09:00:00Z", roomId: apagada.id });
    const r = await informe(e, "ocupacion");
    expect(tabla(r, "uso_espacios").map((f) => f[0])).toContain("Sala vieja");
    expect(r.detalle.filas.find((x) => x[0] === "Sala vieja")![1]).toBe("Desactivado");
  });

  it("existe como reporte de la API y se exporta a CSV", async () => {
    const e = await escenario();
    await conHorario(e);
    await cita(e, { start: "2030-06-10T09:00:00Z" });
    const csv = reportToCsv(await informe(e, "ocupacion"));
    expect(csv).toContain("Espacio,Estado,Citas");
    expect(csv).toContain("Sala 1");
  });
});


describe("los tiempos muertos y la productividad", () => {
  async function lunes(e: E) {
    await prisma.workingHours.create({ data: { clinicId: e.clinic.id, weekday: "lunes", startMinute: 540, endMinute: 780 } });
  }
  const soloLunes = { desde: "2030-06-10", hasta: "2030-06-10" };
  const celda = (r: Awaited<ReturnType<typeof informe>>, clave: string, nombre: string) => tabla(r, clave).find((f) => f[0] === nombre);

  it("separa las horas libres aprovechables de las sueltas, y da el hueco más largo", async () => {
    const e = await escenario();
    await lunes(e); // 09:00-13:00 = 240 min; el servicio más corto dura 30
    await cita(e, { start: "2030-06-10T09:00:00Z" }); // 09:00-09:30
    await cita(e, { start: "2030-06-10T09:40:00Z" }); // 09:40-10:10: deja 10 min sueltos antes
    const r = await informe(e, "ocupacion", soloLunes);
    const det = r.detalle.filas.find((x) => x[0] === "Sala 1")!;
    expect(det[9]).toBe(2.8); // 170 min aprovechables (10:10-13:00); los 10 de antes no entran
    expect(det[10]).toBe(170); // el hueco más largo
    expect(kpi(r, "horas_aprovechables")).toBe(2.8);
    expect(r.notas.join(" ")).toMatch(/30 min/);
  });

  it("un espacio sin citas tiene todo el horario como hueco aprovechable", async () => {
    const e = await escenario();
    await lunes(e);
    const r = await informe(e, "ocupacion", soloLunes);
    const det = r.detalle.filas.find((x) => x[0] === "Sala 1")!;
    expect(det[9]).toBe(4);
    expect(det[10]).toBe(240);
  });

  it("el mapa de calor cruza día y hora, y deja vacío lo que estaba cerrado", async () => {
    const e = await escenario();
    await lunes(e);
    await cita(e, { start: "2030-06-10T09:00:00Z" });
    await cita(e, { start: "2030-06-10T09:40:00Z" });
    const t = (await informe(e, "ocupacion", soloLunes)).tablas.find((x) => x.clave === "mapa_calor")!;
    expect(t.visual).toBe("calor");
    expect(t.columnas).toEqual(["Día", "09:00", "10:00", "11:00", "12:00"]);
    expect(t.filas).toEqual([["Lunes", 83.3, 16.7, 0, 0]]); // 09:00: 30 + 20 de 60; 10:00: 10 de 60
  });

  it("mide a cada profesional contra SU horario, y el que no tiene propio hereda el de la clínica", async () => {
    const e = await escenario();
    await lunes(e);
    // Ruiz solo trabaja de 09:00 a 11:00 (120 min); Gómez no tiene horario propio: hereda 240.
    await prisma.workingHours.create({ data: { clinicId: e.clinic.id, professionalId: e.ruiz.id, weekday: "lunes", startMinute: 540, endMinute: 660 } });
    await cita(e, { start: "2030-06-10T09:00:00Z", professionalId: e.gomez.id });
    await cita(e, { start: "2030-06-10T09:30:00Z", professionalId: e.gomez.id });
    await cita(e, { start: "2030-06-10T10:00:00Z", professionalId: e.ruiz.id });
    const r = await informe(e, "ocupacion", soloLunes);
    expect(celda(r, "uso_profesionales", "Gómez")?.[1]).toBe(25); // 60 / 240
    expect(celda(r, "uso_profesionales", "Ruiz")?.[1]).toBe(25); // 30 / 120
    expect(celda(r, "horas_profesionales", "Ruiz")).toEqual(["Ruiz", 1, 0.5, 2, 1.5, 25]);
  });

  it("el filtro por profesional deja solo a ese profesional", async () => {
    const e = await escenario();
    await lunes(e);
    const r = await informe(e, "ocupacion", { ...soloLunes, professionalId: e.ruiz.id });
    expect(tabla(r, "uso_profesionales").map((f) => f[0])).toEqual(["Ruiz"]);
  });
});

describe("pacientes nuevos, recurrentes y los que no volvieron", () => {
  async function ana(e: E) {
    return prisma.patient.create({ data: { clinicId: e.clinic.id, phone: "5491100000003", name: "Ana Soto" } });
  }

  it("nuevo es el que tiene su primera cita en el período; recurrente, el que ya había venido", async () => {
    const e = await escenario();
    const a = await ana(e);
    await cita(e, { start: "2030-06-10T10:00:00Z", patientId: e.juan.id }); // Juan: primera vez
    await cita(e, { start: "2030-04-01T10:00:00Z", patientId: a.id, status: "atendido" });
    await cita(e, { start: "2030-06-11T10:00:00Z", patientId: a.id, status: "atendido" }); // Ana ya había venido
    await cita(e, { start: "2030-06-10T11:00:00Z", patientId: e.maria.id, status: "cancelado", cancelledByKind: "paciente" }); // solo canceló: no cuenta
    const r = await informe(e, "pacientes");
    expect(kpi(r, "pacientes_periodo")).toBe(2);
    expect(kpi(r, "nuevos")).toBe(1);
    expect(kpi(r, "recurrentes")).toBe(1);
    expect(kpi(r, "tasa_recurrentes")).toBe(50);
  });

  it("los que no volvieron: última visita cumplida de hace 60 días o más y sin cita futura", async () => {
    const e = await escenario();
    const a = await ana(e);
    await cita(e, { start: "2030-03-01T10:00:00Z", patientId: e.maria.id, status: "atendido" }); // 103 días
    await cita(e, { start: "2029-11-01T10:00:00Z", patientId: e.juan.id, attendedAt: "2029-11-01T11:00:00Z", status: "confirmado" }); // 223 días, marcada por una persona
    await cita(e, { start: "2030-05-20T10:00:00Z", patientId: a.id, status: "atendido" }); // 23 días: todavía no
    const r = await informe(e, "pacientes");
    expect(kpi(r, "sin_volver")).toBe(2);
    expect(kpi(r, "sin_volver_90")).toBe(2);
    expect(kpi(r, "sin_volver_180")).toBe(1);
    // Los más recientes primero: son los más fáciles de recuperar.
    expect(r.detalle.filas.map((f) => f[0])).toEqual(["María López", "Juan Pérez"]);
    expect(r.detalle.filas[0].slice(2, 5)).toEqual(["2030-03-01", 103, "3 a 6 meses"]);
    expect(tabla(r, "sin_volver_por_tramo")).toEqual([["2 a 3 meses", 0], ["3 a 6 meses", 1], ["6 meses o más", 1]]);
  });

  it("quien ya tiene una cita futura no es alguien a quien contactar", async () => {
    const e = await escenario();
    await cita(e, { start: "2030-03-01T10:00:00Z", patientId: e.maria.id, status: "atendido" });
    await cita(e, { start: "2030-07-01T10:00:00Z", patientId: e.maria.id }); // ya volvió a sacar turno
    expect(kpi(await informe(e, "pacientes"), "sin_volver")).toBe(0);
  });

  it("la lista dice si el paciente está marcado como 'no contactar', y la próxima cita sugerida", async () => {
    const e = await escenario();
    await prisma.patient.update({ where: { id: e.maria.id }, data: { outreachOptOut: true, suggestedNextVisitDate: new Date("2030-07-15T00:00:00Z") } });
    await cita(e, { start: "2030-03-01T10:00:00Z", patientId: e.maria.id, status: "atendido" });
    const fila = (await informe(e, "pacientes")).detalle.filas[0];
    expect(fila.slice(5)).toEqual(["2030-07-15", "Sí"]);
  });

  it("no usa los filtros de profesional y servicio, y lo dice", async () => {
    const e = await escenario();
    await cita(e, { start: "2030-03-01T10:00:00Z", patientId: e.maria.id, status: "atendido", professionalId: e.gomez.id });
    const r = await informe(e, "pacientes", { professionalId: e.ruiz.id });
    expect(kpi(r, "sin_volver")).toBe(1);
    expect(r.notas.join(" ")).toMatch(/no usa el período ni los filtros/);
  });

  it("se exporta a CSV con la lista de contacto", async () => {
    const e = await escenario();
    await cita(e, { start: "2030-03-01T10:00:00Z", patientId: e.maria.id, status: "atendido" });
    const csv = reportToCsv(await informe(e, "pacientes"));
    expect(csv).toContain("Paciente,Teléfono,Última visita");
    expect(csv).toContain("María López");
  });
});


describe("origen de las reservas", () => {
  async function usuario(e: E, name: string) {
    const u = await prisma.user.create({ data: { clinicId: e.clinic.id, email: `o-${Math.random().toString(36).slice(2)}@reportes.test`, name, passwordHash: "x" } });
    userIds.push(u.id);
    return u;
  }
  async function conHorario(e: E) {
    for (const weekday of ["lunes", "martes", "miercoles", "jueves", "viernes"] as const) {
      await prisma.workingHours.create({ data: { clinicId: e.clinic.id, weekday, startMinute: 540, endMinute: 780 } });
    }
  }

  it("con un usuario detrás es del panel; sin usuario, del asistente de WhatsApp", async () => {
    const e = await escenario();
    const ana = await usuario(e, "Ana Recepción");
    await cita(e, { start: "2030-06-13T10:00:00Z", createdAt: "2030-06-10T10:00:00Z" });
    await cita(e, { start: "2030-06-13T11:00:00Z", createdAt: "2030-06-10T11:00:00Z" });
    await cita(e, { start: "2030-06-13T12:00:00Z", createdAt: "2030-06-11T10:00:00Z", createdByUserId: ana.id });
    const r = await informe(e, "origen");
    expect(kpi(r, "reservas")).toBe(3);
    expect(kpi(r, "whatsapp")).toBe(2);
    expect(kpi(r, "panel")).toBe(1);
    expect(kpi(r, "pct_whatsapp")).toBe(66.7);
    expect(tabla(r, "por_persona")).toEqual([["Ana Recepción", 1]]);
    expect(tabla(r, "por_semana")).toEqual([["2030-06-10", 2, 1, 3]]);
  });

  it("no cuenta como reserva nueva la cita que es un reagendado", async () => {
    const e = await escenario();
    const vieja = await cita(e, { start: "2030-06-13T10:00:00Z", createdAt: "2030-06-01T10:00:00Z", status: "cancelado", cancelledByKind: "reprogramacion" });
    await cita(e, { start: "2030-06-14T10:00:00Z", createdAt: "2030-06-10T10:00:00Z", rescheduledFromId: vieja.id });
    expect(kpi(await informe(e, "origen"), "reservas")).toBe(0);
  });

  it("el período es el de la reserva, no el de la cita", async () => {
    const e = await escenario();
    await cita(e, { start: "2030-07-20T10:00:00Z", createdAt: "2030-06-11T10:00:00Z" }); // reservada en el período para dentro de un mes
    await cita(e, { start: "2030-06-12T10:00:00Z", createdAt: "2030-05-01T10:00:00Z" }); // de ahora, pero reservada antes
    expect(kpi(await informe(e, "origen"), "reservas")).toBe(1);
  });

  it("cuenta las que el asistente tomó con la clínica cerrada", async () => {
    const e = await escenario();
    await conHorario(e); // lunes a viernes 09:00-13:00
    await cita(e, { start: "2030-06-13T10:00:00Z", createdAt: "2030-06-10T10:00:00Z" }); // lunes 10:00: abierta
    await cita(e, { start: "2030-06-13T11:00:00Z", createdAt: "2030-06-10T20:00:00Z" }); // lunes 20:00: cerrada
    await cita(e, { start: "2030-06-13T12:00:00Z", createdAt: "2030-06-15T10:00:00Z" }); // sábado: cerrada
    expect(kpi(await informe(e, "origen"), "fuera_de_horario")).toBe(2);
  });

  it("sin horario cargado no puede decir cuántas fueron con la clínica cerrada", async () => {
    const e = await escenario();
    await cita(e, { start: "2030-06-13T10:00:00Z", createdAt: "2030-06-10T10:00:00Z" });
    expect(kpi(await informe(e, "origen"), "fuera_de_horario")).toBeNull();
  });

  it("la tasa de cancelación se separa por origen", async () => {
    const e = await escenario();
    await cita(e, { start: "2030-06-13T10:00:00Z", createdAt: "2030-06-10T10:00:00Z", status: "cancelado", cancelledByKind: "paciente" });
    await cita(e, { start: "2030-06-13T11:00:00Z", createdAt: "2030-06-10T10:00:00Z" });
    const r = await informe(e, "origen");
    expect(kpi(r, "cancel_whatsapp")).toBe(50);
    expect(kpi(r, "cancel_panel")).toBeNull();
  });
});

describe("servicios más pedidos", () => {
  it("cuenta, ordena y calcula cancelación y horas por servicio", async () => {
    const e = await escenario();
    await cita(e, { start: "2030-06-10T10:00:00Z" });
    await cita(e, { start: "2030-06-10T11:00:00Z", status: "atendido" });
    await cita(e, { start: "2030-06-10T12:00:00Z", status: "cancelado", cancelledByKind: "paciente" });
    await cita(e, { start: "2030-06-11T10:00:00Z", serviceName: "Láser", serviceId: e.laser.id });
    const r = await informe(e, "servicios");
    expect(kpi(r, "citas")).toBe(4);
    expect(tabla(r, "mas_pedidos")).toEqual([["Limpieza", 3], ["Láser", 1]]);
    expect(r.detalle.filas[0]).toEqual(["Limpieza", 3, 75, 1, 1, 33.3, 1]); // 2 vigentes de 30 min = 1 h
  });

  it("no cuenta las citas que el paciente movió", async () => {
    const e = await escenario();
    await cita(e, { start: "2030-06-10T10:00:00Z", status: "cancelado", cancelledByKind: "reprogramacion" });
    expect(kpi(await informe(e, "servicios"), "citas")).toBe(0);
  });

  it("avisa de los servicios del catálogo que nadie agendó", async () => {
    const e = await escenario();
    await prisma.service.create({ data: { clinicId: e.clinic.id, name: "Ortodoncia", durationMinutes: 30 } });
    await cita(e, { start: "2030-06-10T10:00:00Z" });
    const r = await informe(e, "servicios");
    expect(tabla(r, "sin_citas").map((f) => f[0]).sort()).toEqual(["Láser", "Ortodoncia"]);
    expect(kpi(r, "servicios_sin_citas")).toBe(2);
  });

  it("muestra la demanda que no se pudo agendar: lo que pidieron y la clínica no ofrece", async () => {
    const e = await escenario();
    const evento = (nombre: string, quando: string) =>
      prisma.systemEvent.create({ data: { clinicId: e.clinic.id, kind: "servicio_sin_match", severity: "warning", message: `El modelo devolvió "${nombre}", que no figura en el catálogo.`, createdAt: new Date(quando) } });
    await evento("Masaje", "2030-06-10T10:00:00Z");
    await evento("masaje", "2030-06-11T10:00:00Z");
    await evento("Depilación", "2030-06-11T11:00:00Z");
    await evento("Fuera del período", "2030-05-01T10:00:00Z");
    const r = await informe(e, "servicios");
    expect(kpi(r, "pedidos_sin_agendar")).toBe(3);
    expect(tabla(r, "pedidos_sin_match")).toEqual([["masaje", 2], ["depilación", 1]]);
  });
});

describe("derivaciones a una persona", () => {
  const MENSAJE_SECRETO = "ME DUELE MUCHO LA MUELA Y TENGO DIABETES";
  async function derivacion(e: E, o: { reason: "urgencia" | "consulta_clinica" | "otro"; at: string; resolved?: string; mail?: boolean; name?: string }) {
    return prisma.escalation.create({
      data: {
        clinicId: e.clinic.id, patientPhone: "5491100000009", patientName: o.name ?? "Paciente Uno", reason: o.reason,
        patientMessage: MENSAJE_SECRETO, summary: `Resumen: ${MENSAJE_SECRETO}`,
        createdAt: new Date(o.at), resolvedAt: o.resolved ? new Date(o.resolved) : null, notifiedByEmail: o.mail ?? true,
      },
    });
  }

  it("cuenta, mide el tiempo de atención y señala las pendientes que no llegaron a nadie", async () => {
    const e = await escenario();
    await derivacion(e, { reason: "urgencia", at: "2030-06-10T12:00:00Z", resolved: "2030-06-10T12:30:00Z" });
    await derivacion(e, { reason: "consulta_clinica", at: "2030-06-10T12:00:00Z", resolved: "2030-06-10T17:00:00Z" });
    await derivacion(e, { reason: "otro", at: "2030-06-10T12:00:00Z", mail: false });
    const r = await informe(e, "derivaciones");
    expect(kpi(r, "derivaciones")).toBe(3);
    expect(kpi(r, "pendientes")).toBe(1);
    expect(kpi(r, "atendidas")).toBe(2);
    expect(kpi(r, "horas_media")).toBe(2.8); // (0,5 + 5) / 2
    expect(kpi(r, "mas_vieja")).toBe(2);
    expect(kpi(r, "sin_avisar")).toBe(1);
    expect(tabla(r, "por_motivo")).toEqual([["Urgencia", 1], ["Consulta clínica", 1], ["Otro motivo", 1]]);
    expect(tabla(r, "tiempo_de_atencion").map((f) => f[1])).toEqual([1, 0, 1, 0, 1]);
  });

  it("no incluye el mensaje del paciente ni el resumen", async () => {
    const e = await escenario();
    await derivacion(e, { reason: "urgencia", at: "2030-06-10T12:00:00Z" });
    const r = await informe(e, "derivaciones");
    expect(JSON.stringify(r)).not.toContain("DIABETES");
    expect(reportToCsv(r)).not.toContain("DIABETES");
  });

  it("sin derivaciones no inventa tiempos", async () => {
    const e = await escenario();
    const r = await informe(e, "derivaciones");
    expect(kpi(r, "derivaciones")).toBe(0);
    expect(kpi(r, "horas_media")).toBeNull();
    expect(kpi(r, "mas_vieja")).toBeNull();
  });

  it("solo las del período y de la clínica", async () => {
    const e = await escenario();
    const otra = await escenario();
    await derivacion(e, { reason: "otro", at: "2030-05-01T12:00:00Z" });
    await derivacion(otra, { reason: "otro", at: "2030-06-10T12:00:00Z" });
    expect(kpi(await informe(e, "derivaciones"), "derivaciones")).toBe(0);
  });
});

describe("motivos de cancelación agregados", () => {
  it("categoriza por palabras clave, sin acentos ni mayúsculas", () => {
    const casos: Array<[string | null, string]> = [
      ["Tengo gripe", "Salud"], ["ME ENFERMÉ", "Salud"], ["Una reunión de trabajo", "Trabajo"],
      ["Estoy de viaje", "Viaje"], ["Está muy caro", "Dinero"], ["Se enfermó mi hijo", "Salud"],
      ["Mi mamá me necesita", "Familia"], ["Hay paro de colectivos", "Transporte o clima"],
      ["Prefiero otro día", "Quiere otra fecha"], ["Ya no quiero hacerme el tratamiento", "Cambió de idea o se atiende en otro lado"],
      ["Se me cruzó algo", "Olvido o imprevisto"], ["no sé", "Otro motivo"], ["", "Sin motivo registrado"], [null, "Sin motivo registrado"], ["   ", "Sin motivo registrado"],
    ];
    for (const [texto, esperado] of casos) expect(categorizarMotivo(texto), String(texto)).toBe(esperado);
  });

  it("agrupa los motivos, separa la queja y mide cuántas del paciente traen motivo", async () => {
    const e = await escenario();
    const base = { status: "cancelado" as const, cancelledAt: "2030-06-09T10:00:00Z" };
    await cita(e, { ...base, start: "2030-06-10T10:00:00Z", cancelledByKind: "paciente", cancelReason: "Tengo gripe" });
    await cita(e, { ...base, start: "2030-06-10T11:00:00Z", cancelledByKind: "paciente", cancelReason: "Estoy enfermo" });
    await cita(e, { ...base, start: "2030-06-10T12:00:00Z", cancelledByKind: "paciente", cancelReason: "Esperé una hora y nadie me atendió" });
    await cita(e, { ...base, start: "2030-06-10T13:00:00Z", cancelledByKind: "paciente" }); // sin motivo
    await cita(e, { ...base, start: "2030-06-10T14:00:00Z", cancelledByKind: "clinica", cancelReason: "El profesional no puede" });
    const queja = await prisma.appointment.findFirstOrThrow({ where: { clinicId: e.clinic.id, cancelReason: { startsWith: "Esperé" } } });
    await prisma.appointmentEvent.create({ data: { clinicId: e.clinic.id, appointmentId: queja.id, type: "cancelada", actorKind: "paciente", details: { queja: true } } });

    const r = await informe(e, "motivos", { base: "cita" });
    expect(kpi(r, "canceladas")).toBe(5);
    expect(kpi(r, "con_motivo")).toBe(4);
    expect(kpi(r, "pct_motivo_paciente")).toBe(75); // 3 de 4 del paciente
    expect(kpi(r, "quejas")).toBe(1);
    expect(kpi(r, "sin_clasificar")).toBe(1); // "El profesional no puede"
    expect(Object.fromEntries(tabla(r, "por_categoria") as Array<[string, number]>)).toEqual({
      Salud: 2, Queja: 1, "Otro motivo": 1, "Sin motivo registrado": 1,
    });
    expect(tabla(r, "por_quien")).toEqual([["El paciente", 4], ["La clínica", 1], ["Sin dato", 0]]);
  });

  it("no cuenta las citas que el paciente movió ni incluye el nombre del paciente", async () => {
    const e = await escenario();
    await cita(e, { start: "2030-06-10T10:00:00Z", status: "cancelado", cancelledByKind: "reprogramacion", cancelReason: "Cambié la hora", cancelledAt: "2030-06-09T10:00:00Z" });
    await cita(e, { start: "2030-06-10T11:00:00Z", status: "cancelado", cancelledByKind: "paciente", cancelReason: "Viajo", cancelledAt: "2030-06-09T10:00:00Z" });
    const r = await informe(e, "motivos", { base: "cita" });
    expect(kpi(r, "canceladas")).toBe(1);
    expect(r.detalle.columnas).not.toContain("Paciente");
    expect(JSON.stringify(r)).not.toContain("María López");
  });
});


describe("campañas y promociones", () => {
  let tel = 5491100020000;
  async function nueva(e: E, name: string, over: Record<string, unknown> = {}) {
    const r = await createCampaign(e.clinic.id, { name, serviceId: e.limpieza.id, triggers: [{ kind: "texto", value: `frase de ${name}`.toLowerCase() }], ...over });
    if (!r.ok) throw new Error(r.message);
    return r.value;
  }
  async function lead(e: E, campaignId: string, o: { llego?: string; nuevo?: boolean; status?: "abierto" | "convertido" | "cerrado"; motivo?: string; seguimientos?: number; via?: "texto" | "anuncio" | "asistente" } = {}) {
    return prisma.campaignLead.create({
      data: {
        clinicId: e.clinic.id, campaignId, patientPhone: String(tel++), triggerKind: o.via ?? "texto", isNewContact: o.nuevo ?? true,
        status: o.status ?? "abierto", closedReason: o.motivo ?? null, followUpCount: o.seguimientos ?? 0,
        firstMessageAt: new Date(o.llego ?? "2030-06-11T10:00:00Z"), lastInboundAt: new Date(o.llego ?? "2030-06-11T10:00:00Z"),
      },
    });
  }

  it("cuenta las campañas vigentes y cuántas personas llegaron, cuántas agendaron y cuántas siguen en seguimiento", async () => {
    const e = await escenario();
    const a = await nueva(e, "Verano", { channel: "Instagram" });
    const b = await nueva(e, "Vieja", { channel: "Flyer", endsOn: "2030-05-31" });
    await nueva(e, "Sin contactos"); // vigente y sin nadie: igual se lista
    await lead(e, a.id, { nuevo: true, via: "anuncio" });
    await lead(e, a.id, { nuevo: true, status: "convertido" });
    await lead(e, a.id, { nuevo: false, seguimientos: 2 });
    await lead(e, a.id, { nuevo: true, status: "cerrado", motivo: "sin_respuesta", seguimientos: 2 });
    await lead(e, b.id, { nuevo: true });
    await prisma.appointment.create({
      data: { clinicId: e.clinic.id, patientId: e.maria.id, professionalId: e.gomez.id, roomId: e.sala.id, service: "Limpieza", startTime: new Date("2030-06-20T10:00:00Z"), endTime: new Date("2030-06-20T10:30:00Z"), campaignId: a.id, createdAt: new Date("2030-06-11T12:00:00Z") },
    });

    const r = await informe(e, "campanas");
    expect(kpi(r, "campanas_vigentes")).toBe(2); // Verano y Sin contactos; "Vieja" terminó
    expect(kpi(r, "contactos")).toBe(5);
    expect(kpi(r, "nuevos")).toBe(4);
    expect(kpi(r, "agendaron")).toBe(1);
    expect(kpi(r, "conversion")).toBe(20);
    expect(kpi(r, "en_seguimiento")).toBe(3);
    expect(kpi(r, "seguimientos")).toBe(4);
    expect(kpi(r, "sin_respuesta")).toBe(1);
    expect(kpi(r, "citas")).toBe(1);

    expect(tabla(r, "contactos_por_campana")).toEqual([["Verano", 4], ["Vieja", 1]]);
    expect(tabla(r, "por_canal")).toEqual([["Instagram", 4], ["Flyer", 1]]);
    expect(tabla(r, "por_formato")).toEqual([["Anuncio de Meta", 1], ["Frase en el mensaje", 4], ["Lo reconoció el asistente", 0]]);
    const detalle = Object.fromEntries(r.detalle.filas.map((f) => [f[0], f]));
    expect(detalle["Verano"]).toEqual(["Verano", "Vigente", "Instagram", "Limpieza", 4, 3, 1, 25, 2, 4, 1, 1]);
    expect(detalle["Vieja"].slice(0, 2)).toEqual(["Vieja", "Vencida"]);
    expect(detalle["Sin contactos"].slice(4)).toEqual([0, 0, 0, null, 0, 0, 0, 0]);
  });

  it("separa los que reconoció el asistente por lo que dijeron de los que coincidieron con un formato", async () => {
    const e = await escenario();
    const a = await nueva(e, "Verano");
    await lead(e, a.id, { via: "texto" });
    await lead(e, a.id, { via: "asistente" });
    await lead(e, a.id, { via: "asistente" });
    const r = await informe(e, "campanas");
    expect(tabla(r, "por_formato")).toEqual([["Anuncio de Meta", 0], ["Frase en el mensaje", 1], ["Lo reconoció el asistente", 2]]);
    expect(r.notas.join(" ")).toMatch(/lo reconoció el asistente/i);
  });

  it("solo cuenta a quienes llegaron en el período, y las citas creadas en el período", async () => {
    const e = await escenario();
    const a = await nueva(e, "Verano");
    await lead(e, a.id, { llego: "2030-06-11T10:00:00Z" });
    await lead(e, a.id, { llego: "2030-05-01T10:00:00Z" }); // antes
    await lead(e, a.id, { llego: "2030-06-20T10:00:00Z" }); // después
    const r = await informe(e, "campanas");
    expect(kpi(r, "contactos")).toBe(1);
    expect(kpi(await informe(e, "campanas", { desde: "2030-04-01", hasta: "2030-06-30" }), "contactos")).toBe(3);
  });

  it("las citas canceladas no cuentan como citas de la campaña", async () => {
    const e = await escenario();
    const a = await nueva(e, "Verano");
    const base = { clinicId: e.clinic.id, patientId: e.maria.id, professionalId: e.gomez.id, roomId: e.sala.id, service: "Limpieza", startTime: new Date("2030-06-20T10:00:00Z"), endTime: new Date("2030-06-20T10:30:00Z"), campaignId: a.id, createdAt: new Date("2030-06-11T12:00:00Z") };
    await prisma.appointment.create({ data: base });
    await prisma.appointment.create({ data: { ...base, status: "cancelado" } });
    expect(kpi(await informe(e, "campanas"), "citas")).toBe(1);
  });

  it("el filtro por servicio deja las campañas de ese servicio; el de profesional no aplica y lo avisa", async () => {
    const e = await escenario();
    await nueva(e, "De limpieza", { serviceId: e.limpieza.id });
    await nueva(e, "Del láser", { serviceId: e.laser.id });
    const r = await informe(e, "campanas", { serviceId: e.laser.id });
    expect(r.detalle.filas.map((f) => f[0])).toEqual(["Del láser"]);
    const conProfesional = await informe(e, "campanas", { professionalId: e.gomez.id });
    expect(conProfesional.detalle.filas).toHaveLength(2);
    expect(conProfesional.notas.join(" ")).toMatch(/no se aplica/);
  });

  it("no mezcla las campañas ni los contactos de otra clínica", async () => {
    const e = await escenario();
    const otra = await escenario();
    await nueva(e, "Propia");
    const ajena = await nueva(otra, "Ajena");
    await lead(otra, ajena.id);
    const r = await informe(e, "campanas");
    expect(r.detalle.filas.map((f) => f[0])).toEqual(["Propia"]);
    expect(kpi(r, "contactos")).toBe(0);
  });

  it("sin contactos no inventa una conversión", async () => {
    const e = await escenario();
    await nueva(e, "Verano");
    const r = await informe(e, "campanas");
    expect(kpi(r, "conversion")).toBeNull();
  });

  it("se exporta a CSV con el detalle por campaña", async () => {
    const e = await escenario();
    await nueva(e, "Verano");
    const csv = reportToCsv(await informe(e, "campanas"));
    expect(csv).toContain("Campaña,Estado,Canal,Servicio,Contactos");
    expect(csv).toContain("Verano,Vigente");
  });
});
