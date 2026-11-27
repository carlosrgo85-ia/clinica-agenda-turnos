import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db/client";
import { PLAN_FEATURES } from "../src/config/plan-features";
import { encryptToken } from "../src/services/crypto";

// Ningún WhatsApp sale de verdad: se registra cada plantilla que se habría mandado.
const sendTemplateMessage = vi.fn();
vi.mock("../src/services/whatsapp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/whatsapp")>()),
  sendTemplateMessage: (...args: unknown[]) => sendTemplateMessage(...args),
}));

// Las pasadas recorren las clínicas activas: que sean solo las de este test, no las de la base de desarrollo.
const control = vi.hoisted(() => ({ ids: [] as string[], fallar: false }));
vi.mock("../src/repositories/clinics.repository", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/repositories/clinics.repository")>();
  return {
    ...original,
    listActiveClinics: async () => {
      if (control.fallar) throw new Error("base caída");
      return (await original.listActiveClinics()).filter((c) => control.ids.includes(c.id));
    },
  };
});

import { reminderDate, runReminderRound, sendRemindersForWindow } from "../src/jobs/daily-reminders";
import { runTwoHourReminders } from "../src/jobs/two-hour-reminders";

/**
 * Los recordatorios de 24 h y de 2 h. Si fallan, el paciente no recibe el aviso (o lo recibe a una hora
 * corrida, o dos veces), y desde afuera se ve igual que un bug de la plantilla. Contra el Postgres local:
 * docker compose up -d db
 */

const HORA = 3_600_000;
/** 10:20 UTC: la hora en punto es las 10:00. */
const AHORA = new Date("2030-06-12T10:20:00.000Z");
const BASE = new Date("2030-06-12T10:00:00.000Z").getTime();
const clinicIds: string[] = [];
const planIds: string[] = [];

async function crearClinica(options?: { timezone?: string; features?: string[]; active?: boolean; tokenRoto?: boolean; plantilla?: string }) {
  let planId: string | undefined;
  if (options?.features) {
    const plan = await prisma.plan.create({ data: { name: `Plan rec ${Date.now()}-${Math.random()}`, features: options.features } });
    planIds.push(plan.id);
    planId = plan.id;
  }
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica rec ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `rec-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: options?.tokenRoto ? "esto-no-se-puede-descifrar" : encryptToken("test"),
      email: "test@example.com",
      timezone: options?.timezone ?? "UTC",
      services: "x",
      active: options?.active ?? true,
      planId,
      ...(options?.plantilla ? { reminderTemplateName: options.plantilla } : {}),
      professionals: { create: [{ name: "Gómez" }] },
      rooms: { create: [{ name: "Sala 1" }] },
    },
    include: { professionals: true, rooms: true },
  });
  clinicIds.push(clinic.id);
  control.ids.push(clinic.id);
  return clinic;
}
type Clinica = Awaited<ReturnType<typeof crearClinica>>;

let telefono = 5491100000000;
async function cita(clinic: Clinica, startTime: Date, o?: { status?: "confirmado" | "cancelado" | "atendido"; nombre?: string | null; servicio?: string }) {
  const patient = await prisma.patient.create({
    data: { clinicId: clinic.id, phone: String(telefono++), name: o?.nombre === undefined ? "María López" : o.nombre },
  });
  return prisma.appointment.create({
    data: {
      clinicId: clinic.id, patientId: patient.id, professionalId: clinic.professionals[0].id, roomId: clinic.rooms[0].id,
      service: o?.servicio ?? "Limpieza", startTime, endTime: new Date(startTime.getTime() + 30 * 60_000), status: o?.status ?? "confirmado",
    },
    include: { patient: true },
  });
}
const creds = { token: "t", phoneNumberId: "p" };
const enviadosA = () => sendTemplateMessage.mock.calls.map((c) => c[1] as string);

beforeEach(() => {
  sendTemplateMessage.mockReset();
  sendTemplateMessage.mockResolvedValue(undefined);
  control.fallar = false;
});

afterEach(async () => {
  for (const id of clinicIds) {
    await prisma.systemEvent.deleteMany({ where: { clinicId: id } });
    await prisma.conversationMessage.deleteMany({ where: { clinicId: id } });
    await prisma.appointment.deleteMany({ where: { clinicId: id } });
    await prisma.patient.deleteMany({ where: { clinicId: id } });
    await prisma.room.deleteMany({ where: { clinicId: id } });
    await prisma.professional.deleteMany({ where: { clinicId: id } });
    await prisma.clinic.delete({ where: { id } });
  }
  for (const id of planIds) await prisma.plan.delete({ where: { id } });
  clinicIds.length = 0;
  planIds.length = 0;
  control.ids.length = 0;
});

describe("la ventana: quién recibe el recordatorio", () => {
  it("el de 24 h avisa a quien tiene la cita entre 23 y 24 horas después de la hora en punto", async () => {
    const c = await crearClinica();
    const dentro = await cita(c, new Date(BASE + 23.5 * HORA));
    await cita(c, new Date(BASE + 22.5 * HORA)); // ya le tocó en una pasada anterior
    await cita(c, new Date(BASE + 24.5 * HORA)); // le toca en la próxima

    const r = await sendRemindersForWindow(c.id, creds, "recordatorio_turno", 24, "UTC", AHORA);

    expect(r).toEqual({ sent: 1, failed: 0 });
    expect(enviadosA()).toEqual([dentro.patient.phone]);
  });

  it("el de 2 h avisa a quien tiene la cita entre 1 y 2 horas después", async () => {
    const c = await crearClinica();
    const dentro = await cita(c, new Date(BASE + 1.5 * HORA));
    await cita(c, new Date(BASE + 0.5 * HORA));
    await cita(c, new Date(BASE + 2.5 * HORA));
    await sendRemindersForWindow(c.id, creds, "recordatorio_turno", 2, "UTC", AHORA);
    expect(enviadosA()).toEqual([dentro.patient.phone]);
  });

  it("dos pasadas seguidas empalman exacto: una cita en punto cae en UNA sola, sin hueco ni repetición", async () => {
    const c = await crearClinica();
    const enElLimite = await cita(c, new Date(BASE + 24 * HORA)); // empieza justo en la hora en punto de la pasada siguiente

    const pasada1 = await sendRemindersForWindow(c.id, creds, "recordatorio_turno", 24, "UTC", new Date(BASE + 5_000));
    const pasada2 = await sendRemindersForWindow(c.id, creds, "recordatorio_turno", 24, "UTC", new Date(BASE + HORA + 40_000));

    expect(pasada1.sent).toBe(0);
    expect(pasada2.sent).toBe(1);
    expect(enviadosA()).toEqual([enElLimite.patient.phone]);
  });

  it("da lo mismo cuándo dentro de la hora arranca la pasada (10:00:00 o 10:59:59)", async () => {
    const c = await crearClinica();
    await cita(c, new Date(BASE + 23.5 * HORA));
    const a = await sendRemindersForWindow(c.id, creds, "recordatorio_turno", 24, "UTC", new Date(BASE));
    const b = await sendRemindersForWindow(c.id, creds, "recordatorio_turno", 24, "UTC", new Date(BASE + HORA - 1));
    // Cada pasada alcanza a la cita, pero el aviso sale UNA sola vez: la segunda ya la encuentra marcada.
    expect([a.sent, b.sent]).toEqual([1, 0]);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it("solo las confirmadas: ni las canceladas ni las ya atendidas", async () => {
    const c = await crearClinica();
    const t = new Date(BASE + 23.5 * HORA);
    const vigente = await cita(c, t);
    await cita(c, t, { status: "cancelado" });
    await cita(c, t, { status: "atendido" });
    await sendRemindersForWindow(c.id, creds, "recordatorio_turno", 24, "UTC", AHORA);
    expect(enviadosA()).toEqual([vigente.patient.phone]);
  });

  it("solo las citas de ESA clínica", async () => {
    const a = await crearClinica();
    const b = await crearClinica();
    const t = new Date(BASE + 23.5 * HORA);
    const deA = await cita(a, t);
    await cita(b, t);
    await sendRemindersForWindow(a.id, creds, "recordatorio_turno", 24, "UTC", AHORA);
    expect(enviadosA()).toEqual([deA.patient.phone]);
  });
});

describe("no se avisa dos veces", () => {
  it("si el cron corre dos veces en la misma hora, el paciente recibe UN solo aviso", async () => {
    const c = await crearClinica();
    const a = await cita(c, new Date(BASE + 23.5 * HORA));
    const p1 = await sendRemindersForWindow(c.id, creds, "recordatorio_turno", 24, "UTC", AHORA);
    const p2 = await sendRemindersForWindow(c.id, creds, "recordatorio_turno", 24, "UTC", AHORA);
    expect([p1.sent, p2.sent]).toEqual([1, 0]);
    expect(enviadosA()).toEqual([a.patient.phone]);
    expect((await prisma.appointment.findUnique({ where: { id: a.id } }))!.reminder24SentAt).not.toBeNull();
  });

  it("dos pasadas a la vez (dos instancias) tampoco lo duplican", async () => {
    const c = await crearClinica();
    await cita(c, new Date(BASE + 23.5 * HORA));
    const [p1, p2] = await Promise.all([
      sendRemindersForWindow(c.id, creds, "recordatorio_turno", 24, "UTC", AHORA),
      sendRemindersForWindow(c.id, creds, "recordatorio_turno", 24, "UTC", AHORA),
    ]);
    expect(p1.sent + p2.sent).toBe(1);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it("el de 24 h y el de 2 h son independientes: haber mandado uno no impide el otro", async () => {
    const c = await crearClinica();
    const a = await cita(c, new Date(BASE + 23.5 * HORA));
    await sendRemindersForWindow(c.id, creds, "recordatorio_turno", 24, "UTC", AHORA);
    // Más tarde, la misma cita está a 1,5 h.
    const r = await sendRemindersForWindow(c.id, creds, "recordatorio_turno", 2, "UTC", new Date(BASE + 22 * HORA));
    expect(r.sent).toBe(1);
    const f = (await prisma.appointment.findUnique({ where: { id: a.id } }))!;
    expect(f.reminder24SentAt).not.toBeNull();
    expect(f.reminder2hSentAt).not.toBeNull();
  });

  it("si el envío falla se libera la marca: un reintento sí lo manda", async () => {
    const c = await crearClinica();
    const a = await cita(c, new Date(BASE + 23.5 * HORA));
    sendTemplateMessage.mockRejectedValueOnce(new Error("Meta caído"));
    const fallo = await sendRemindersForWindow(c.id, creds, "recordatorio_turno", 24, "UTC", AHORA);
    expect(fallo).toEqual({ sent: 0, failed: 1 });
    expect((await prisma.appointment.findUnique({ where: { id: a.id } }))!.reminder24SentAt).toBeNull();
    const reintento = await sendRemindersForWindow(c.id, creds, "recordatorio_turno", 24, "UTC", AHORA);
    expect(reintento.sent).toBe(1);
  });
});

describe("lo que ve el paciente", () => {
  it("manda la plantilla con [nombre, fecha, hora, servicio], en español, con las credenciales y el nombre de la plantilla de la clínica", async () => {
    const c = await crearClinica();
    const a = await cita(c, new Date(BASE + 23.5 * HORA), { servicio: "Control" }); // mañana 09:30 UTC
    await sendRemindersForWindow(c.id, creds, "mi_plantilla", 24, "UTC", AHORA);
    expect(sendTemplateMessage).toHaveBeenCalledWith(creds, a.patient.phone, "mi_plantilla", "es", ["María López", "13/06/2030", "09:30", "Control"]);
  });

  it("la fecha y la hora son las de la clínica, no las del servidor: un paciente de México no ve la hora corrida", async () => {
    const c = await crearClinica({ timezone: "America/Mexico_City" }); // UTC-6 en junio
    await cita(c, new Date("2030-06-13T09:30:00.000Z")); // en la ventana de 24 h; en México son las 03:30
    await sendRemindersForWindow(c.id, creds, "recordatorio_turno", 24, "America/Mexico_City", AHORA);
    expect(sendTemplateMessage.mock.calls[0][4]).toEqual(["María López", "13/06/2030", "03:30", "Limpieza"]);
  });

  it("si en la clínica ya es otro día que en UTC, avisa el día de la clínica", async () => {
    const c = await crearClinica({ timezone: "America/Mexico_City" });
    // 02:30 UTC del 13 son las 20:30 del 12 en México: en UTC es otro día. La pasada de las 03:20 UTC del 12
    // mira las citas entre las 02:00 y las 03:00 UTC del 13.
    await cita(c, new Date("2030-06-13T02:30:00.000Z"));
    await sendRemindersForWindow(c.id, creds, "recordatorio_turno", 24, "America/Mexico_City", new Date("2030-06-12T03:20:00.000Z"));
    expect(sendTemplateMessage.mock.calls[0][4]).toEqual(["María López", "12/06/2030", "20:30", "Limpieza"]);
  });

  it("un paciente sin nombre recibe 'paciente'", async () => {
    const c = await crearClinica();
    await cita(c, new Date(BASE + 23.5 * HORA), { nombre: null });
    await sendRemindersForWindow(c.id, creds, "recordatorio_turno", 24, "UTC", AHORA);
    expect((sendTemplateMessage.mock.calls[0][4] as string[])[0]).toBe("paciente");
  });

  it("reminderDate da el formato de las plantillas (día/mes/año) en la fecha de la clínica", () => {
    expect(reminderDate(new Date("2030-06-13T09:30:00Z"), "UTC")).toBe("13/06/2030");
    expect(reminderDate(new Date("2030-06-13T03:30:00Z"), "America/Mexico_City")).toBe("12/06/2030");
  });
});

describe("cuando el envío falla", () => {
  it("un recordatorio que falla no frena a los demás pacientes, y se cuenta", async () => {
    const c = await crearClinica();
    const t = new Date(BASE + 23.5 * HORA);
    const a = await cita(c, t);
    const b = await cita(c, t);
    const d = await cita(c, t);
    sendTemplateMessage.mockImplementation(async (_c: unknown, to: string) => {
      if (to === b.patient.phone) throw new Error("Meta rechazó la plantilla");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const r = await sendRemindersForWindow(c.id, creds, "recordatorio_turno", 24, "UTC", AHORA);
      expect(r).toEqual({ sent: 2, failed: 1 });
    } finally {
      log.mockRestore();
    }
    expect(enviadosA().sort()).toEqual([a.patient.phone, b.patient.phone, d.patient.phone].sort());
  });
});

describe("la pasada sobre las clínicas", () => {
  it("el de 2 h solo lo reciben las clínicas cuyo plan lo incluye", async () => {
    const plus = await crearClinica({ features: [PLAN_FEATURES.REMINDER_2H] });
    const base = await crearClinica({ features: [] });
    const sinPlan = await crearClinica();
    const t = new Date(BASE + 1.5 * HORA);
    const dePlus = await cita(plus, t);
    await cita(base, t);
    await cita(sinPlan, t);

    await runTwoHourReminders(AHORA);

    expect(enviadosA()).toEqual([dePlus.patient.phone]);
  });

  it("usa el nombre de plantilla de cada clínica y su zona horaria", async () => {
    const c = await crearClinica({ features: [PLAN_FEATURES.REMINDER_2H], timezone: "America/Mexico_City", plantilla: "recordatorio_mx" });
    await cita(c, new Date(BASE + 1.5 * HORA)); // 11:30 UTC = 05:30 en México
    await runTwoHourReminders(AHORA);
    expect(sendTemplateMessage.mock.calls[0][2]).toBe("recordatorio_mx");
    expect((sendTemplateMessage.mock.calls[0][4] as string[])[2]).toBe("05:30");
  });

  it("el de 24 h alcanza a todas las clínicas activas, sin mirar el plan, y no a las dadas de baja", async () => {
    const a = await crearClinica();
    const b = await crearClinica({ features: [] });
    const baja = await crearClinica({ active: false });
    const t = new Date(BASE + 23.5 * HORA);
    const deA = await cita(a, t);
    const deB = await cita(b, t);
    await cita(baja, t);

    await runReminderRound({ job: "daily-reminders", hoursAhead: 24, now: AHORA });

    expect(enviadosA().sort()).toEqual([deA.patient.phone, deB.patient.phone].sort());
  });

  it("una clínica que falla se anota en Monitoreo y no deja sin recordatorio a las demás", async () => {
    const rota = await crearClinica({ tokenRoto: true }); // el token no se puede descifrar
    const sana = await crearClinica();
    const t = new Date(BASE + 23.5 * HORA);
    await cita(rota, t);
    const deSana = await cita(sana, t);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(runReminderRound({ job: "daily-reminders", hoursAhead: 24, now: AHORA })).resolves.toBeUndefined();
    } finally {
      log.mockRestore();
    }

    expect(enviadosA()).toEqual([deSana.patient.phone]);
    const eventos = await prisma.systemEvent.findMany({ where: { clinicId: rota.id, kind: "cron_error" } });
    expect(eventos).toHaveLength(1);
    expect(eventos[0].message).toContain("daily-reminders");
  });

  it("si falla incluso la consulta de las clínicas, no lanza (una promesa sin manejar mata el worker)", async () => {
    control.fallar = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(runReminderRound({ job: "daily-reminders", hoursAhead: 24, now: AHORA })).resolves.toBeUndefined();
      await expect(runTwoHourReminders(AHORA)).resolves.toBeUndefined();
    } finally {
      log.mockRestore();
    }
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });
});
