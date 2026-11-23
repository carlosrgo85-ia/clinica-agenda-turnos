import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import {
  closeStaleLeads,
  FOLLOWUP_TEMPLATE_NAME,
  MAX_FOLLOWUPS_PER_RUN,
  nextFollowUpAt,
  runCampaignFollowUp,
} from "../src/jobs/campaign-followup";
import { PLAN_FEATURES } from "../src/config/plan-features";
import { createCampaign } from "../src/services/campaigns";
import { purgeAuditForClinics } from "./helpers/audit";

/**
 * El seguimiento de quienes llegaron por una campaña y no agendaron. Lo que más importa es el TOPE: no
 * insistir por siempre, no escribirle a quien ya agendó ni a quien pidió que no lo contacten, y no mandar
 * dos veces. Contra el Postgres local: docker compose up -d db
 */

const HORA = 3_600_000;
/** Mediodía UTC: dentro del horario de la clínica (9 a 18). */
const AHORA = new Date("2030-06-12T12:00:00.000Z");
const hace = (horas: number) => new Date(AHORA.getTime() - horas * HORA);
const clinicIds: string[] = [];
let telefono = 5491100002000;

const send = vi.fn();
const deps = { send: send as never };

async function crearClinica(options?: { habilitado?: boolean; timezone?: string; sinPlan?: boolean }) {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica seguimiento ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `sg-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: options?.timezone ?? "UTC",
      services: "x",
      campaignFollowUpEnabled: options?.habilitado ?? true,
      // El seguimiento de campañas es del plan Plus: sin él, el interruptor prendido no hace nada.
      plan: {
        create: {
          name: `test-plan-${Date.now()}-${Math.random()}`,
          features: options?.sinPlan ? [] : [PLAN_FEATURES.CAMPAIGN_FOLLOWUP],
        },
      },
      professionals: { create: [{ name: "Gómez" }] },
      rooms: { create: [{ name: "Sala 1" }] },
    },
    include: { professionals: true, rooms: true },
  });
  clinicIds.push(clinic.id);
  // El servicio de la promoción es obligatorio y tiene que tener quién lo atienda.
  const servicio = await prisma.service.create({
    data: { clinicId: clinic.id, name: "Limpieza", durationMinutes: 30, professionals: { connect: [{ id: clinic.professionals[0].id }] } },
  });
  return Object.assign(clinic, { servicioId: servicio.id });
}
type Clinica = Awaited<ReturnType<typeof crearClinica>>;

let n = 0;
async function campana(c: Clinica, o?: { intentos?: number; despues?: number; cada?: number; active?: boolean; name?: string }) {
  const r = await createCampaign(c.id, {
    name: o?.name ?? `Verano ${n++}`,
    serviceId: c.servicioId,
    triggers: [{ kind: "texto", value: `frase numero ${n++}` }],
    followUpMaxAttempts: o?.intentos ?? 2,
    followUpAfterHours: o?.despues ?? 24,
    followUpIntervalHours: o?.cada ?? 48,
    active: o?.active,
  });
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

async function contacto(
  c: Clinica,
  campaignId: string,
  o?: { phone?: string; ultimoMensajeHaceHoras?: number; intentos?: number; ultimoSeguimientoHaceHoras?: number | null; nombre?: string | null; optOut?: boolean; status?: "abierto" | "convertido" | "cerrado" }
) {
  const phone = o?.phone ?? String(telefono++);
  if (o?.nombre !== null) {
    await prisma.patient.create({ data: { clinicId: c.id, phone, name: o?.nombre ?? "María López", outreachOptOut: o?.optOut ?? false } });
  }
  return prisma.campaignLead.create({
    data: {
      clinicId: c.id, campaignId, patientPhone: phone, triggerKind: "texto", isNewContact: true, status: o?.status ?? "abierto",
      firstMessageAt: hace((o?.ultimoMensajeHaceHoras ?? 30) + 1), lastInboundAt: hace(o?.ultimoMensajeHaceHoras ?? 30),
      followUpCount: o?.intentos ?? 0,
      lastFollowUpAt: o?.ultimoSeguimientoHaceHoras == null ? null : hace(o.ultimoSeguimientoHaceHoras),
    },
  });
}
const recargar = (id: string) => prisma.campaignLead.findUniqueOrThrow({ where: { id } });

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue(undefined);
});

afterEach(async () => {
  await purgeAuditForClinics(clinicIds);
  for (const id of clinicIds) {
    await prisma.systemEvent.deleteMany({ where: { clinicId: id } });
    await prisma.conversationMessage.deleteMany({ where: { clinicId: id } });
    await prisma.appointment.deleteMany({ where: { clinicId: id } });
    await prisma.campaignLead.deleteMany({ where: { clinicId: id } });
    await prisma.campaign.deleteMany({ where: { clinicId: id } });
    await prisma.patient.deleteMany({ where: { clinicId: id } });
    await prisma.service.deleteMany({ where: { clinicId: id } });
    await prisma.room.deleteMany({ where: { clinicId: id } });
    await prisma.professional.deleteMany({ where: { clinicId: id } });
    await prisma.clinic.delete({ where: { id } });
  }
  await prisma.plan.deleteMany({ where: { name: { startsWith: "test-plan-" } } });
  clinicIds.length = 0;
});

describe("cuándo le toca el próximo seguimiento", () => {
  const camp = { followUpAfterHours: 24, followUpIntervalHours: 48 };
  it("el primero, a las X horas de su último mensaje; los siguientes, cada Y desde el último seguimiento", () => {
    expect(nextFollowUpAt({ followUpCount: 0, lastInboundAt: hace(10), lastFollowUpAt: null }, camp).getTime()).toBe(hace(10).getTime() + 24 * HORA);
    expect(nextFollowUpAt({ followUpCount: 1, lastInboundAt: hace(100), lastFollowUpAt: hace(10) }, camp).getTime()).toBe(hace(10).getTime() + 48 * HORA);
  });
  it("si contestó después del último seguimiento, la espera arranca de su mensaje", () => {
    expect(nextFollowUpAt({ followUpCount: 1, lastInboundAt: hace(5), lastFollowUpAt: hace(30) }, camp).getTime()).toBe(hace(5).getTime() + 48 * HORA);
  });
});

describe("a quién se le escribe, y qué se le manda", () => {
  it("al que preguntó y no agendó, pasado el tiempo: plantilla con [nombre, clínica, campaña], y queda registrado", async () => {
    const c = await crearClinica();
    const camp = await campana(c, { name: "Limpieza de verano" });
    const lead = await contacto(c, camp.id, { ultimoMensajeHaceHoras: 25, nombre: "María Luisa López" });
    const tel = lead.patientPhone;

    const enviados = await runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] });

    expect(enviados).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    const [creds, to, plantilla, idioma, params] = send.mock.calls[0];
    expect(creds).toMatchObject({ phoneNumberId: c.whatsappPhoneNumberId });
    expect([to, plantilla, idioma]).toEqual([tel, FOLLOWUP_TEMPLATE_NAME, "es"]);
    expect(params).toEqual(["María", c.name, "Limpieza de verano"]);

    const despues = await recargar(lead.id);
    expect(despues).toMatchObject({ followUpCount: 1, status: "abierto" });
    expect(despues.lastFollowUpAt?.toISOString()).toBe(AHORA.toISOString());

    // En la auditoría (origen sistema) sin el teléfono; y en el historial, lo que se mandó.
    const fila = await prisma.auditLog.findFirstOrThrow({ where: { clinicId: c.id, action: "campaign.followup_sent" } });
    expect(fila).toMatchObject({ origin: "sistema", resourceId: lead.id });
    expect(JSON.stringify(fila)).not.toContain(tel);
    const msg = await prisma.conversationMessage.findFirstOrThrow({ where: { clinicId: c.id, patientPhone: tel } });
    expect(msg.role).toBe("assistant");
    expect(msg.content).toContain("Limpieza de verano");
    expect(msg.content).toContain("María");
  });

  it("si todavía no tiene ficha, el nombre es 'paciente'", async () => {
    const c = await crearClinica();
    await contacto(c, (await campana(c)).id, { nombre: null });
    await runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] });
    expect(send.mock.calls[0][4][0]).toBe("paciente");
  });

  it("no antes de tiempo", async () => {
    const c = await crearClinica();
    const camp = await campana(c, { despues: 24 });
    const lead = await contacto(c, camp.id, { ultimoMensajeHaceHoras: 23 });
    expect(await runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] })).toBe(0);
    expect((await recargar(lead.id)).followUpCount).toBe(0);
  });

  it("no le escribe a quien ya agendó (aunque la cita la haya cargado la clínica a mano) y lo pasa a convertido", async () => {
    const c = await crearClinica();
    const camp = await campana(c);
    const lead = await contacto(c, camp.id);
    const paciente = await prisma.patient.findFirstOrThrow({ where: { clinicId: c.id, phone: lead.patientPhone } });
    await prisma.appointment.create({
      data: {
        clinicId: c.id, patientId: paciente.id, professionalId: c.professionals[0].id, roomId: c.rooms[0].id, service: "Limpieza",
        startTime: new Date("2030-06-20T10:00:00Z"), endTime: new Date("2030-06-20T10:30:00Z"), createdAt: hace(2),
      },
    });
    expect(await runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] })).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(await recargar(lead.id)).toMatchObject({ status: "convertido" });
    expect(await prisma.auditLog.count({ where: { clinicId: c.id, action: "campaign.lead_converted", origin: "sistema" } })).toBe(1);
  });

  it("una cita cancelada, o de antes de que llegara por la campaña, no cuenta como haber agendado", async () => {
    const c = await crearClinica();
    const camp = await campana(c);
    const lead = await contacto(c, camp.id, { ultimoMensajeHaceHoras: 30 });
    const paciente = await prisma.patient.findFirstOrThrow({ where: { clinicId: c.id, phone: lead.patientPhone } });
    const base = { clinicId: c.id, patientId: paciente.id, professionalId: c.professionals[0].id, roomId: c.rooms[0].id, service: "Limpieza", startTime: new Date("2030-06-20T10:00:00Z"), endTime: new Date("2030-06-20T10:30:00Z") };
    await prisma.appointment.create({ data: { ...base, status: "cancelado", createdAt: hace(2) } });
    await prisma.appointment.create({ data: { ...base, createdAt: hace(500) } }); // anterior a la campaña
    expect(await runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] })).toBe(1);
  });

  it("no le escribe a quien pidió que no lo contacten: lo cierra", async () => {
    const c = await crearClinica();
    const lead = await contacto(c, (await campana(c)).id, { optOut: true });
    expect(await runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] })).toBe(0);
    expect(await recargar(lead.id)).toMatchObject({ status: "cerrado", closedReason: "solicitud_del_paciente" });
  });

  it("si la campaña se desactivó, no se sigue y el contacto se cierra", async () => {
    const c = await crearClinica();
    const lead = await contacto(c, (await campana(c, { active: false })).id);
    expect(await runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] })).toBe(0);
    expect(await recargar(lead.id)).toMatchObject({ status: "cerrado", closedReason: "campana_inactiva" });
  });

  it("no toca a los convertidos ni a los cerrados", async () => {
    const c = await crearClinica();
    const camp = await campana(c);
    await contacto(c, camp.id, { status: "convertido" });
    await contacto(c, camp.id, { status: "cerrado" });
    expect(await runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] })).toBe(0);
  });
});

describe("el tope: no insistir por siempre", () => {
  it("manda como máximo los intentos de la campaña, espaciados por el intervalo", async () => {
    const c = await crearClinica();
    const camp = await campana(c, { intentos: 2, despues: 24, cada: 48 });
    const lead = await contacto(c, camp.id, { ultimoMensajeHaceHoras: 30 });

    expect(await runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] })).toBe(1); // el 1º
    // 47 horas después todavía no toca el 2º; a las 48, sí.
    expect(await runCampaignFollowUp(new Date(AHORA.getTime() + 47 * HORA - 3 * HORA), deps, { clinicIds: [c.id] })).toBe(0);
    expect(await runCampaignFollowUp(new Date(AHORA.getTime() + 48 * HORA), deps, { clinicIds: [c.id] })).toBe(1); // el 2º
    expect((await recargar(lead.id)).followUpCount).toBe(2);

    // Agotados los intentos no se le escribe más, ni a los 10 días.
    expect(await runCampaignFollowUp(new Date(AHORA.getTime() + 20 * 24 * HORA), deps, { clinicIds: [c.id] })).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("agotados los intentos y pasada la espera sin que conteste, se cierra como 'sin respuesta'", async () => {
    const c = await crearClinica();
    const camp = await campana(c, { intentos: 1, cada: 48 });
    const lead = await contacto(c, camp.id, { intentos: 1, ultimoSeguimientoHaceHoras: 10, ultimoMensajeHaceHoras: 60 });
    await runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] });
    expect((await recargar(lead.id)).status).toBe("abierto"); // todavía está dentro de la espera

    await runCampaignFollowUp(new Date(AHORA.getTime() + 39 * HORA), deps, { clinicIds: [c.id] });
    expect(await recargar(lead.id)).toMatchObject({ status: "cerrado", closedReason: "sin_respuesta" });
    expect(send).not.toHaveBeenCalled();
  });

  it("si contestó después del último seguimiento, no se lo cierra hasta que pase la espera desde su respuesta", async () => {
    const c = await crearClinica();
    const camp = await campana(c, { intentos: 1, cada: 48 });
    const lead = await contacto(c, camp.id, { intentos: 1, ultimoSeguimientoHaceHoras: 60, ultimoMensajeHaceHoras: 5 });
    await runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] });
    expect((await recargar(lead.id)).status).toBe("abierto");
    await runCampaignFollowUp(new Date(AHORA.getTime() + 44 * HORA), deps, { clinicIds: [c.id] });
    expect((await recargar(lead.id)).status).toBe("cerrado");
  });

  it("con 0 intentos no se manda nada, y el contacto igual se cierra: no queda 'abierto' para siempre", async () => {
    const c = await crearClinica();
    const camp = await campana(c, { intentos: 0, cada: 48 });
    const reciente = await contacto(c, camp.id, { ultimoMensajeHaceHoras: 30 });
    const viejo = await contacto(c, camp.id, { ultimoMensajeHaceHoras: 60 });
    expect(await runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] })).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect((await recargar(reciente.id)).status).toBe("abierto");
    expect(await recargar(viejo.id)).toMatchObject({ status: "cerrado", closedReason: "sin_respuesta" });
  });

  it("el tope de 5 intentos lo impone la base: ninguna configuración puede saltarlo", async () => {
    const c = await crearClinica();
    await expect(prisma.campaign.create({ data: { clinicId: c.id, name: "Sin tope", followUpMaxAttempts: 6 } })).rejects.toThrow();
    await expect(prisma.campaign.create({ data: { clinicId: c.id, name: "Sin espera", followUpIntervalHours: 0 } })).rejects.toThrow();
  });

  it("no manda más de MAX_FOLLOWUPS_PER_RUN por clínica en una pasada; el resto, en la próxima", async () => {
    const c = await crearClinica();
    const camp = await campana(c);
    for (let i = 0; i < MAX_FOLLOWUPS_PER_RUN + 5; i++) await contacto(c, camp.id, { ultimoMensajeHaceHoras: 30 + i });
    expect(await runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] })).toBe(MAX_FOLLOWUPS_PER_RUN);
    expect(await runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] })).toBe(5);
  });
});

describe("el interruptor de la clínica y el horario", () => {
  it("con el seguimiento apagado en la clínica no se escribe, y los contactos igual se cierran por el tiempo", async () => {
    const c = await crearClinica({ habilitado: false });
    const camp = await campana(c, { intentos: 3, cada: 48 });
    const reciente = await contacto(c, camp.id, { ultimoMensajeHaceHoras: 30 });
    const viejo = await contacto(c, camp.id, { ultimoMensajeHaceHoras: 60 });
    expect(await runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] })).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect((await recargar(reciente.id)).status).toBe("abierto");
    expect((await recargar(viejo.id)).status).toBe("cerrado");
  });

  it("con el interruptor prendido pero un plan que no lo incluye (Base), no se escribe y los contactos igual se cierran", async () => {
    const c = await crearClinica({ habilitado: true, sinPlan: true });
    const camp = await campana(c, { intentos: 3, cada: 48 });
    const reciente = await contacto(c, camp.id, { ultimoMensajeHaceHoras: 30 });
    const viejo = await contacto(c, camp.id, { ultimoMensajeHaceHoras: 60 });
    expect(await runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] })).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect((await recargar(reciente.id)).status).toBe("abierto");
    expect((await recargar(viejo.id)).status).toBe("cerrado");
  });

  it("solo en el horario de la clínica (9 a 18), con su zona horaria", async () => {
    const c = await crearClinica({ timezone: "America/Mexico_City" }); // 12:00 UTC = 06:00 en México
    await contacto(c, (await campana(c)).id);
    expect(await runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] })).toBe(0);
    expect(await runCampaignFollowUp(new Date("2030-06-12T17:00:00Z"), deps, { clinicIds: [c.id] })).toBe(1); // 11:00 en México
  });

  it("fuera de horario no escribe, pero cerrar lo que corresponde sí se hace", async () => {
    const c = await crearClinica();
    const camp = await campana(c, { intentos: 0, cada: 48 });
    const viejo = await contacto(c, camp.id, { ultimoMensajeHaceHoras: 60 });
    await runCampaignFollowUp(new Date("2030-06-12T03:00:00Z"), deps, { clinicIds: [c.id] });
    expect((await recargar(viejo.id)).status).toBe("cerrado");
  });

  it("no se mezclan las clínicas: se le escribe solo a los contactos de la propia", async () => {
    const a = await crearClinica();
    const b = await crearClinica();
    await contacto(a, (await campana(a)).id);
    const deB = await contacto(b, (await campana(b)).id);
    await runCampaignFollowUp(AHORA, deps, { clinicIds: [a.id] });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await recargar(deB.id)).followUpCount).toBe(0);
  });
});

describe("cuando el envío falla o se superponen dos corridas", () => {
  it("si el envío falla, se libera el contacto, se corta la tanda y queda UN evento en Monitoreo", async () => {
    const c = await crearClinica();
    const camp = await campana(c);
    const l1 = await contacto(c, camp.id, { ultimoMensajeHaceHoras: 40 });
    const l2 = await contacto(c, camp.id, { ultimoMensajeHaceHoras: 30 });
    send.mockRejectedValue(new Error("plantilla sin aprobar"));

    expect(await runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] })).toBe(0);

    expect(send).toHaveBeenCalledTimes(1); // se cortó la tanda: con la plantilla sin aprobar fallaría para todos
    expect(await recargar(l1.id)).toMatchObject({ followUpCount: 0, lastFollowUpAt: null });
    expect((await recargar(l2.id)).followUpCount).toBe(0);
    const eventos = await prisma.systemEvent.findMany({ where: { clinicId: c.id, kind: "whatsapp_envio" } });
    expect(eventos).toHaveLength(1);
    expect(eventos[0].message).toContain(FOLLOWUP_TEMPLATE_NAME);
    expect(await prisma.auditLog.count({ where: { clinicId: c.id, action: "campaign.followup_sent" } })).toBe(0);

    // Y se reintenta en la próxima pasada.
    send.mockResolvedValue(undefined);
    expect(await runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] })).toBe(2);
  });

  it("dos corridas a la vez no le escriben dos veces al mismo contacto", async () => {
    const c = await crearClinica();
    const camp = await campana(c, { intentos: 3 });
    for (let i = 0; i < 6; i++) await contacto(c, camp.id, { ultimoMensajeHaceHoras: 30 });

    const [a, b] = await Promise.all([
      runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] }),
      runCampaignFollowUp(AHORA, deps, { clinicIds: [c.id] }),
    ]);

    expect(a + b).toBe(6);
    expect(send).toHaveBeenCalledTimes(6);
    const telefonos = send.mock.calls.map((x) => x[1]);
    expect(new Set(telefonos).size).toBe(6);
  });

  it("un problema de una clínica no deja sin seguimiento a las demás", async () => {
    const rota = await crearClinica();
    // Una zona horaria inválida: reventa fuera del manejo del envío, en el cálculo del horario de la clínica.
    await prisma.clinic.update({ where: { id: rota.id }, data: { timezone: "No/Existe" } });
    const sana = await crearClinica();
    await contacto(rota, (await campana(rota)).id);
    await contacto(sana, (await campana(sana)).id);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await runCampaignFollowUp(AHORA, deps, { clinicIds: [rota.id, sana.id] })).toBe(1);
    } finally {
      log.mockRestore();
    }
    expect(await prisma.systemEvent.count({ where: { clinicId: rota.id, kind: "cron_error" } })).toBe(1);
  });
});

describe("closeStaleLeads", () => {
  it("devuelve cuántos cerró", async () => {
    const c = await crearClinica();
    const camp = await campana(c, { intentos: 0, cada: 24 });
    await contacto(c, camp.id, { ultimoMensajeHaceHoras: 30 });
    await contacto(c, camp.id, { ultimoMensajeHaceHoras: 40 });
    await contacto(c, camp.id, { ultimoMensajeHaceHoras: 5 });
    expect(await closeStaleLeads(c.id, true, AHORA)).toBe(2);
    expect(await closeStaleLeads(c.id, true, AHORA)).toBe(0);
  });
});
