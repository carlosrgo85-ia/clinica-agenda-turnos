import { afterEach, describe, expect, it } from "vitest";
import type { Clinic, Patient, Weekday } from "@prisma/client";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import { findSlotsForPatient } from "../src/services/availability-slots";
import { createAppointmentFromRequest } from "../src/services/booking";
import { resolveServiceForRequest } from "../src/services/catalog";
import { describeActivePromotions, describeCampaignContext, MAX_PROMOCIONES_EN_EL_PROMPT, SIN_CAMPANA, SIN_PROMOCIONES } from "../src/prompts/campaign-context";
import { buildSystemPrompt } from "../src/prompts/system-prompt";
import {
  campaignExtraProfessionalIds,
  campaignStats,
  campaignStatus,
  closeLead,
  createCampaign,
  detectCampaign,
  extractAdSourceId,
  getCampaignContextForPhone,
  listLeads,
  markLeadConverted,
  normalizeTriggerText,
  listVigentCampaigns,
  recordCampaignContact,
  recordCampaignMention,
  textContainsPhrase,
  updateCampaign,
  type CampaignInput,
} from "../src/services/campaigns";
import { purgeAuditForClinics } from "./helpers/audit";

/**
 * Campañas y promociones: reconocer que un mensaje viene de una campaña, atribuirle la persona y la cita, y
 * sumarle profesionales al servicio de la promoción. Contra el Postgres local: docker compose up -d db
 */

const LUNES = "2030-06-17";
const ANTES = new Date("2030-06-17T06:00:00.000Z");
const DIAS: Weekday[] = ["lunes", "martes", "miercoles", "jueves", "viernes"];
const clinicIds: string[] = [];
let telefono = 5491100001000;

async function crearClinica() {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica campañas ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `cp-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: "UTC",
      services: "x",
      professionals: { create: [{ name: "Gómez" }, { name: "Ruiz" }, { name: "Soto" }] },
      rooms: { create: [{ name: "Sala 1" }, { name: "Sala 2" }] },
      workingHours: { create: DIAS.map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 18 * 60 })) },
    },
    include: { professionals: { orderBy: { name: "asc" } } },
  });
  clinicIds.push(clinic.id);
  const [gomez, ruiz, soto] = clinic.professionals;
  const limpieza = await prisma.service.create({
    data: { clinicId: clinic.id, name: "Limpieza", durationMinutes: 30, professionals: { connect: [{ id: gomez.id }, { id: ruiz.id }] } },
  });
  // Blanqueamiento: solo lo hace Ruiz en el catálogo.
  const blanqueamiento = await prisma.service.create({
    data: { clinicId: clinic.id, name: "Blanqueamiento", durationMinutes: 60, professionals: { connect: [{ id: ruiz.id }] } },
  });
  const patient = await prisma.patient.create({ data: { clinicId: clinic.id, phone: String(telefono++), name: "Paciente" } });
  return { clinic, patient, gomez, ruiz, soto, limpieza, blanqueamiento };
}
type F = Awaited<ReturnType<typeof crearClinica>>;

afterEach(async () => {
  await purgeAuditForClinics(clinicIds);
  for (const clinicId of clinicIds) {
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.campaignLead.deleteMany({ where: { clinicId } });
    await prisma.campaign.deleteMany({ where: { clinicId } });
    await prisma.conversationMessage.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.service.deleteMany({ where: { clinicId } });
    await prisma.room.deleteMany({ where: { clinicId } });
    await prisma.workingHours.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

/**
 * Crea una campaña. El servicio es obligatorio: si el test no elige uno, se usa el primero activo de la clínica (con sus
 * profesionales). Pasar `serviceId: null` es pedir "sin servicio" a propósito.
 */
async function crear(clinicId: string, input: Partial<CampaignInput> & { name: string }) {
  const serviceId = input.serviceId === undefined ? (await prisma.service.findFirst({ where: { clinicId, active: true }, orderBy: { name: "asc" } }))?.id : input.serviceId;
  // Los formatos también son obligatorios: si el test no pone ninguno, se le da uno cualquiera (`triggers: []` los pide vacíos).
  const triggers = input.triggers === undefined ? [{ kind: "texto" as const, value: `frase generica ${Math.random().toString(36).slice(2, 8)}` }] : input.triggers;
  return createCampaign(clinicId, { ...input, serviceId, triggers });
}

/** Crea una campaña y falla el test si el servicio la rechaza. */
async function campana(clinicId: string, input: Partial<CampaignInput> = {}) {
  const r = await crear(clinicId, { name: `Campaña ${Math.random()}`, triggers: [{ kind: "texto", value: "promo verano" }], ...input });
  if (!r.ok) throw new Error(`${r.reason}: ${r.message}`);
  return r.value;
}

describe("el anuncio de Meta en el mensaje entrante", () => {
  it("lee el id del anuncio de `referral.source_id`", () => {
    expect(extractAdSourceId({ type: "text", referral: { source_id: "120210000000001", source_type: "ad" } })).toBe("120210000000001");
    expect(extractAdSourceId({ referral: { source_id: "  120  " } })).toBe("120");
  });

  it("sin anuncio, o con un campo raro, es null y no revienta", () => {
    for (const m of [null, undefined, {}, { referral: null }, { referral: {} }, { referral: { source_id: 123 } }, { referral: { source_id: "" } }, { referral: { source_id: "   " } }, { referral: { source_id: "x".repeat(65) } }, "texto"]) {
      expect(extractAdSourceId(m), JSON.stringify(m)).toBeNull();
    }
  });
});

describe("normalizar y reconocer frases", () => {
  it("la frase se normaliza: minúsculas, sin acentos, espacios colapsados", () => {
    expect(normalizeTriggerText("  PROMO   de Verano ")).toBe("promo de verano");
    expect(normalizeTriggerText("Limpieza Dental — ¡Promoción!")).toBe("limpieza dental — ¡promocion!");
  });

  it("matchea palabras enteras, sin importar acentos ni mayúsculas, en cualquier parte del mensaje", () => {
    expect(textContainsPhrase("Hola! Quiero la PROMO de verano por favor", "promo de verano")).toBe(true);
    expect(textContainsPhrase("promoción de verano", "promocion de verano")).toBe(true);
    expect(textContainsPhrase("Hola, vi la promo de verano.", "promo de verano")).toBe(true);
    // No es una palabra entera: "promo" no debería matchear "promocion".
    expect(textContainsPhrase("quiero una promocion", "promo")).toBe(false);
    expect(textContainsPhrase("hola", "promo de verano")).toBe(false);
    expect(textContainsPhrase("hola", "")).toBe(false);
  });

  it("los caracteres especiales de la frase no rompen la búsqueda", () => {
    expect(textContainsPhrase("quiero 2x1 (limpieza)", "2x1 (limpieza)")).toBe(true);
    expect(textContainsPhrase("hola", ".*")).toBe(false);
  });
});

describe("el estado de una campaña", () => {
  const base = { active: true, startsOn: new Date("2030-06-10T00:00:00Z"), endsOn: new Date("2030-06-20T00:00:00Z") };
  it("es inactiva, programada, vigente o vencida según la fecha de la clínica", () => {
    expect(campaignStatus({ ...base, active: false }, "2030-06-15")).toBe("inactiva");
    expect(campaignStatus(base, "2030-06-09")).toBe("programada");
    expect(campaignStatus(base, "2030-06-10")).toBe("vigente");
    expect(campaignStatus(base, "2030-06-20")).toBe("vigente"); // el último día todavía rige
    expect(campaignStatus(base, "2030-06-21")).toBe("vencida");
    expect(campaignStatus({ active: true, startsOn: null, endsOn: null }, "2099-01-01")).toBe("vigente");
  });
});

describe("crear y editar campañas", () => {
  it("crea una campaña con sus formatos normalizados, su servicio y los profesionales que suma", async () => {
    const f = await crearClinica();
    const c = await campana(f.clinic.id, {
      name: "Blanqueamiento de verano",
      channel: "Instagram",
      description: "20 % de descuento",
      serviceId: f.blanqueamiento.id,
      extraProfessionalIds: [f.gomez.id],
      triggers: [{ kind: "texto", value: "  BLANQUEAMIENTO   Verano " }, { kind: "anuncio", value: "120210000000001" }],
    });
    expect(c.triggers.map((t) => `${t.kind}:${t.value}`).sort()).toEqual(["anuncio:120210000000001", "texto:blanqueamiento verano"]);
    expect(c.service?.name).toBe("Blanqueamiento");
    expect(c.extraProfessionals.map((p) => p.id)).toEqual([f.gomez.id]);
    expect(c).toMatchObject({ active: true, channel: "Instagram", followUpMaxAttempts: 2, followUpAfterHours: 24, followUpIntervalHours: 48 });
  });

  it("rechaza lo inválido, con un motivo", async () => {
    const f = await crearClinica();
    const otra = await crearClinica();
    const huerfano = await prisma.service.create({ data: { clinicId: f.clinic.id, name: "Sin profesionales", durationMinutes: 30 } });
    const casos: Array<[Partial<CampaignInput>, string]> = [
      [{ name: "   " }, "nombre_requerido"],
      [{ startsOn: "2030-02-31" }, "fecha_invalida"],
      [{ startsOn: "2030-06-20", endsOn: "2030-06-10" }, "vigencia_invalida"],
      [{ serviceId: "no-existe" }, "servicio_no_encontrado"],
      [{ serviceId: otra.limpieza.id }, "servicio_no_encontrado"], // de otra clínica
      [{ serviceId: null }, "servicio_requerido"], // el servicio es obligatorio
      [{ serviceId: null, extraProfessionalIds: [f.gomez.id] }, "servicio_requerido"],
      [{ serviceId: huerfano.id }, "servicio_sin_profesional"], // un servicio que nadie atiende
      [{ serviceId: f.limpieza.id, extraProfessionalIds: [otra.gomez.id] }, "profesional_no_encontrado"],
      [{ triggers: [{ kind: "texto", value: "hola" }] }, "formato_invalido"], // demasiado corta: matchearía con cualquier saludo
      [{ triggers: [{ kind: "anuncio", value: "con espacios" }] }, "formato_invalido"],
      [{ triggers: [{ kind: "anuncio", value: "" }] }, "formato_invalido"],
      [{ triggers: [{ kind: "otro" as never, value: "xxxx" }] }, "formato_invalido"],
      [{ triggers: Array.from({ length: 11 }, (_, i) => ({ kind: "texto" as const, value: `frase numero ${i}` })) }, "demasiados_formatos"],
      [{ followUpMaxAttempts: 6 }, "seguimiento_invalido"],
      [{ followUpMaxAttempts: -1 }, "seguimiento_invalido"],
      [{ followUpMaxAttempts: 1.5 }, "seguimiento_invalido"],
      [{ followUpAfterHours: 0 }, "seguimiento_invalido"],
      [{ followUpIntervalHours: 721 }, "seguimiento_invalido"],
    ];
    for (const [input, motivo] of casos) {
      const r = await crear(f.clinic.id, { name: "Campaña válida", ...input });
      expect(r.ok, motivo).toBe(false);
      if (!r.ok) expect(r.reason, JSON.stringify(input)).toBe(motivo);
    }
    expect(await prisma.campaign.count({ where: { clinicId: f.clinic.id } })).toBe(0);
  });

  it("una frase de 6 caracteres se acepta y de 5 no: el mínimo evita las que matchearían con cualquier mensaje", async () => {
    const f = await crearClinica();
    expect((await crear(f.clinic.id, { name: "Seis", triggers: [{ kind: "texto", value: "verano" }] })).ok).toBe(true);
    expect(await crear(f.clinic.id, { name: "Cinco", triggers: [{ kind: "texto", value: "promo" }] })).toMatchObject({ ok: false, reason: "formato_invalido" });
  });

  it("0 intentos es válido: es 'sin seguimiento'", async () => {
    const f = await crearClinica();
    const c = await campana(f.clinic.id, { followUpMaxAttempts: 0 });
    expect(c.followUpMaxAttempts).toBe(0);
  });

  it("un servicio desactivado no se puede elegir", async () => {
    const f = await crearClinica();
    await prisma.service.update({ where: { id: f.limpieza.id }, data: { active: false } });
    const r = await crear(f.clinic.id, { name: "X", serviceId: f.limpieza.id });
    expect(r.ok).toBe(false);
  });

  it("el nombre es único por clínica (y se puede repetir en otra)", async () => {
    const f = await crearClinica();
    const otra = await crearClinica();
    await campana(f.clinic.id, { name: "Verano", triggers: [{ kind: "texto", value: "verano uno" }] });
    const repetida = await crear(f.clinic.id, { name: "Verano", triggers: [{ kind: "texto", value: "verano dos" }] });
    expect(repetida).toMatchObject({ ok: false, reason: "nombre_duplicado" });
    expect((await crear(otra.clinic.id, { name: "Verano" })).ok).toBe(true);
  });

  it("un formato no puede ser de dos campañas de la clínica: no se sabría a cuál atribuir", async () => {
    const f = await crearClinica();
    const otra = await crearClinica();
    await campana(f.clinic.id, { name: "A", triggers: [{ kind: "texto", value: "promo verano" }, { kind: "anuncio", value: "999" }] });
    expect(await crear(f.clinic.id, { name: "B", triggers: [{ kind: "texto", value: "PROMO  Verano" }] })).toMatchObject({ ok: false, reason: "formato_duplicado" });
    expect(await crear(f.clinic.id, { name: "C", triggers: [{ kind: "anuncio", value: "999" }] })).toMatchObject({ ok: false, reason: "formato_duplicado" });
    // En otra clínica sí se puede.
    expect((await crear(otra.clinic.id, { name: "B", triggers: [{ kind: "texto", value: "promo verano" }] })).ok).toBe(true);
  });

  it("los formatos repetidos dentro de la misma campaña se juntan en uno", async () => {
    const f = await crearClinica();
    const c = await campana(f.clinic.id, { triggers: [{ kind: "texto", value: "promo verano" }, { kind: "texto", value: "PROMO verano" }] });
    expect(c.triggers).toHaveLength(1);
  });

  it("editar reemplaza los formatos, y se puede quedar con los propios", async () => {
    const f = await crearClinica();
    const c = await campana(f.clinic.id, { triggers: [{ kind: "texto", value: "promo verano" }] });
    const r = await updateCampaign(f.clinic.id, c.id, { triggers: [{ kind: "texto", value: "promo verano" }, { kind: "anuncio", value: "555" }] });
    expect(r.ok && r.value.triggers.map((t) => t.value).sort()).toEqual(["555", "promo verano"]);
    const r2 = await updateCampaign(f.clinic.id, c.id, { triggers: [{ kind: "texto", value: "otra frase" }] });
    expect(r2.ok && r2.value.triggers.map((t) => t.value)).toEqual(["otra frase"]);
  });

  it("editar no toca lo que no se manda, y no puede quedarse con el formato de otra campaña", async () => {
    const f = await crearClinica();
    const a = await campana(f.clinic.id, { name: "A", description: "Detalle", triggers: [{ kind: "texto", value: "frase uno" }] });
    const b = await campana(f.clinic.id, { name: "B", triggers: [{ kind: "texto", value: "frase dos" }] });
    const r = await updateCampaign(f.clinic.id, a.id, { channel: "Radio" });
    expect(r.ok && r.value).toMatchObject({ name: "A", description: "Detalle", channel: "Radio" });
    expect(r.ok && r.value.triggers).toHaveLength(1);
    expect(await updateCampaign(f.clinic.id, b.id, { triggers: [{ kind: "texto", value: "FRASE uno" }] })).toMatchObject({ ok: false, reason: "formato_duplicado" });
  });

  it("sacar el servicio de una campaña activa se rechaza; si se desactiva a la vez, saca también a los profesionales sumados", async () => {
    const f = await crearClinica();
    const c = await campana(f.clinic.id, { serviceId: f.blanqueamiento.id, extraProfessionalIds: [f.gomez.id] });
    expect(await updateCampaign(f.clinic.id, c.id, { serviceId: null })).toMatchObject({ ok: false, reason: "servicio_requerido" });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).serviceId).toBe(f.blanqueamiento.id);

    const r = await updateCampaign(f.clinic.id, c.id, { serviceId: null, active: false });
    expect(r.ok && r.value.extraProfessionals).toEqual([]);
    expect(r.ok && r.value.serviceId).toBeNull();
  });

  it("desactivar y reactivar; una campaña de otra clínica no se puede editar", async () => {
    const f = await crearClinica();
    const otra = await crearClinica();
    const c = await campana(f.clinic.id);
    expect((await updateCampaign(f.clinic.id, c.id, { active: false }))).toMatchObject({ ok: true, value: { active: false } });
    expect((await updateCampaign(f.clinic.id, c.id, { active: true }))).toMatchObject({ ok: true, value: { active: true } });
    expect(await updateCampaign(otra.clinic.id, c.id, { name: "Robada" })).toMatchObject({ ok: false, reason: "no_encontrada" });
  });
});

describe("el servicio de la promoción es obligatorio, y tiene que tener quién lo atienda", () => {
  it("sin servicio no se crea la campaña, ni siquiera desactivada, y el motivo explica para qué sirve", async () => {
    const f = await crearClinica();
    for (const active of [true, false]) {
      const r = await createCampaign(f.clinic.id, { name: `Sin servicio ${active}`, active });
      expect(r).toMatchObject({ ok: false, reason: "servicio_requerido" });
      if (!r.ok) expect(r.message).toMatch(/qué ofrecer ni con qué profesional agendar/);
    }
    expect(await prisma.campaign.count({ where: { clinicId: f.clinic.id } })).toBe(0);
  });

  it("un servicio sin profesionales se acepta solo si la campaña suma al menos uno", async () => {
    const f = await crearClinica();
    const huerfano = await prisma.service.create({ data: { clinicId: f.clinic.id, name: "Sin profesionales", durationMinutes: 30 } });
    const sin = await crear(f.clinic.id, { name: "Huérfana", serviceId: huerfano.id });
    expect(sin).toMatchObject({ ok: false, reason: "servicio_sin_profesional" });
    if (!sin.ok) expect(sin.message).toMatch(/Servicios/);

    const con = await crear(f.clinic.id, { name: "Con uno", serviceId: huerfano.id, extraProfessionalIds: [f.soto.id] });
    expect(con.ok).toBe(true);
  });

  it("un servicio cuyos profesionales están desactivados cuenta como sin profesionales", async () => {
    const f = await crearClinica();
    await prisma.professional.updateMany({ where: { clinicId: f.clinic.id }, data: { active: false } });
    expect(await createCampaign(f.clinic.id, { name: "X", serviceId: f.limpieza.id })).toMatchObject({ ok: false, reason: "servicio_sin_profesional" });
  });

  it("quien atiende es el catálogo MÁS los sumados: con uno del catálogo alcanza", async () => {
    const f = await crearClinica();
    expect((await crear(f.clinic.id, { name: "Alcanza", serviceId: f.blanqueamiento.id })).ok).toBe(true); // solo Ruiz, del catálogo
  });

  it("una campaña activa de antes de la regla no se puede editar sin elegir el servicio, pero sí desactivar", async () => {
    const f = await crearClinica();
    const vieja = await prisma.campaign.create({ data: { clinicId: f.clinic.id, name: "Vieja sin servicio", active: true } });
    expect(await updateCampaign(f.clinic.id, vieja.id, { channel: "Radio" })).toMatchObject({ ok: false, reason: "servicio_requerido" });
    const frase = [{ kind: "texto" as const, value: "frase de la vieja" }];
    expect((await updateCampaign(f.clinic.id, vieja.id, { channel: "Radio", serviceId: f.limpieza.id, triggers: frase })).ok).toBe(true);

    const otra = await prisma.campaign.create({ data: { clinicId: f.clinic.id, name: "Otra vieja", active: true } });
    expect(await updateCampaign(f.clinic.id, otra.id, { active: false })).toMatchObject({ ok: true, value: { active: false } });
  });

  it("una desactivada sin servicio se puede renombrar, pero no volver a activar sin él", async () => {
    const f = await crearClinica();
    const vieja = await prisma.campaign.create({ data: { clinicId: f.clinic.id, name: "Dormida", active: false } });
    expect(await updateCampaign(f.clinic.id, vieja.id, { name: "Dormida (2025)" })).toMatchObject({ ok: true });
    expect(await updateCampaign(f.clinic.id, vieja.id, { active: true })).toMatchObject({ ok: false, reason: "servicio_requerido" });
    expect(await updateCampaign(f.clinic.id, vieja.id, { active: true, serviceId: f.limpieza.id })).toMatchObject({ ok: false, reason: "formato_requerido" });
    expect(await updateCampaign(f.clinic.id, vieja.id, { active: true, serviceId: f.limpieza.id, triggers: [{ kind: "texto", value: "frase dormida" }] })).toMatchObject({ ok: true, value: { active: true } });
  });

  it("si el servicio se queda sin profesionales después, editar la campaña activa se rechaza hasta arreglarlo; desactivarla, no", async () => {
    const f = await crearClinica();
    const c = await campana(f.clinic.id, { serviceId: f.blanqueamiento.id });
    await prisma.professional.update({ where: { id: f.ruiz.id }, data: { active: false } });
    expect(await updateCampaign(f.clinic.id, c.id, { channel: "Radio" })).toMatchObject({ ok: false, reason: "servicio_sin_profesional" });
    expect(await updateCampaign(f.clinic.id, c.id, { channel: "Radio", extraProfessionalIds: [f.gomez.id] })).toMatchObject({ ok: true });
    await prisma.campaign.update({ where: { id: c.id }, data: { active: true } });
    expect(await updateCampaign(f.clinic.id, c.id, { active: false })).toMatchObject({ ok: true });
  });
});

describe("los formatos son obligatorios: sin ninguno nadie sería reconocido", () => {
  it("no se crea una campaña sin formatos, ni siquiera desactivada, y el motivo lo explica", async () => {
    const f = await crearClinica();
    for (const active of [true, false]) {
      const r = await crear(f.clinic.id, { name: `Sin formatos ${active}`, active, triggers: [] });
      expect(r).toMatchObject({ ok: false, reason: "formato_requerido" });
      if (!r.ok) expect(r.message).toMatch(/al menos un formato/);
    }
    expect(await prisma.campaign.count({ where: { clinicId: f.clinic.id } })).toBe(0);
  });

  it("tampoco con formatos que no tienen nada escrito (se quedan en cero)", async () => {
    const f = await crearClinica();
    const r = await crear(f.clinic.id, { name: "Vacía", triggers: [{ kind: "anuncio", value: "   " }] });
    expect(r).toMatchObject({ ok: false, reason: "formato_invalido" });
  });

  it("a una campaña activa no se le pueden sacar todos los formatos", async () => {
    const f = await crearClinica();
    const c = await campana(f.clinic.id, { triggers: [{ kind: "texto", value: "frase unica" }] });
    expect(await updateCampaign(f.clinic.id, c.id, { triggers: [] })).toMatchObject({ ok: false, reason: "formato_requerido" });
    expect((await prisma.campaignTrigger.count({ where: { campaignId: c.id } }))).toBe(1);
    // Desactivándola a la vez sí.
    expect(await updateCampaign(f.clinic.id, c.id, { triggers: [], active: false })).toMatchObject({ ok: true, value: { triggers: [] } });
  });

  it("una activa de antes de la regla, sin formatos, no se puede editar hasta cargarle uno; desactivarla, sí", async () => {
    const f = await crearClinica();
    const vieja = await prisma.campaign.create({ data: { clinicId: f.clinic.id, name: "Sin formatos de antes", active: true, serviceId: f.limpieza.id } });
    expect(await updateCampaign(f.clinic.id, vieja.id, { channel: "Radio" })).toMatchObject({ ok: false, reason: "formato_requerido" });
    expect((await updateCampaign(f.clinic.id, vieja.id, { channel: "Radio", triggers: [{ kind: "texto", value: "promocion de implantes" }] })).ok).toBe(true);

    const otra = await prisma.campaign.create({ data: { clinicId: f.clinic.id, name: "Otra de antes", active: true, serviceId: f.limpieza.id } });
    expect((await updateCampaign(f.clinic.id, otra.id, { active: false })).ok).toBe(true);
  });
});

describe("detectar de qué campaña es un mensaje", () => {
  it("por la frase del mensaje, y solo en campañas activas de la clínica", async () => {
    const f = await crearClinica();
    const otra = await crearClinica();
    const c = await campana(f.clinic.id, { triggers: [{ kind: "texto", value: "promo verano" }] });
    await campana(otra.clinic.id, { triggers: [{ kind: "texto", value: "promo verano" }] });

    expect((await detectCampaign({ clinicId: f.clinic.id, text: "Hola, vi la PROMO verano en Instagram" }))?.campaign.id).toBe(c.id);
    expect(await detectCampaign({ clinicId: f.clinic.id, text: "hola, quiero un turno" })).toBeNull();

    await updateCampaign(f.clinic.id, c.id, { active: false });
    expect(await detectCampaign({ clinicId: f.clinic.id, text: "promo verano" })).toBeNull();
  });

  it("por el id del anuncio de Meta, sin importar lo que escribió", async () => {
    const f = await crearClinica();
    const c = await campana(f.clinic.id, { triggers: [{ kind: "anuncio", value: "120210000000001" }] });
    const hit = await detectCampaign({ clinicId: f.clinic.id, text: "Hola", adSourceId: "120210000000001" });
    expect(hit).toMatchObject({ triggerKind: "anuncio", campaign: { id: c.id } });
    expect(await detectCampaign({ clinicId: f.clinic.id, text: "Hola", adSourceId: "otro-anuncio" })).toBeNull();
    // El id de un anuncio no matchea como texto.
    expect(await detectCampaign({ clinicId: f.clinic.id, text: "120210000000001" })).toBeNull();
  });

  it("el mensaje tiene que CONTENER la frase: una frase larga (o con un typo) no coincide con un mensaje más corto o distinto", async () => {
    const f = await crearClinica();
    const larga = "hola , escribo por la promioen en implantes dentales, me gustaria hacer una cita"; // una oración entera, con un typo
    const c = await campana(f.clinic.id, { triggers: [{ kind: "texto", value: larga }] });
    const detecta = (text: string) => detectCampaign({ clinicId: f.clinic.id, text });

    expect(await detecta("Hola , escribo por la promoción en implantes dentales")).toBeNull(); // más corto y sin el typo
    expect(await detecta("escribo por la promoción de implantes")).toBeNull();
    expect((await detecta(larga))?.campaign.id).toBe(c.id); // idéntico, sí
    expect((await detecta(`${larga}. Gracias!`))?.campaign.id).toBe(c.id); // con algo más, sí (la contiene)

    // Con una frase corta y propia de la campaña, los mensajes parecidos se reconocen.
    await updateCampaign(f.clinic.id, c.id, { triggers: [{ kind: "texto", value: "promocion en implantes" }] });
    expect((await detecta("Hola , escribo por la promoción en implantes dentales"))?.campaign.id).toBe(c.id);
    expect(await detecta("escribo por la promoción de implantes")).toBeNull(); // "de" no es "en": otra frase, otro formato
  });

  it("dice por qué formato se reconoció", async () => {
    const f = await crearClinica();
    await campana(f.clinic.id, { triggers: [{ kind: "texto", value: "promo verano" }, { kind: "anuncio", value: "777" }] });
    expect(await detectCampaign({ clinicId: f.clinic.id, text: "la PROMO verano!" })).toMatchObject({ triggerKind: "texto", trigger: "promo verano" });
    expect(await detectCampaign({ clinicId: f.clinic.id, text: "hola", adSourceId: "777" })).toMatchObject({ triggerKind: "anuncio", trigger: "777" });
  });

  it("el anuncio gana sobre la frase; entre frases, la más específica (larga)", async () => {
    const f = await crearClinica();
    const porAnuncio = await campana(f.clinic.id, { name: "Anuncio", triggers: [{ kind: "anuncio", value: "777" }] });
    await campana(f.clinic.id, { name: "General", triggers: [{ kind: "texto", value: "limpieza" }] });
    const especifica = await campana(f.clinic.id, { name: "Específica", triggers: [{ kind: "texto", value: "limpieza de verano" }] });

    expect((await detectCampaign({ clinicId: f.clinic.id, text: "limpieza", adSourceId: "777" }))?.campaign.id).toBe(porAnuncio.id);
    expect((await detectCampaign({ clinicId: f.clinic.id, text: "quiero la limpieza de verano" }))?.campaign.id).toBe(especifica.id);
    expect((await detectCampaign({ clinicId: f.clinic.id, text: "quiero una limpieza" }))?.campaign.name).toBe("General");
  });
});

describe("registrar el contacto de una campaña", () => {
  it("crea el contacto la primera vez, lo marca como nuevo y lo audita sin el teléfono", async () => {
    const f = await crearClinica();
    const c = await campana(f.clinic.id);
    const tel = "5491100009999";
    const r = await recordCampaignContact({ clinicId: f.clinic.id, phone: tel, text: "Hola, quiero la promo verano" });

    expect(r.created).toBe(true);
    expect(r.lead).toMatchObject({ campaignId: c.id, patientPhone: tel, triggerKind: "texto", isNewContact: true, status: "abierto", followUpCount: 0 });
    const filas = await prisma.auditLog.findMany({ where: { clinicId: f.clinic.id, action: "campaign.lead_create" } });
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ origin: "whatsapp", resourceId: r.lead!.id });
    expect(JSON.stringify(filas[0])).not.toContain(tel);
    expect(JSON.stringify(filas[0])).not.toContain("promo verano");
  });

  it("es una sola vez por campaña y número, aunque escriba muchas veces (también a la vez)", async () => {
    const f = await crearClinica();
    await campana(f.clinic.id);
    const tel = "5491100009998";
    const params = { clinicId: f.clinic.id, phone: tel, text: "promo verano" };
    const resultados = await Promise.all([recordCampaignContact(params), recordCampaignContact(params), recordCampaignContact(params)]);
    expect(await prisma.campaignLead.count({ where: { clinicId: f.clinic.id } })).toBe(1);
    expect(resultados.filter((r) => r.created)).toHaveLength(1);
    expect(resultados.every((r) => r.lead)).toBe(true);
    expect(await prisma.auditLog.count({ where: { clinicId: f.clinic.id, action: "campaign.lead_create" } })).toBe(1);
  });

  it("no es un contacto nuevo si el número ya era paciente o ya había conversado", async () => {
    const f = await crearClinica();
    await campana(f.clinic.id);
    const conocido = await recordCampaignContact({ clinicId: f.clinic.id, phone: f.patient.phone, text: "promo verano" });
    expect(conocido.lead?.isNewContact).toBe(false);

    await prisma.conversationMessage.create({ data: { clinicId: f.clinic.id, patientPhone: "5491100009997", role: "patient", content: "hola" } });
    const conversado = await recordCampaignContact({ clinicId: f.clinic.id, phone: "5491100009997", text: "promo verano" });
    expect(conversado.lead?.isNewContact).toBe(false);
  });

  it("un mensaje que no es de una campaña no crea nada, pero anota que el número volvió a escribir", async () => {
    const f = await crearClinica();
    await campana(f.clinic.id);
    const tel = "5491100009996";
    const antes = new Date("2030-06-10T10:00:00Z");
    await recordCampaignContact({ clinicId: f.clinic.id, phone: tel, text: "promo verano", now: antes });

    const r = await recordCampaignContact({ clinicId: f.clinic.id, phone: tel, text: "¿tienen turno mañana?", now: new Date("2030-06-12T10:00:00Z") });
    expect(r.matched).toBeNull();
    expect(r.lead).toBeNull();
    const lead = await prisma.campaignLead.findFirstOrThrow({ where: { clinicId: f.clinic.id } });
    expect(lead.lastInboundAt.toISOString()).toBe("2030-06-12T10:00:00.000Z");
    expect(lead.firstMessageAt.toISOString()).toBe(antes.toISOString());
  });

  it("no toca los contactos de otros números ni los ya cerrados", async () => {
    const f = await crearClinica();
    await campana(f.clinic.id);
    const antes = new Date("2030-06-10T10:00:00Z");
    await recordCampaignContact({ clinicId: f.clinic.id, phone: "5491100008001", text: "promo verano", now: antes });
    await recordCampaignContact({ clinicId: f.clinic.id, phone: "5491100008002", text: "promo verano", now: antes });
    const cerrado = await prisma.campaignLead.findFirstOrThrow({ where: { patientPhone: "5491100008002" } });
    await closeLead({ clinicId: f.clinic.id, leadId: cerrado.id, reason: "cerrado_por_la_clinica" });

    await recordCampaignContact({ clinicId: f.clinic.id, phone: "5491100008001", text: "hola", now: new Date("2030-06-12T10:00:00Z") });
    const otro = await prisma.campaignLead.findFirstOrThrow({ where: { patientPhone: "5491100008002" } });
    expect(otro.lastInboundAt.toISOString()).toBe(antes.toISOString());
    expect(otro.status).toBe("cerrado");
  });

  it("si vuelve con la frase de la campaña tras cerrarse por no contestar, se reabre; si lo cerró otra causa, no", async () => {
    const f = await crearClinica();
    await campana(f.clinic.id);
    const tel = "5491100007001";
    const creado = await recordCampaignContact({ clinicId: f.clinic.id, phone: tel, text: "promo verano" });
    await prisma.campaignLead.update({ where: { id: creado.lead!.id }, data: { status: "cerrado", closedReason: "sin_respuesta", closedAt: new Date(), followUpCount: 2 } });

    const reabierto = await recordCampaignContact({ clinicId: f.clinic.id, phone: tel, text: "promo verano otra vez" });
    expect(reabierto.lead).toMatchObject({ status: "abierto", closedReason: null, closedAt: null, followUpCount: 2 }); // el tope de seguimientos se conserva

    await prisma.campaignLead.update({ where: { id: creado.lead!.id }, data: { status: "cerrado", closedReason: "solicitud_del_paciente" } });
    const sigueCerrado = await recordCampaignContact({ clinicId: f.clinic.id, phone: tel, text: "promo verano" });
    expect(sigueCerrado.lead?.status).toBe("cerrado");
  });

  it("sin ninguna campaña no hace nada", async () => {
    const f = await crearClinica();
    const r = await recordCampaignContact({ clinicId: f.clinic.id, phone: "5491100006001", text: "hola" });
    expect(r).toMatchObject({ matched: null, lead: null, created: false });
  });
});

describe("la campaña de un número y su conversión", () => {
  it("la campaña por la que llegó un número dentro de los últimos 30 días; la más reciente gana", async () => {
    const f = await crearClinica();
    const a = await campana(f.clinic.id, { name: "A", triggers: [{ kind: "texto", value: "frase aaaa" }] });
    const b = await campana(f.clinic.id, { name: "B", triggers: [{ kind: "texto", value: "frase bbbb" }] });
    const tel = "5491100005001";
    await recordCampaignContact({ clinicId: f.clinic.id, phone: tel, text: "frase aaaa", now: new Date("2030-06-01T10:00:00Z") });
    await recordCampaignContact({ clinicId: f.clinic.id, phone: tel, text: "frase bbbb", now: new Date("2030-06-05T10:00:00Z") });

    const ctx = await getCampaignContextForPhone({ clinicId: f.clinic.id, phone: tel, timezone: "UTC", now: new Date("2030-06-10T10:00:00Z") });
    expect(ctx?.campaign.id).toBe(b.id);
    expect(ctx).toMatchObject({ status: "vigente", vigente: true });
    expect(a.id).not.toBe(b.id);
  });

  it("pasados los 30 días ya no se le atribuye; otro número o clínica, nunca", async () => {
    const f = await crearClinica();
    const otra = await crearClinica();
    await campana(f.clinic.id);
    const tel = "5491100005002";
    await recordCampaignContact({ clinicId: f.clinic.id, phone: tel, text: "promo verano", now: new Date("2030-06-01T10:00:00Z") });
    const base = { phone: tel, timezone: "UTC" };
    expect(await getCampaignContextForPhone({ ...base, clinicId: f.clinic.id, now: new Date("2030-06-30T10:00:00Z") })).not.toBeNull();
    expect(await getCampaignContextForPhone({ ...base, clinicId: f.clinic.id, now: new Date("2030-07-02T10:00:00Z") })).toBeNull();
    expect(await getCampaignContextForPhone({ ...base, clinicId: otra.clinic.id, now: new Date("2030-06-10T10:00:00Z") })).toBeNull();
    expect(await getCampaignContextForPhone({ clinicId: f.clinic.id, phone: "5491100005999", timezone: "UTC", now: new Date("2030-06-10T10:00:00Z") })).toBeNull();
  });

  it("una campaña vencida sigue atribuyendo, pero deja de estar vigente para el asistente", async () => {
    const f = await crearClinica();
    await campana(f.clinic.id, { startsOn: "2030-05-01", endsOn: "2030-05-31" });
    const tel = "5491100005003";
    await recordCampaignContact({ clinicId: f.clinic.id, phone: tel, text: "promo verano", now: new Date("2030-06-05T10:00:00Z") });
    const ctx = await getCampaignContextForPhone({ clinicId: f.clinic.id, phone: tel, timezone: "UTC", now: new Date("2030-06-10T10:00:00Z") });
    expect(ctx).toMatchObject({ status: "vencida", vigente: false });
  });

  it("markLeadConverted marca una sola vez y audita sin teléfono; closeLead solo cierra los abiertos de la clínica", async () => {
    const f = await crearClinica();
    const otra = await crearClinica();
    await campana(f.clinic.id);
    const r = await recordCampaignContact({ clinicId: f.clinic.id, phone: "5491100004001", text: "promo verano" });
    const lead = r.lead!;

    expect(await closeLead({ clinicId: otra.clinic.id, leadId: lead.id, reason: "cerrado_por_la_clinica" })).toBe(false);
    expect(await markLeadConverted(lead, "cita-1")).toBe(true);
    expect(await markLeadConverted(lead, "cita-1")).toBe(false);
    expect(await prisma.auditLog.count({ where: { clinicId: f.clinic.id, action: "campaign.lead_converted" } })).toBe(1);
    expect(await closeLead({ clinicId: f.clinic.id, leadId: lead.id, reason: "cerrado_por_la_clinica" })).toBe(false); // ya agendó: no está abierto
    const fila = await prisma.campaignLead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(fila).toMatchObject({ status: "convertido" });
    expect(fila.convertedAt).not.toBeNull();
  });

  it("si agenda después de haberse cerrado por no contestar, igual pasa a convertido", async () => {
    const f = await crearClinica();
    await campana(f.clinic.id);
    const lead = (await recordCampaignContact({ clinicId: f.clinic.id, phone: "5491100004002", text: "promo verano" })).lead!;
    await prisma.campaignLead.update({ where: { id: lead.id }, data: { status: "cerrado", closedReason: "sin_respuesta", closedAt: new Date() } });
    expect(await markLeadConverted(lead, "cita-2")).toBe(true);
    expect(await prisma.campaignLead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ status: "convertido", closedReason: null });
  });
});

describe("la campaña le suma profesionales al servicio de la promoción", () => {
  const hoyKey = "2030-06-17";
  const extras = (c: Awaited<ReturnType<typeof campana>>, serviceId: string, hoy = hoyKey) => campaignExtraProfessionalIds(c, serviceId, hoy);

  it("solo para el servicio de la promoción, solo si está vigente y solo con profesionales activos", async () => {
    const f = await crearClinica();
    const c = await campana(f.clinic.id, { serviceId: f.blanqueamiento.id, extraProfessionalIds: [f.gomez.id, f.soto.id], startsOn: "2030-06-01", endsOn: "2030-06-30" });
    expect(extras(c, f.blanqueamiento.id).sort()).toEqual([f.gomez.id, f.soto.id].sort());
    expect(extras(c, f.limpieza.id)).toEqual([]); // otro servicio: no los habilita
    expect(extras(c, f.blanqueamiento.id, "2030-07-01")).toEqual([]); // vencida
    expect(extras(c, f.blanqueamiento.id, "2030-05-31")).toEqual([]); // todavía no empezó
    await prisma.professional.update({ where: { id: f.soto.id }, data: { active: false } });
    const recargada = (await prisma.campaign.findUniqueOrThrow({ where: { id: c.id }, include: { extraProfessionals: { select: { id: true, name: true, active: true } }, triggers: true, service: { select: { id: true, name: true, active: true } } } }));
    expect(extras(recargada, f.blanqueamiento.id)).toEqual([f.gomez.id]);
  });

  it("resolveServiceForRequest SUMA a los del catálogo, no los reemplaza", async () => {
    const f = await crearClinica();
    const c = await campana(f.clinic.id, { serviceId: f.blanqueamiento.id, extraProfessionalIds: [f.gomez.id] });

    const sin = await resolveServiceForRequest(f.clinic, "blanqueamiento", prisma, { patientId: f.patient.id });
    expect(sin.allowedProfessionalIds).toEqual([f.ruiz.id]);
    expect(sin.campaignProfessionalIds).toEqual([]);

    const con = await resolveServiceForRequest(f.clinic, "blanqueamiento", prisma, { patientId: f.patient.id, campaignId: c.id });
    expect([...(con.allowedProfessionalIds ?? [])].sort()).toEqual([f.gomez.id, f.ruiz.id].sort());
    expect(con.campaignProfessionalIds).toEqual([f.gomez.id]);

    // Pedir OTRO servicio con la misma campaña no cambia nada.
    const otro = await resolveServiceForRequest(f.clinic, "limpieza", prisma, { patientId: f.patient.id, campaignId: c.id });
    expect([...(otro.allowedProfessionalIds ?? [])].sort()).toEqual([f.gomez.id, f.ruiz.id].sort());
    expect(otro.campaignProfessionalIds).toEqual([]);
  });

  it("una campaña vencida, desactivada o de otra clínica no suma a nadie", async () => {
    const f = await crearClinica();
    const otra = await crearClinica();
    const vencida = await campana(f.clinic.id, { name: "Vencida", triggers: [{ kind: "texto", value: "frase vencida" }], serviceId: f.blanqueamiento.id, extraProfessionalIds: [f.gomez.id], endsOn: "2020-01-01" });
    const apagada = await campana(f.clinic.id, { name: "Apagada", triggers: [{ kind: "texto", value: "frase apagada" }], serviceId: f.blanqueamiento.id, extraProfessionalIds: [f.gomez.id], active: false });
    const ajena = await campana(otra.clinic.id, { serviceId: otra.blanqueamiento.id, extraProfessionalIds: [otra.gomez.id] });
    for (const c of [vencida, apagada, ajena]) {
      const r = await resolveServiceForRequest(f.clinic, "blanqueamiento", prisma, { patientId: f.patient.id, campaignId: c.id });
      expect(r.allowedProfessionalIds, c.name).toEqual([f.ruiz.id]);
    }
  });

  it("con el servicio de primera vez forzado, la campaña no suma (ya no es el servicio de la promoción)", async () => {
    const f = await crearClinica();
    await prisma.service.update({ where: { id: f.limpieza.id }, data: { firstVisit: true } });
    const c = await campana(f.clinic.id, { serviceId: f.blanqueamiento.id, extraProfessionalIds: [f.soto.id] });
    const r = await resolveServiceForRequest(f.clinic, "blanqueamiento", prisma, { patientId: f.patient.id, campaignId: c.id });
    expect(r.firstVisitForced).toBe(true);
    expect(r.service?.id).toBe(f.limpieza.id);
    expect(r.campaignProfessionalIds).toEqual([]);
  });
});

describe("ofrecer horarios y agendar con la campaña", () => {
  const pedido = (f: F, o: Partial<Parameters<typeof createAppointmentFromRequest>[0]>) =>
    createAppointmentFromRequest({
      clinic: f.clinic as Clinic, patient: f.patient as Patient,
      requestedDate: LUNES, requestedTime: "10:00", requestedService: "blanqueamiento", now: ANTES, ...o,
    });

  it("con la campaña se agenda con un profesional que el catálogo no asigna al servicio, y la cita queda atribuida", async () => {
    const f = await crearClinica();
    const c = await campana(f.clinic.id, { serviceId: f.blanqueamiento.id, extraProfessionalIds: [f.gomez.id] });
    const r = await pedido(f, { requestedProfessionalId: f.gomez.id, campaignId: c.id });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.appointment.professionalId).toBe(f.gomez.id);
    expect(r.appointment.campaignId).toBe(c.id);
  });

  it("sin la campaña, ese mismo pedido se ignora y se agenda con quien hace el servicio", async () => {
    const f = await crearClinica();
    await campana(f.clinic.id, { serviceId: f.blanqueamiento.id, extraProfessionalIds: [f.gomez.id] });
    const r = await pedido(f, { requestedProfessionalId: f.gomez.id });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.appointment.professionalId).toBe(f.ruiz.id);
      expect(r.appointment.campaignId).toBeNull();
    }
  });

  it("con la campaña vencida no se puede agendar con el profesional sumado (pero la cita igual queda atribuida)", async () => {
    const f = await crearClinica();
    const c = await campana(f.clinic.id, { serviceId: f.blanqueamiento.id, extraProfessionalIds: [f.gomez.id], endsOn: "2020-01-01" });
    const r = await pedido(f, { requestedProfessionalId: f.gomez.id, campaignId: c.id });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.appointment.professionalId).toBe(f.ruiz.id);
      expect(r.appointment.campaignId).toBe(c.id);
    }
  });

  it("no se atribuye a una campaña de otra clínica", async () => {
    const f = await crearClinica();
    const otra = await crearClinica();
    const ajena = await campana(otra.clinic.id);
    const r = await pedido(f, { requestedService: "limpieza", campaignId: ajena.id });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.appointment.campaignId).toBeNull();
  });

  it("los horarios que se ofrecen incluyen al profesional que suma la campaña", async () => {
    const f = await crearClinica();
    const c = await campana(f.clinic.id, { serviceId: f.blanqueamiento.id, extraProfessionalIds: [f.soto.id] });
    const ids = (r: Awaited<ReturnType<typeof findSlotsForPatient>>) =>
      new Set(r.days.flatMap((d) => d.slots.flatMap((s) => s.candidateProfessionals.map((p) => p.id))));
    const base = { clinic: f.clinic as Clinic, patient: f.patient, requestedService: "blanqueamiento", fromDateKey: LUNES, days: 1, now: ANTES };

    expect(ids(await findSlotsForPatient(base))).toEqual(new Set([f.ruiz.id]));
    expect(ids(await findSlotsForPatient({ ...base, campaignId: c.id }))).toEqual(new Set([f.ruiz.id, f.soto.id]));
  });
});

describe("el contexto que lee el asistente", () => {
  const base = { name: "Blanqueamiento de verano", channel: "Instagram", description: "20 % de descuento hasta fin de mes", status: "vigente" as const, endsOn: "2030-06-30", startsOn: null, serviceName: "Blanqueamiento", professionals: ["Dra. Gómez", "Ruiz"] };

  it("sin campaña, lo dice", () => {
    expect(describeCampaignContext(null)).toBe(SIN_CAMPANA);
  });

  it("vigente: nombre, canal, detalle, servicio y quiénes lo atienden", () => {
    const t = describeCampaignContext(base);
    expect(t).toContain('"Blanqueamiento de verano"');
    expect(t).toContain("canal: Instagram");
    expect(t).toContain("VIGENTE");
    expect(t).toContain("hasta el 2030-06-30");
    expect(t).toContain("20 % de descuento hasta fin de mes");
    expect(t).toContain("Servicio de la promoción: Blanqueamiento.");
    expect(t).toContain("Lo atienden: Dra. Gómez, Ruiz.");
  });

  it("sin descripción, le prohíbe inventar; sin profesionales, no ofrece horarios", () => {
    expect(describeCampaignContext({ ...base, description: null })).toMatch(/no cuentes condiciones, precios ni descuentos/);
    expect(describeCampaignContext({ ...base, professionals: [] })).toMatch(/no ofrezcas horarios/);
  });

  it("vencida o programada: no la ofrece ni la detalla", () => {
    const vencida = describeCampaignContext({ ...base, status: "vencida" });
    expect(vencida).toMatch(/YA NO ESTÁ VIGENTE/);
    expect(vencida).not.toContain("20 % de descuento");
    expect(vencida).not.toContain("Lo atienden");
    const programada = describeCampaignContext({ ...base, status: "programada", startsOn: "2030-07-01" });
    expect(programada).toMatch(/TODAVÍA NO EMPEZÓ/);
    expect(programada).not.toContain("20 % de descuento");
  });
});

describe("contactos y estadísticas", () => {
  it("listLeads trae el nombre del titular y no mezcla clínicas; campaignStats cuenta por período", async () => {
    const f = await crearClinica();
    const otra = await crearClinica();
    const c = await campana(f.clinic.id, { triggers: [{ kind: "texto", value: "promo verano" }, { kind: "anuncio", value: "42" }] });
    await campana(otra.clinic.id, { triggers: [{ kind: "texto", value: "promo verano" }] });

    const dentro = new Date("2030-06-10T10:00:00Z");
    await recordCampaignContact({ clinicId: f.clinic.id, phone: f.patient.phone, text: "promo verano", now: dentro }); // ya era paciente
    const nuevo = await recordCampaignContact({ clinicId: f.clinic.id, phone: "5491100003001", text: "hola", adSourceId: "42", now: dentro });
    await recordCampaignContact({ clinicId: f.clinic.id, phone: "5491100003002", text: "promo verano", now: new Date("2030-04-01T10:00:00Z") }); // fuera del período
    await recordCampaignContact({ clinicId: otra.clinic.id, phone: "5491100003003", text: "promo verano", now: dentro });
    await markLeadConverted(nuevo.lead!, "cita-x");
    await prisma.appointment.create({
      data: {
        clinicId: f.clinic.id, patientId: f.patient.id, professionalId: f.gomez.id, roomId: (await prisma.room.findFirstOrThrow({ where: { clinicId: f.clinic.id } })).id,
        service: "Limpieza", startTime: new Date("2030-06-20T10:00:00Z"), endTime: new Date("2030-06-20T10:30:00Z"), campaignId: c.id, createdAt: dentro,
      },
    });

    const leads = await listLeads({ clinicId: f.clinic.id });
    expect(leads).toHaveLength(3);
    expect(leads.find((l) => l.patientPhone === f.patient.phone)?.patientName).toBe("Paciente");
    expect(leads.find((l) => l.patientPhone === "5491100003001")?.patientName).toBeNull();
    expect((await listLeads({ clinicId: f.clinic.id, status: "convertido" })).map((l) => l.patientPhone)).toEqual(["5491100003001"]);
    expect((await listLeads({ clinicId: f.clinic.id, campaignId: "no-existe" }))).toEqual([]);

    const stats = await campaignStats({ clinicId: f.clinic.id, from: new Date("2030-06-01T00:00:00Z"), toExclusive: new Date("2030-07-01T00:00:00Z") });
    expect(stats.get(c.id)).toMatchObject({ contacts: 2, newContacts: 1, converted: 1, open: 1, appointments: 1, viaAd: 1, viaText: 1, followUpsSent: 0 });
  });
});


describe("reconocer la campaña por lo que dijo la persona (sin que coincida un formato)", () => {
  const mencion = (clinicId: string, phone: string, nombre: string | null, extra: { isNewContact?: boolean; now?: Date } = {}) =>
    recordCampaignMention({ clinicId, phone, campaignName: nombre, timezone: "UTC", isNewContact: extra.isNewContact ?? true, now: extra.now });

  it("resuelve el nombre contra las campañas vigentes, sin acentos ni mayúsculas, y crea el contacto con el origen 'asistente'", async () => {
    const f = await crearClinica();
    const c = await campana(f.clinic.id, { name: "Promoción de Implantes" });
    const r = await mencion(f.clinic.id, "5491100001111", "  promocion DE implantes ");
    expect(r).toMatchObject({ created: true, campaign: { id: c.id } });
    const lead = await prisma.campaignLead.findFirstOrThrow({ where: { clinicId: f.clinic.id } });
    expect(lead).toMatchObject({ triggerKind: "asistente", isNewContact: true, status: "abierto", patientPhone: "5491100001111" });
  });

  it("se audita sin el teléfono ni el texto", async () => {
    const f = await crearClinica();
    await campana(f.clinic.id, { name: "Implantes" });
    await mencion(f.clinic.id, "5491100001112", "Implantes");
    const fila = await prisma.auditLog.findFirstOrThrow({ where: { clinicId: f.clinic.id, action: "campaign.lead_create" } });
    expect(fila).toMatchObject({ origin: "whatsapp" });
    expect(fila.details).toMatchObject({ formato: "asistente" });
    expect(JSON.stringify(fila)).not.toContain("5491100001112");
  });

  it("un nombre inventado, vacío o aproximado no atribuye nada: tiene que ser exacto", async () => {
    const f = await crearClinica();
    await campana(f.clinic.id, { name: "Implantes" });
    for (const nombre of [null, "", "   ", "Ortodoncia", "Implante", "Implantes dentales", "implantes 2x1"]) {
      expect(await mencion(f.clinic.id, "5491100001113", nombre), String(nombre)).toBeNull();
    }
    expect(await prisma.campaignLead.count({ where: { clinicId: f.clinic.id } })).toBe(0);
  });

  it("solo campañas VIGENTES de ESTA clínica: ni vencidas, ni programadas, ni desactivadas, ni de otra", async () => {
    const f = await crearClinica();
    const otra = await crearClinica();
    const frase = (v: string) => [{ kind: "texto" as const, value: `frase de ${v}` }];
    await campana(f.clinic.id, { name: "Vencida", endsOn: "2020-01-01", triggers: frase("vencida") });
    await campana(f.clinic.id, { name: "Futura", startsOn: "2099-01-01", triggers: frase("futura") });
    await campana(f.clinic.id, { name: "Apagada", active: false, triggers: frase("apagada") });
    await campana(otra.clinic.id, { name: "Ajena", triggers: frase("ajena") });
    for (const nombre of ["Vencida", "Futura", "Apagada", "Ajena"]) {
      expect(await mencion(f.clinic.id, "5491100001114", nombre), nombre).toBeNull();
    }
    expect(await prisma.campaignLead.count({ where: { clinicId: { in: [f.clinic.id, otra.clinic.id] } } })).toBe(0);
  });

  it("es una sola vez por campaña y número, también a la vez, y si ya existe solo actualiza su último mensaje", async () => {
    const f = await crearClinica();
    await campana(f.clinic.id, { name: "Implantes" });
    const rs = await Promise.all([1, 2, 3].map(() => mencion(f.clinic.id, "5491100001115", "Implantes")));
    expect(await prisma.campaignLead.count({ where: { clinicId: f.clinic.id } })).toBe(1);
    expect(rs.filter((r) => r?.created)).toHaveLength(1);

    const despues = new Date("2030-06-12T10:00:00Z");
    const otra = await mencion(f.clinic.id, "5491100001115", "Implantes", { now: despues });
    expect(otra).toMatchObject({ created: false });
    expect((await prisma.campaignLead.findFirstOrThrow({ where: { clinicId: f.clinic.id } })).lastInboundAt.toISOString()).toBe(despues.toISOString());
  });

  it("recuerda si era un contacto nuevo", async () => {
    const f = await crearClinica();
    await campana(f.clinic.id, { name: "Implantes" });
    await mencion(f.clinic.id, "5491100001116", "Implantes", { isNewContact: false });
    expect((await prisma.campaignLead.findFirstOrThrow({ where: { clinicId: f.clinic.id } })).isNewContact).toBe(false);
  });

  it("el contacto queda disponible como la campaña del número, igual que si hubiera coincidido un formato", async () => {
    const f = await crearClinica();
    const c = await campana(f.clinic.id, { name: "Implantes" });
    await mencion(f.clinic.id, "5491100001117", "Implantes");
    const ctx = await getCampaignContextForPhone({ clinicId: f.clinic.id, phone: "5491100001117", timezone: "UTC" });
    expect(ctx).toMatchObject({ vigente: true, campaign: { id: c.id }, lead: { triggerKind: "asistente" } });
  });

  it("listVigentCampaigns trae solo las que rigen hoy", async () => {
    const f = await crearClinica();
    const frase = (v: string) => [{ kind: "texto" as const, value: `frase de ${v}` }];
    await campana(f.clinic.id, { name: "Vigente", triggers: frase("vigente") });
    await campana(f.clinic.id, { name: "Con fechas", startsOn: "2020-01-01", endsOn: "2099-12-31", triggers: frase("con fechas") });
    await campana(f.clinic.id, { name: "Vencida", endsOn: "2020-01-01", triggers: frase("vencida") });
    await campana(f.clinic.id, { name: "Apagada", active: false, triggers: frase("apagada") });
    expect((await listVigentCampaigns(f.clinic.id, "UTC")).map((c) => c.name).sort()).toEqual(["Con fechas", "Vigente"]);
  });
});

describe("las promociones vigentes que lee el asistente", () => {
  const p = (name: string, over: Record<string, unknown> = {}) => ({ name, description: "20 % de descuento", serviceName: "Implantes", professionals: ["Dr. Ruiz"], ...over });

  it("sin promociones, lo dice", () => {
    expect(describeActivePromotions([])).toBe(SIN_PROMOCIONES);
  });

  it("lista cada una con su nombre entre comillas, servicio, quién lo atiende y su detalle", () => {
    const t = describeActivePromotions([p("Implantes"), p("Limpieza", { serviceName: "Limpieza", professionals: ["Dra. Gómez", "Soto"], description: "2x1 en junio" })]);
    expect(t.split("\n")).toEqual([
      '1. "Implantes" — Servicio: Implantes. Lo atienden: Dr. Ruiz. Detalle: 20 % de descuento',
      '2. "Limpieza" — Servicio: Limpieza. Lo atienden: Dra. Gómez, Soto. Detalle: 2x1 en junio',
    ]);
  });

  it("sin detalle le prohíbe inventar condiciones; el detalle largo se recorta y se compacta", () => {
    expect(describeActivePromotions([p("X", { description: null })])).toMatch(/no cuentes condiciones, precios ni descuentos/);
    const largo = describeActivePromotions([p("X", { description: `Linea uno\n\n   linea dos ${"a".repeat(2000)}` })]);
    expect(largo).not.toContain("\n\n");
    expect(largo.length).toBeLessThan(700);
  });

  it("muestra como máximo 10", () => {
    const muchas = Array.from({ length: MAX_PROMOCIONES_EN_EL_PROMPT + 5 }, (_, i) => p(`Promo ${i}`));
    expect(describeActivePromotions(muchas).split("\n")).toHaveLength(MAX_PROMOCIONES_EN_EL_PROMPT);
  });

  it("el prompt le pide devolver el nombre exacto, sin inventar, sin ofrecerlas por su cuenta, y lo pone en el JSON de salida", async () => {
    const f = await crearClinica();
    const prompt = buildSystemPrompt(f.clinic as never, { esPrimeraVez: false });
    expect(prompt).toContain('"campana_mencionada"');
    expect(prompt).toMatch(/Promociones vigentes de la clínica/);
    expect(prompt).toMatch(/nombre EXACTO/);
    expect(prompt).toMatch(/no ofrezcas promociones por tu cuenta/);
    expect(prompt).toMatch(/nunca inventes precios/);
  });
});
