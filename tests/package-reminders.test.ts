import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import {
  packageReminderRecipients,
  remindPendingPackageAppointments,
  type PackageReminderDeps,
} from "../src/jobs/package-reminders";
import type { PackageReminderRow } from "../src/services/email";

/**
 * El mail diario de citas por paquete que nadie marcó como atendidas. Contra el
 * Postgres local; el envío se inyecta, así que no sale ningún mail.
 */

/** Lunes 17 a las 10:00 UTC: dentro de la ventana de envío (8 a 18) en una clínica UTC. */
const AHORA = new Date("2030-06-17T10:00:00.000Z");
const clinicIds: string[] = [];
const userIds: string[] = [];
const roleIds: string[] = [];

type Enviado = { to: string[]; hoy: PackageReminderRow[]; atrasadas: PackageReminderRow[]; clinicName: string };

function fakeSend(options?: { falla?: boolean }): { deps: PackageReminderDeps; enviados: Enviado[] } {
  const enviados: Enviado[] = [];
  return {
    enviados,
    deps: {
      send: (async (p: Enviado) => {
        if (options?.falla) throw new Error("SMTP caído");
        enviados.push(p);
      }) as PackageReminderDeps["send"],
    },
  };
}

async function escenario(timezone = "UTC") {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica recordatorio ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `rm-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: `clinica-${Math.random()}@example.com`,
      timezone,
      services: "x",
      professionals: { create: [{ name: "Gómez" }] },
      rooms: { create: [{ name: "Sala 1" }] },
    },
    include: { professionals: true, rooms: true },
  });
  clinicIds.push(clinic.id);
  const servicio = await prisma.service.create({
    data: { clinicId: clinic.id, name: "Láser", durationMinutes: 30 },
  });
  const paciente = await prisma.patient.create({
    data: { clinicId: clinic.id, phone: `5491${Math.floor(Math.random() * 1e9)}`, name: "María" },
  });
  const paquete = await prisma.package.create({
    data: {
      clinicId: clinic.id,
      patientId: paciente.id,
      serviceId: servicio.id,
      serviceName: "Láser",
      totalSessions: 6,
      usedSessions: 2,
    },
  });
  return { clinic, servicio, paciente, paquete, gomez: clinic.professionals[0], sala: clinic.rooms[0] };
}
type E = Awaited<ReturnType<typeof escenario>>;

async function cita(e: E, start: string, over?: { status?: "confirmado" | "cancelado" | "atendido"; attended?: boolean }) {
  const inicio = new Date(start);
  return prisma.appointment.create({
    data: {
      clinicId: e.clinic.id,
      patientId: e.paciente.id,
      professionalId: e.gomez.id,
      roomId: e.sala.id,
      serviceId: e.servicio.id,
      service: "Láser",
      startTime: inicio,
      endTime: new Date(inicio.getTime() + 30 * 60_000),
      packageId: e.paquete.id,
      status: over?.status ?? "confirmado",
      attendedAt: over?.attended ? inicio : null,
    },
  });
}

/** Un usuario de la clínica, con o sin el permiso de marcar citas. */
async function usuario(e: E, over?: { conPermiso?: boolean; activo?: boolean; clinicId?: string }) {
  await prisma.permission.upsert({
    where: { id: "paquetes.gestionar" },
    create: { id: "paquetes.gestionar", description: "test", group: "Paquetes" },
    update: {},
  });
  const role = await prisma.role.create({
    data: {
      clinicId: over?.clinicId ?? e.clinic.id,
      name: `Rol ${Math.random()}`,
      permissions: over?.conPermiso === false ? undefined : { create: [{ permissionId: "paquetes.gestionar" }] },
    },
  });
  roleIds.push(role.id);
  const user = await prisma.user.create({
    data: {
      clinicId: over?.clinicId ?? e.clinic.id,
      email: `asistente-${Math.random()}@example.com`,
      name: "Asistente",
      active: over?.activo ?? true,
      roles: { create: [{ roleId: role.id }] },
    },
  });
  userIds.push(user.id);
  return user;
}

afterEach(async () => {
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } });
  await prisma.role.deleteMany({ where: { id: { in: roleIds } } });
  await prisma.systemEvent.deleteMany({ where: { clinicId: { in: clinicIds } } });
  for (const clinicId of clinicIds) {
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.package.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.service.deleteMany({ where: { clinicId } });
    await prisma.room.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
  userIds.length = 0;
  roleIds.length = 0;
});

const correr = (e: E, deps: PackageReminderDeps, now = AHORA) =>
  remindPendingPackageAppointments(now, deps, { clinicIds: [e.clinic.id] });

describe("el mail de citas por paquete sin marcar", () => {
  it("manda uno con las de hoy y las atrasadas, y marca el día", async () => {
    const e = await escenario();
    const u = await usuario(e);
    await cita(e, "2030-06-17T15:30:00.000Z"); // hoy
    await cita(e, "2030-06-14T11:00:00.000Z"); // viernes anterior, sin marcar
    const { deps, enviados } = fakeSend();

    expect(await correr(e, deps)).toBe(1);

    expect(enviados).toHaveLength(1);
    expect(enviados[0].to).toEqual([u.email]);
    expect(enviados[0].hoy).toHaveLength(1);
    expect(enviados[0].hoy[0]).toMatchObject({
      cuando: "15:30",
      paciente: "María",
      servicio: "Láser",
      profesional: "Gómez",
      quedan: 4,
      total: 6,
    });
    expect(enviados[0].atrasadas[0].cuando).toBe("14/06 11:00");
    const despues = await prisma.clinic.findUniqueOrThrow({ where: { id: e.clinic.id } });
    expect(despues.packageReminderSentOn?.toISOString().slice(0, 10)).toBe("2030-06-17");
  });

  it("no lo repite el mismo día, aunque el job corra de nuevo", async () => {
    const e = await escenario();
    await usuario(e);
    await cita(e, "2030-06-17T15:30:00.000Z");
    const { deps, enviados } = fakeSend();
    await correr(e, deps);
    await correr(e, deps, new Date("2030-06-17T14:00:00.000Z"));
    expect(enviados).toHaveLength(1);
  });

  it("al día siguiente vuelve a avisar mientras la cita siga sin marcar", async () => {
    const e = await escenario();
    await usuario(e);
    await cita(e, "2030-06-17T15:30:00.000Z");
    const { deps, enviados } = fakeSend();
    await correr(e, deps);
    await correr(e, deps, new Date("2030-06-18T10:00:00.000Z"));
    expect(enviados).toHaveLength(2);
    // Ahora la del lunes es una atrasada: no desaparece, que es el punto.
    expect(enviados[1].atrasadas).toHaveLength(1);
    expect(enviados[1].hoy).toHaveLength(0);
  });

  it("deja de avisar cuando todo está marcado", async () => {
    const e = await escenario();
    await usuario(e);
    await cita(e, "2030-06-14T11:00:00.000Z", { attended: true });
    await cita(e, "2030-06-17T09:00:00.000Z", { status: "cancelado" });
    const { deps, enviados } = fakeSend();
    expect(await correr(e, deps)).toBe(0);
    expect(enviados).toHaveLength(0);
  });

  it("sin nada pendiente no manda ni marca el día (un aviso vacío enseña a ignorarlos)", async () => {
    const e = await escenario();
    const { deps, enviados } = fakeSend();
    await correr(e, deps);
    expect(enviados).toHaveLength(0);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: e.clinic.id } })).packageReminderSentOn).toBeNull();
  });

  it("una cita que el job dejó en 'atendido' sin que nadie la confirmara sigue avisando", async () => {
    const e = await escenario();
    await usuario(e);
    await cita(e, "2030-06-14T11:00:00.000Z", { status: "atendido" });
    const { deps, enviados } = fakeSend();
    await correr(e, deps);
    expect(enviados[0].atrasadas).toHaveLength(1);
  });
});

describe("cuándo se manda", () => {
  it("solo entre las 8 y las 18 de la clínica", async () => {
    const e = await escenario();
    await usuario(e);
    await cita(e, "2030-06-17T15:30:00.000Z");
    const { deps, enviados } = fakeSend();

    await correr(e, deps, new Date("2030-06-17T07:20:00.000Z")); // 07:20
    await correr(e, deps, new Date("2030-06-17T19:20:00.000Z")); // 19:20
    expect(enviados).toHaveLength(0);

    await correr(e, deps, new Date("2030-06-17T08:20:00.000Z")); // 08:20
    expect(enviados).toHaveLength(1);
  });

  it("la hora es la de la clínica, no la del servidor", async () => {
    const e = await escenario("America/Mexico_City"); // UTC-6
    await usuario(e);
    await cita(e, "2030-06-17T20:00:00.000Z");
    const { deps, enviados } = fakeSend();

    await correr(e, deps, new Date("2030-06-17T13:20:00.000Z")); // 07:20 en México
    expect(enviados).toHaveLength(0);
    await correr(e, deps, new Date("2030-06-17T14:20:00.000Z")); // 08:20 en México
    expect(enviados).toHaveLength(1);
  });

  it("si el mail falla no marca el día, deja un evento y se reintenta a la hora siguiente", async () => {
    const e = await escenario();
    await usuario(e);
    await cita(e, "2030-06-17T15:30:00.000Z");

    const roto = fakeSend({ falla: true });
    expect(await correr(e, roto.deps)).toBe(0);
    expect((await prisma.clinic.findUniqueOrThrow({ where: { id: e.clinic.id } })).packageReminderSentOn).toBeNull();
    const eventos = await prisma.systemEvent.findMany({ where: { clinicId: e.clinic.id, kind: "cron_error" } });
    expect(eventos).toHaveLength(1);
    expect(eventos[0].message).toContain("package-reminders");

    const sano = fakeSend();
    expect(await correr(e, sano.deps, new Date("2030-06-17T11:20:00.000Z"))).toBe(1);
    expect(sano.enviados).toHaveLength(1);
  });
});

describe("a quién se le manda", () => {
  it("a los usuarios activos de la clínica que pueden marcar la cita", async () => {
    const e = await escenario();
    const otra = await escenario();
    const con = await usuario(e);
    await usuario(e, { conPermiso: false }); // no puede marcarla
    await usuario(e, { activo: false }); // dado de baja
    await usuario(otra); // de otra clínica
    const emails = await packageReminderRecipients(e.clinic);
    expect(emails).toEqual([con.email]);
  });

  it("si nadie puede marcarla, al mail de la clínica: mejor que lo lea alguien a que no lo lea nadie", async () => {
    const e = await escenario();
    await usuario(e, { conPermiso: false });
    expect(await packageReminderRecipients(e.clinic)).toEqual([e.clinic.email]);
  });

  it("varios usuarios reciben un solo mail", async () => {
    const e = await escenario();
    const a = await usuario(e);
    const b = await usuario(e);
    await cita(e, "2030-06-17T15:30:00.000Z");
    const { deps, enviados } = fakeSend();
    await correr(e, deps);
    expect(enviados).toHaveLength(1);
    expect(enviados[0].to.sort()).toEqual([a.email, b.email].sort());
  });
});
