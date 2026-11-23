import type { Campaign, CampaignLead, CampaignLeadStatus, CampaignTriggerKind, Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { recordSystemAudit } from "./audit";
import { dateKeyOf, parseDateKey } from "./patient-admin";
import { SANDBOX_PHONE_PREFIX } from "./sandbox-phone";
import { clinicDateKey } from "./time";

/**
 * Campañas y promociones: identificar que un mensaje de WhatsApp llega por una campaña, atribuirle
 * el paciente y la cita, y darle al asistente lo que necesita para atenderlo.
 *
 * **Cómo se reconoce una campaña** (`CampaignTrigger`, una campaña puede tener varios formatos):
 * - `anuncio`: el id de un anuncio "Click-to-WhatsApp" de Meta. Llega en `referral.source_id` del
 *   webhook y no depende de lo que escriba el paciente: es lo más confiable.
 * - `texto`: una frase que viene en el mensaje (el texto prellenado del link, del QR, del flyer). Sirve
 *   para cualquier canal, pero depende de que el paciente no la borre.
 *
 * **Atribución**: se crea un `CampaignLead` la primera vez que un número llega por una campaña. Las citas
 * que saque ese número dentro de `ATTRIBUTION_DAYS` quedan marcadas con `Appointment.campaignId`.
 *
 * **Promoción, servicio y profesionales**: la campaña se asocia a un servicio, que ya tiene sus
 * profesionales en el catálogo. Opcionalmente le suma profesionales (`extraProfessionals`) que, SOLO para
 * esa campaña, pueden dar ese servicio aunque el catálogo no se lo asigne: se SUMAN a los del servicio.
 *
 * **Nada se borra, se desactiva**: los contactos y las citas referencian la campaña.
 */

/** Cuántos días después de llegar por una campaña se le siguen atribuyendo las citas a ese número. */
export const ATTRIBUTION_DAYS = 30;
export const MAX_TRIGGERS_PER_CAMPAIGN = 10;
/** Una frase más corta que esto matchearía con cualquier mensaje ("hola", "promo"). */
export const MIN_TEXT_TRIGGER_LENGTH = 6;
export const MAX_TEXT_TRIGGER_LENGTH = 120;
export const MAX_AD_ID_LENGTH = 64;
export const MAX_FOLLOW_UP_ATTEMPTS = 5;
export const MAX_FOLLOW_UP_HOURS = 720;
const DAY_MS = 86_400_000;

// --- Normalización y vigencia ---

/** Minúsculas, sin acentos y con los espacios colapsados: así "Limpieza  VERANO" matchea "limpieza verano". */
export function normalizeTriggerText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** ¿La frase aparece en el texto como palabras enteras? ("promo" no matchea "promocion"). */
export function textContainsPhrase(text: string, phrase: string): boolean {
  const t = normalizeTriggerText(text);
  const p = normalizeTriggerText(phrase);
  if (!p) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(p)}($|[^a-z0-9])`).test(t);
}

export type CampaignStatus = "inactiva" | "programada" | "vigente" | "vencida";

/** El estado de una campaña a una fecha local de la clínica (YYYY-MM-DD). */
export function campaignStatus(
  c: Pick<Campaign, "active" | "startsOn" | "endsOn">,
  todayKey: string
): CampaignStatus {
  if (!c.active) return "inactiva";
  const desde = dateKeyOf(c.startsOn);
  const hasta = dateKeyOf(c.endsOn);
  if (desde && todayKey < desde) return "programada";
  if (hasta && todayKey > hasta) return "vencida";
  return "vigente";
}

// --- Resultados ---

export type CampaignFailure =
  | "no_encontrada"
  | "nombre_requerido"
  | "nombre_duplicado"
  | "fecha_invalida"
  | "vigencia_invalida"
  | "servicio_requerido"
  | "servicio_no_encontrado"
  | "servicio_sin_profesional"
  | "profesional_no_encontrado"
  | "profesionales_sin_servicio"
  | "formato_requerido"
  | "formato_invalido"
  | "formato_duplicado"
  | "demasiados_formatos"
  | "seguimiento_invalido";

export type CampaignResult<T> = { ok: true; value: T } | { ok: false; reason: CampaignFailure; message: string };
const fail = (reason: CampaignFailure, message: string): { ok: false; reason: CampaignFailure; message: string } => ({
  ok: false,
  reason,
  message,
});

export interface TriggerInput {
  kind: CampaignTriggerKind;
  value: string;
}

export interface CampaignInput {
  name: string;
  channel?: string | null;
  description?: string | null;
  active?: boolean;
  /** YYYY-MM-DD, local de la clínica. */
  startsOn?: string | null;
  endsOn?: string | null;
  serviceId?: string | null;
  extraProfessionalIds?: string[];
  triggers?: TriggerInput[];
  followUpMaxAttempts?: number;
  followUpAfterHours?: number;
  followUpIntervalHours?: number;
}

/** Una campaña con todo lo que hace falta para mostrarla o aplicarla. */
export const CAMPAIGN_INCLUDE = {
  triggers: { orderBy: [{ kind: "asc" as const }, { value: "asc" as const }] },
  extraProfessionals: { select: { id: true, name: true, active: true } },
  service: { select: { id: true, name: true, active: true } },
} satisfies Prisma.CampaignInclude;

export type CampaignWithRelations = Prisma.CampaignGetPayload<{ include: typeof CAMPAIGN_INCLUDE }>;

const limpiar = (v: string | null | undefined, max: number): string | null => {
  const t = (v ?? "").trim().replace(/\s+/g, " ");
  return t ? t.slice(0, max) : null;
};

/**
 * Valida y normaliza los formatos. Un `texto` se guarda normalizado; un `anuncio`, tal cual (es un id).
 * Se rechazan los repetidos dentro de la misma campaña.
 */
export function normalizeTriggers(triggers: TriggerInput[]): CampaignResult<TriggerInput[]> {
  if (triggers.length > MAX_TRIGGERS_PER_CAMPAIGN) {
    return fail("demasiados_formatos", `Una campaña puede tener hasta ${MAX_TRIGGERS_PER_CAMPAIGN} formatos.`);
  }
  const vistos = new Set<string>();
  const out: TriggerInput[] = [];
  for (const t of triggers) {
    if (t.kind !== "texto" && t.kind !== "anuncio") {
      return fail("formato_invalido", "El tipo de formato no es válido.");
    }
    if (t.kind === "texto") {
      const value = normalizeTriggerText(String(t.value ?? ""));
      if (value.length < MIN_TEXT_TRIGGER_LENGTH || value.length > MAX_TEXT_TRIGGER_LENGTH) {
        return fail(
          "formato_invalido",
          `La frase tiene que tener entre ${MIN_TEXT_TRIGGER_LENGTH} y ${MAX_TEXT_TRIGGER_LENGTH} caracteres: una más corta coincidiría con cualquier mensaje.`
        );
      }
      const key = `texto:${value}`;
      if (!vistos.has(key)) out.push({ kind: "texto", value });
      vistos.add(key);
    } else {
      const value = String(t.value ?? "").trim();
      if (!value || value.length > MAX_AD_ID_LENGTH || /\s/.test(value)) {
        return fail("formato_invalido", "El id del anuncio no puede estar vacío ni llevar espacios.");
      }
      const key = `anuncio:${value}`;
      if (!vistos.has(key)) out.push({ kind: "anuncio", value });
      vistos.add(key);
    }
  }
  return { ok: true, value: out };
}

interface ValidatedFields {
  name: string;
  channel: string | null;
  description: string | null;
  startsOn: Date | null;
  endsOn: Date | null;
}

function validateFields(input: Partial<CampaignInput>, current?: Campaign): CampaignResult<ValidatedFields> {
  const name = limpiar(input.name ?? current?.name, 80);
  if (!name) return fail("nombre_requerido", "La campaña necesita un nombre.");

  const fecha = (valor: string | null | undefined, actual: Date | null | undefined): CampaignResult<Date | null> => {
    if (valor === undefined) return { ok: true, value: actual ?? null };
    if (valor === null || valor === "") return { ok: true, value: null };
    const d = parseDateKey(valor);
    return d ? { ok: true, value: d } : fail("fecha_invalida", `"${valor}" no es una fecha válida (AAAA-MM-DD).`);
  };
  const desde = fecha(input.startsOn, current?.startsOn);
  if (!desde.ok) return desde;
  const hasta = fecha(input.endsOn, current?.endsOn);
  if (!hasta.ok) return hasta;
  if (desde.value && hasta.value && hasta.value < desde.value) {
    return fail("vigencia_invalida", "La campaña no puede terminar antes de empezar.");
  }

  return {
    ok: true,
    value: {
      name,
      channel: input.channel === undefined ? (current?.channel ?? null) : limpiar(input.channel, 60),
      description: input.description === undefined ? (current?.description ?? null) : limpiar(input.description, 1000),
      startsOn: desde.value,
      endsOn: hasta.value,
    },
  };
}

function validateFollowUp(input: Partial<CampaignInput>, current?: Campaign) {
  const intentos = input.followUpMaxAttempts ?? current?.followUpMaxAttempts ?? 2;
  const despues = input.followUpAfterHours ?? current?.followUpAfterHours ?? 24;
  const cada = input.followUpIntervalHours ?? current?.followUpIntervalHours ?? 48;
  if (!Number.isInteger(intentos) || intentos < 0 || intentos > MAX_FOLLOW_UP_ATTEMPTS) {
    return fail("seguimiento_invalido", `Los seguimientos van de 0 a ${MAX_FOLLOW_UP_ATTEMPTS} (0 = sin seguimiento).`);
  }
  for (const h of [despues, cada]) {
    if (!Number.isInteger(h) || h < 1 || h > MAX_FOLLOW_UP_HOURS) {
      return fail("seguimiento_invalido", `Las esperas del seguimiento van de 1 a ${MAX_FOLLOW_UP_HOURS} horas.`);
    }
  }
  return { ok: true as const, value: { followUpMaxAttempts: intentos, followUpAfterHours: despues, followUpIntervalHours: cada } };
}

/**
 * El servicio y los profesionales de la promoción.
 *
 * **Una campaña activa tiene que tener servicio, y ese servicio tiene que tener a alguien que lo atienda**: es lo que le
 * dice al asistente qué ofrecer y con quién agendar. Sin servicio no sabe qué promover; con un servicio que nadie
 * realiza, ofrecería una promoción que después no puede agendar. `required` es "la campaña está (o va a quedar)
 * activa": una desactivada de antes de que esto fuera obligatorio se puede seguir editando sin servicio, pero no se puede
 * volver a activar así.
 *
 * Quien atiende es la unión de los profesionales activos del catálogo para ese servicio y los que se sumen en la campaña.
 */
async function validateRelations(
  clinicId: string,
  serviceId: string | null,
  extraProfessionalIds: string[],
  required: boolean
): Promise<CampaignResult<{ serviceId: string | null; extraProfessionalIds: string[] }>> {
  if (!serviceId) {
    if (required) {
      return fail(
        "servicio_requerido",
        "Elige el servicio de la promoción: sin él el asistente no sabe qué ofrecer ni con qué profesional agendar."
      );
    }
  } else {
    const s = await prisma.service.findFirst({ where: { id: serviceId, clinicId, active: true }, select: { id: true } });
    if (!s) return fail("servicio_no_encontrado", "El servicio no existe en esta clínica o está desactivado.");
  }
  const ids = [...new Set(extraProfessionalIds)];
  if (ids.length > 0) {
    // Combinar un profesional con un servicio solo tiene sentido si hay servicio.
    if (!serviceId) {
      return fail("profesionales_sin_servicio", "Para sumar profesionales hay que elegir primero el servicio de la promoción.");
    }
    const encontrados = await prisma.professional.count({ where: { id: { in: ids }, clinicId, active: true } });
    if (encontrados !== ids.length) {
      return fail("profesional_no_encontrado", "Algún profesional no existe en esta clínica o está desactivado.");
    }
  }
  if (required && serviceId) {
    const delCatalogo = await prisma.professional.findMany({
      where: { clinicId, active: true, services: { some: { id: serviceId } } },
      select: { id: true },
    });
    const atienden = new Set([...delCatalogo.map((p) => p.id), ...ids]);
    if (atienden.size === 0) {
      return fail(
        "servicio_sin_profesional",
        'Ese servicio no tiene ningún profesional asignado: asígnalo en "Servicios" o suma uno en esta campaña. Sin alguien que lo atienda, el asistente no podría agendarlo.'
      );
    }
  }
  return { ok: true, value: { serviceId, extraProfessionalIds: ids } };
}

/** ¿Algún formato ya lo usa OTRA campaña de la clínica? */
async function findDuplicateTrigger(clinicId: string, triggers: TriggerInput[], exceptCampaignId?: string) {
  if (triggers.length === 0) return null;
  const rows = await prisma.campaignTrigger.findMany({
    where: {
      clinicId,
      campaignId: exceptCampaignId ? { not: exceptCampaignId } : undefined,
      OR: triggers.map((t) => ({ kind: t.kind, value: t.value })),
    },
    include: { campaign: { select: { name: true } } },
  });
  return rows[0] ?? null;
}

// --- Alta y edición ---

export async function createCampaign(clinicId: string, input: CampaignInput): Promise<CampaignResult<CampaignWithRelations>> {
  const campos = validateFields(input);
  if (!campos.ok) return campos;
  const seguimiento = validateFollowUp(input);
  if (!seguimiento.ok) return seguimiento;
  const relaciones = await validateRelations(clinicId, input.serviceId ?? null, input.extraProfessionalIds ?? [], true);
  if (!relaciones.ok) return relaciones;
  const formatos = normalizeTriggers(input.triggers ?? []);
  if (!formatos.ok) return formatos;
  if (formatos.value.length === 0) return SIN_FORMATOS;
  const repetido = await findDuplicateTrigger(clinicId, formatos.value);
  if (repetido) return duplicateTriggerFailure(repetido);

  try {
    const creada = await prisma.campaign.create({
      data: {
        clinicId,
        ...campos.value,
        active: input.active ?? true,
        serviceId: relaciones.value.serviceId,
        extraProfessionals: { connect: relaciones.value.extraProfessionalIds.map((id) => ({ id })) },
        triggers: { create: formatos.value.map((t) => ({ clinicId, kind: t.kind, value: t.value })) },
        ...seguimiento.value,
      },
      include: CAMPAIGN_INCLUDE,
    });
    return { ok: true, value: creada };
  } catch (error) {
    return mapUniqueError(error);
  }
}

export async function updateCampaign(
  clinicId: string,
  campaignId: string,
  input: Partial<CampaignInput>
): Promise<CampaignResult<CampaignWithRelations>> {
  const actual = await prisma.campaign.findFirst({ where: { id: campaignId, clinicId }, include: CAMPAIGN_INCLUDE });
  if (!actual) return fail("no_encontrada", "La campaña no existe.");

  const campos = validateFields(input, actual);
  if (!campos.ok) return campos;
  const seguimiento = validateFollowUp(input, actual);
  if (!seguimiento.ok) return seguimiento;

  const serviceId = input.serviceId === undefined ? actual.serviceId : input.serviceId;
  // Si se saca el servicio, los profesionales de la promoción dejan de tener sentido.
  const extraIds =
    input.extraProfessionalIds ?? (serviceId ? actual.extraProfessionals.map((p) => p.id) : []);
  // Una campaña activa (o que se va a activar) necesita su servicio; una desactivada de antes, no.
  const relaciones = await validateRelations(clinicId, serviceId, extraIds, input.active ?? actual.active);
  if (!relaciones.ok) return relaciones;

  let formatos: TriggerInput[] | null = null;
  if (input.triggers) {
    const n = normalizeTriggers(input.triggers);
    if (!n.ok) return n;
    const repetido = await findDuplicateTrigger(clinicId, n.value, campaignId);
    if (repetido) return duplicateTriggerFailure(repetido);
    formatos = n.value;
  }
  // Una campaña activa (o que se va a activar) necesita al menos un formato; una desactivada de antes, no.
  if ((input.active ?? actual.active) && (formatos ? formatos.length : actual.triggers.length) === 0) return SIN_FORMATOS;

  try {
    const actualizada = await prisma.$transaction(async (tx) => {
      if (formatos) {
        await tx.campaignTrigger.deleteMany({ where: { campaignId } });
        await tx.campaignTrigger.createMany({ data: formatos.map((t) => ({ campaignId, clinicId, kind: t.kind, value: t.value })) });
      }
      return tx.campaign.update({
        where: { id: campaignId },
        data: {
          ...campos.value,
          active: input.active ?? actual.active,
          serviceId: relaciones.value.serviceId,
          extraProfessionals: { set: relaciones.value.extraProfessionalIds.map((id) => ({ id })) },
          ...seguimiento.value,
        },
        include: CAMPAIGN_INCLUDE,
      });
    });
    return { ok: true, value: actualizada };
  } catch (error) {
    return mapUniqueError(error);
  }
}

/** Una campaña activa sin ningún formato nunca se reconocería: nadie llegaría "por ella". */
const SIN_FORMATOS = fail(
  "formato_requerido",
  "Agrega al menos un formato: la frase que trae el mensaje o el id del anuncio de Meta. Sin eso no se puede reconocer a quien llegue por esta campaña."
);

function duplicateTriggerFailure(row: { kind: CampaignTriggerKind; value: string; campaign: { name: string } }) {
  return fail(
    "formato_duplicado",
    `El formato "${row.value}" ya lo usa la campaña "${row.campaign.name}": no se sabría a cuál atribuir el contacto.`
  );
}

function mapUniqueError(error: unknown): { ok: false; reason: CampaignFailure; message: string } {
  if ((error as { code?: string })?.code === "P2002") {
    const target = JSON.stringify((error as { meta?: { target?: unknown } }).meta?.target ?? "");
    if (target.includes("name")) return fail("nombre_duplicado", "Ya hay una campaña con ese nombre.");
    return fail("formato_duplicado", "Ese formato ya lo usa otra campaña.");
  }
  throw error;
}

// --- Lectura ---

export async function listCampaigns(clinicId: string) {
  return prisma.campaign.findMany({
    where: { clinicId },
    include: CAMPAIGN_INCLUDE,
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
  });
}

export async function findCampaign(clinicId: string, campaignId: string) {
  return prisma.campaign.findFirst({ where: { id: campaignId, clinicId }, include: CAMPAIGN_INCLUDE });
}

// --- Detección ---

/**
 * El id del anuncio de Meta de un mensaje entrante, si vino de un anuncio "Click-to-WhatsApp": Meta lo manda en
 * `message.referral.source_id`. Cualquier otra forma (sin `referral`, un número, vacío) es "no vino de un anuncio":
 * el webhook recibe lo que Meta mande, y esto no puede reventar por un campo raro.
 */
export function extractAdSourceId(message: unknown): string | null {
  const id = (message as { referral?: { source_id?: unknown } } | null | undefined)?.referral?.source_id;
  if (typeof id !== "string") return null;
  const limpio = id.trim();
  return limpio && limpio.length <= MAX_AD_ID_LENGTH ? limpio : null;
}

export interface CampaignMatch {
  campaign: Campaign;
  triggerKind: CampaignTriggerKind;
  /** El formato que coincidió (la frase normalizada o el id del anuncio): para poder explicar POR QUÉ se reconoció. */
  trigger: string;
}

/**
 * ¿De qué campaña es este mensaje? Primero el anuncio de Meta (exacto, no depende de lo que escribió),
 * después las frases. Con varias frases que coinciden gana la más larga (la más específica); a igualdad,
 * la campaña más vieja. Solo campañas activas: una desactivada ya no atribuye.
 */
export async function detectCampaign(params: {
  clinicId: string;
  text: string;
  adSourceId?: string | null;
}): Promise<CampaignMatch | null> {
  if (params.adSourceId) {
    const porAnuncio = await prisma.campaignTrigger.findFirst({
      where: { clinicId: params.clinicId, kind: "anuncio", value: params.adSourceId, campaign: { active: true } },
      include: { campaign: true },
    });
    if (porAnuncio) return { campaign: porAnuncio.campaign, triggerKind: "anuncio", trigger: porAnuncio.value };
  }

  const frases = await prisma.campaignTrigger.findMany({
    where: { clinicId: params.clinicId, kind: "texto", campaign: { active: true } },
    include: { campaign: true },
  });
  const coinciden = frases.filter((t) => textContainsPhrase(params.text, t.value));
  if (coinciden.length === 0) return null;
  coinciden.sort((a, b) => b.value.length - a.value.length || a.campaign.createdAt.getTime() - b.campaign.createdAt.getTime());
  return { campaign: coinciden[0].campaign, triggerKind: "texto", trigger: coinciden[0].value };
}

/**
 * Se llama por cada mensaje que entra por WhatsApp, antes de encolarlo.
 *
 * 1. Si el mensaje es de una campaña, crea el contacto (`CampaignLead`) la primera vez que ese número
 *    llega por ella, y lo vuelve a abrir si se había cerrado por falta de respuesta.
 * 2. En cualquier caso, anota que ese número volvió a escribir (`lastInboundAt`) en sus contactos
 *    abiertos: el seguimiento espera a que pase un tiempo desde su último mensaje.
 *
 * **No puede tumbar el mensaje**: quien la llama la envuelve en un try/catch. Y registra en la auditoría
 * (origen `whatsapp`) el alta del contacto, sin el teléfono ni el texto.
 */
export async function recordCampaignContact(params: {
  clinicId: string;
  phone: string;
  text: string;
  adSourceId?: string | null;
  now?: Date;
}): Promise<{ matched: CampaignMatch | null; lead: CampaignLead | null; created: boolean }> {
  const now = params.now ?? new Date();
  const matched = await detectCampaign({ clinicId: params.clinicId, text: params.text, adSourceId: params.adSourceId });

  let lead: CampaignLead | null = null;
  let created = false;
  if (matched) {
    const existente = await prisma.campaignLead.findUnique({
      where: { clinicId_campaignId_patientPhone: { clinicId: params.clinicId, campaignId: matched.campaign.id, patientPhone: params.phone } },
    });
    if (existente) {
      // Volvió a escribir con el formato de la campaña: si se había cerrado por falta de respuesta, vuelve a
      // estar abierto (el límite de seguimientos se conserva: no se le vuelve a insistir de más).
      lead = await prisma.campaignLead.update({
        where: { id: existente.id },
        data: {
          lastInboundAt: now,
          ...(existente.status === "cerrado" && existente.closedReason === "sin_respuesta"
            ? { status: "abierto", closedAt: null, closedReason: null }
            : {}),
        },
      });
    } else {
      const eraConocido =
        (await prisma.patient.count({ where: { clinicId: params.clinicId, phone: params.phone } })) > 0 ||
        (await prisma.conversationMessage.count({ where: { clinicId: params.clinicId, patientPhone: params.phone } })) > 0;
      try {
        lead = await prisma.campaignLead.create({
          data: {
            clinicId: params.clinicId,
            campaignId: matched.campaign.id,
            patientPhone: params.phone,
            triggerKind: matched.triggerKind,
            isNewContact: !eraConocido,
            firstMessageAt: now,
            lastInboundAt: now,
          },
        });
        created = true;
        await recordSystemAudit({
          origin: "whatsapp",
          clinicId: params.clinicId,
          action: "campaign.lead_create",
          resourceType: "campaign_leads",
          resourceId: lead.id,
          // Sin teléfono ni texto: el contacto es la ficha del lead.
          details: { campaignId: matched.campaign.id, formato: matched.triggerKind, contactoNuevo: !eraConocido },
        });
      } catch (error) {
        // Dos mensajes seguidos del mismo número pueden crearlo a la vez: gana el primero.
        if ((error as { code?: string })?.code !== "P2002") throw error;
        lead = await prisma.campaignLead.findUnique({
          where: { clinicId_campaignId_patientPhone: { clinicId: params.clinicId, campaignId: matched.campaign.id, patientPhone: params.phone } },
        });
      }
    }
  }

  await prisma.campaignLead.updateMany({
    where: { clinicId: params.clinicId, patientPhone: params.phone, status: "abierto" },
    data: { lastInboundAt: now },
  });
  return { matched, lead, created };
}

// --- Reconocer la campaña por lo que dijo la persona ---

/** Las campañas VIGENTES de la clínica (activas y dentro de sus fechas) con lo que hace falta para mostrarlas. */
export async function listVigentCampaigns(clinicId: string, timezone: string, now = new Date()): Promise<CampaignWithRelations[]> {
  const todayKey = clinicDateKey(now, timezone);
  const activas = await prisma.campaign.findMany({ where: { clinicId, active: true }, include: CAMPAIGN_INCLUDE, orderBy: { createdAt: "asc" } });
  return activas.filter((c) => campaignStatus(c, todayKey) === "vigente");
}

/**
 * El asistente reconoció a qué promoción se refiere la persona (`campana_mencionada`): se crea el contacto de esa campaña,
 * con `triggerKind: "asistente"`, igual que si hubiera coincidido un formato.
 *
 * **El nombre se resuelve contra las campañas vigentes de la clínica, sin acentos ni mayúsculas, y tiene que ser exacto**: un
 * nombre inventado o de una campaña vencida, desactivada o de otra clínica no atribuye nada. Si el contacto ya existe, solo se
 * actualiza su último mensaje. Devuelve la campaña reconocida o null. **No puede tumbar el turno**: quien la llama la
 * envuelve en un try/catch.
 */
export async function recordCampaignMention(params: {
  clinicId: string;
  phone: string;
  campaignName: string | null | undefined;
  timezone: string;
  /** Si este es el primer mensaje de ese número (no había conversación ni citas): un contacto nuevo. */
  isNewContact: boolean;
  now?: Date;
}): Promise<{ campaign: Campaign; created: boolean } | null> {
  const nombre = normalizeTriggerText(params.campaignName ?? "");
  if (!nombre) return null;
  const now = params.now ?? new Date();
  const campaign = (await listVigentCampaigns(params.clinicId, params.timezone, now)).find((c) => normalizeTriggerText(c.name) === nombre);
  if (!campaign) return null;

  const clave = { clinicId_campaignId_patientPhone: { clinicId: params.clinicId, campaignId: campaign.id, patientPhone: params.phone } };
  const existente = await prisma.campaignLead.findUnique({ where: clave });
  if (existente) {
    await prisma.campaignLead.update({ where: { id: existente.id }, data: { lastInboundAt: now } });
    return { campaign, created: false };
  }
  try {
    const lead = await prisma.campaignLead.create({
      data: {
        clinicId: params.clinicId,
        campaignId: campaign.id,
        patientPhone: params.phone,
        triggerKind: "asistente",
        isNewContact: params.isNewContact,
        firstMessageAt: now,
        lastInboundAt: now,
      },
    });
    await recordSystemAudit({
      origin: "whatsapp",
      clinicId: params.clinicId,
      action: "campaign.lead_create",
      resourceType: "campaign_leads",
      resourceId: lead.id,
      // Sin teléfono ni texto.
      details: { campaignId: campaign.id, formato: "asistente", contactoNuevo: params.isNewContact },
    });
    return { campaign, created: true };
  } catch (error) {
    // Dos mensajes a la vez pueden crearlo: gana el primero.
    if ((error as { code?: string })?.code !== "P2002") throw error;
    return { campaign, created: false };
  }
}

// --- Atribución y contexto para el asistente ---

export interface CampaignContext {
  lead: CampaignLead;
  campaign: CampaignWithRelations;
  /** El estado a hoy. Recién `vigente` hace que el asistente ofrezca la promoción. */
  status: CampaignStatus;
  vigente: boolean;
}

/**
 * La campaña por la que llegó este número, si llegó por una dentro de `ATTRIBUTION_DAYS`: la más reciente.
 * Es lo que se le cuenta al asistente y lo que se le atribuye a la cita que saque.
 */
export async function getCampaignContextForPhone(params: {
  clinicId: string;
  phone: string;
  timezone: string;
  now?: Date;
}): Promise<CampaignContext | null> {
  const now = params.now ?? new Date();
  const lead = await prisma.campaignLead.findFirst({
    where: { clinicId: params.clinicId, patientPhone: params.phone, firstMessageAt: { gte: new Date(now.getTime() - ATTRIBUTION_DAYS * DAY_MS) } },
    orderBy: { firstMessageAt: "desc" },
  });
  if (!lead) return null;
  const campaign = await prisma.campaign.findFirst({ where: { id: lead.campaignId, clinicId: params.clinicId }, include: CAMPAIGN_INCLUDE });
  if (!campaign) return null;
  const status = campaignStatus(campaign, clinicDateKey(now, params.timezone));
  return { lead, campaign, status, vigente: status === "vigente" };
}

/**
 * Los profesionales que la campaña le SUMA a su servicio. Solo si la campaña está vigente y el servicio
 * pedido es el de la promoción: pedir otro servicio no los habilita para nada.
 */
export function campaignExtraProfessionalIds(
  campaign: Pick<CampaignWithRelations, "serviceId" | "extraProfessionals" | "active" | "startsOn" | "endsOn">,
  serviceId: string,
  todayKey: string
): string[] {
  if (campaign.serviceId !== serviceId) return [];
  if (campaignStatus(campaign, todayKey) !== "vigente") return [];
  return campaign.extraProfessionals.filter((p) => p.active).map((p) => p.id);
}

/**
 * La campaña para resolver profesionales al ofrecer o agendar: solo lo que hace falta, y solo si es de
 * esta clínica y está activa (el id lo arma nuestro código desde el contacto, pero se acota igual).
 */
export async function loadCampaignForBooking(clinicId: string, campaignId: string | null | undefined, db: Pick<typeof prisma, "campaign"> = prisma) {
  if (!campaignId) return null;
  return db.campaign.findFirst({
    where: { id: campaignId, clinicId, active: true },
    select: { id: true, serviceId: true, active: true, startsOn: true, endsOn: true, extraProfessionals: { select: { id: true, name: true, active: true } } },
  });
}

/**
 * La persona agendó: el contacto pasa a "convertido". Se llama después de una reserva exitosa del
 * asistente. Idempotente (no vuelve a marcar uno ya convertido), y se audita.
 */
export async function markLeadConverted(lead: Pick<CampaignLead, "id" | "clinicId" | "campaignId">, appointmentId: string, now = new Date()): Promise<boolean> {
  const { count } = await prisma.campaignLead.updateMany({
    where: { id: lead.id, status: { not: "convertido" } },
    data: { status: "convertido", convertedAt: now, closedAt: null, closedReason: null },
  });
  if (count === 0) return false;
  await recordSystemAudit({
    origin: "whatsapp",
    clinicId: lead.clinicId,
    action: "campaign.lead_converted",
    resourceType: "campaign_leads",
    resourceId: lead.id,
    details: { campaignId: lead.campaignId, citaId: appointmentId },
  });
  return true;
}

/** Cierra un contacto (deja de hacerle seguimiento). `userId` si lo hizo una persona desde el panel. */
export async function closeLead(params: {
  clinicId: string;
  leadId: string;
  reason: "cerrado_por_la_clinica" | "solicitud_del_paciente" | "sin_respuesta" | "campana_inactiva";
  userId?: string | null;
  now?: Date;
}): Promise<boolean> {
  const { count } = await prisma.campaignLead.updateMany({
    where: { id: params.leadId, clinicId: params.clinicId, status: "abierto" },
    data: { status: "cerrado", closedReason: params.reason, closedAt: params.now ?? new Date() },
  });
  return count === 1;
}

// --- Contactos y estadísticas ---

export interface LeadRow {
  id: string;
  campaignId: string;
  campaignName: string;
  patientName: string | null;
  patientPhone: string;
  status: CampaignLeadStatus;
  closedReason: string | null;
  triggerKind: CampaignTriggerKind;
  isNewContact: boolean;
  firstMessageAt: string;
  lastInboundAt: string;
  convertedAt: string | null;
  followUpCount: number;
  lastFollowUpAt: string | null;
}

/** Los contactos de las campañas de la clínica, del más reciente al más viejo. */
export async function listLeads(params: {
  clinicId: string;
  campaignId?: string;
  status?: CampaignLeadStatus;
  limit?: number;
}): Promise<LeadRow[]> {
  const leads = await prisma.campaignLead.findMany({
    where: {
      clinicId: params.clinicId,
      campaignId: params.campaignId,
      status: params.status,
      // Chat de pruebas: los contactos de prueba no son personas de verdad.
      NOT: { patientPhone: { startsWith: SANDBOX_PHONE_PREFIX } },
    },
    orderBy: { firstMessageAt: "desc" },
    take: Math.min(Math.max(params.limit ?? 200, 1), 500),
    include: { campaign: { select: { name: true } } },
  });
  // El nombre sale del titular del número (la ficha más vieja), si ya tiene.
  const telefonos = [...new Set(leads.map((l) => l.patientPhone))];
  const personas = await prisma.patient.findMany({
    where: { clinicId: params.clinicId, phone: { in: telefonos } },
    orderBy: { createdAt: "asc" },
    select: { phone: true, name: true },
  });
  const titular = new Map<string, string | null>();
  for (const p of personas) if (!titular.has(p.phone)) titular.set(p.phone, p.name);

  return leads.map((l) => ({
    id: l.id,
    campaignId: l.campaignId,
    campaignName: l.campaign.name,
    patientName: titular.get(l.patientPhone) ?? null,
    patientPhone: l.patientPhone,
    status: l.status,
    closedReason: l.closedReason,
    triggerKind: l.triggerKind,
    isNewContact: l.isNewContact,
    firstMessageAt: l.firstMessageAt.toISOString(),
    lastInboundAt: l.lastInboundAt.toISOString(),
    convertedAt: l.convertedAt?.toISOString() ?? null,
    followUpCount: l.followUpCount,
    lastFollowUpAt: l.lastFollowUpAt?.toISOString() ?? null,
  }));
}

export interface CampaignStats {
  campaignId: string;
  contacts: number;
  newContacts: number;
  converted: number;
  open: number;
  closedNoReply: number;
  followUpsSent: number;
  appointments: number;
  /** Cuántos contactos llegaron por un anuncio de Meta y cuántos por una frase del mensaje. */
  viaAd: number;
  viaText: number;
  /** Los que reconoció el asistente por lo que dijeron (sin que coincidiera un formato). */
  viaAssistant: number;
}

/** Los números de cada campaña en un período (por la fecha en que llegó el contacto). */
export async function campaignStats(params: { clinicId: string; from: Date; toExclusive: Date }): Promise<Map<string, CampaignStats>> {
  const leads = await prisma.campaignLead.findMany({
    where: {
      clinicId: params.clinicId,
      firstMessageAt: { gte: params.from, lt: params.toExclusive },
      NOT: { patientPhone: { startsWith: SANDBOX_PHONE_PREFIX } },
    },
    select: { campaignId: true, isNewContact: true, status: true, closedReason: true, followUpCount: true, triggerKind: true },
  });
  const citas = await prisma.appointment.groupBy({
    by: ["campaignId"],
    where: {
      clinicId: params.clinicId,
      campaignId: { not: null },
      createdAt: { gte: params.from, lt: params.toExclusive },
      status: { not: "cancelado" },
      NOT: { patient: { phone: { startsWith: SANDBOX_PHONE_PREFIX } } },
    },
    _count: true,
  });

  const out = new Map<string, CampaignStats>();
  const get = (id: string) => {
    let s = out.get(id);
    if (!s) {
      s = { campaignId: id, contacts: 0, newContacts: 0, converted: 0, open: 0, closedNoReply: 0, followUpsSent: 0, appointments: 0, viaAd: 0, viaText: 0, viaAssistant: 0 };
      out.set(id, s);
    }
    return s;
  };
  for (const l of leads) {
    const s = get(l.campaignId);
    s.contacts += 1;
    if (l.isNewContact) s.newContacts += 1;
    if (l.status === "convertido") s.converted += 1;
    if (l.status === "abierto") s.open += 1;
    if (l.status === "cerrado" && l.closedReason === "sin_respuesta") s.closedNoReply += 1;
    s.followUpsSent += l.followUpCount;
    if (l.triggerKind === "anuncio") s.viaAd += 1;
    else if (l.triggerKind === "asistente") s.viaAssistant += 1;
    else s.viaText += 1;
  }
  for (const c of citas) if (c.campaignId) get(c.campaignId).appointments = c._count;
  return out;
}
