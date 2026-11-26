import { Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { COST_CATALOG, PROVIDER_LABELS, UNMETERED_NOTES } from "../config/cost-catalog";
import { clinicDateKey, dateKeyToUtcMidnight } from "./time";
import { SANDBOX_PHONE_PREFIX } from "./sandbox-phone";
import { templateCostCategory } from "./whatsapp-templates";

/**
 * Consumo y costo de la plataforma: cuánto gasta cada clínica en el modelo de IA, en WhatsApp y en las
 * integraciones. Ver `config/cost-catalog.ts` (qué se mide) y la pantalla "Costos" (solo super-admin).
 *
 * **El costo se congela al ocurrir el evento** con la tarifa vigente de ese momento (`CostRate`): un cambio de
 * tarifa no reescribe el pasado. **Sin tarifa el costo es null** y la pantalla lo dice ("sin tarifa"): un cero
 * silencioso haría creer que algo es gratis. **Gratis por definición** (Calendar, texto de servicio) es 0.
 *
 * Solo metadatos: ni teléfonos, ni nombres, ni texto. La "conversación" es el titular (`patientId`).
 */

// --- Tarifas ---

type RateRow = { item: string; priceUsd: Prisma.Decimal; effectiveFrom: Date };

export async function loadRates(): Promise<Map<string, RateRow[]>> {
  const rows = await prisma.costRate.findMany({
    select: { item: true, priceUsd: true, effectiveFrom: true },
    orderBy: { effectiveFrom: "desc" },
  });
  const map = new Map<string, RateRow[]>();
  for (const r of rows) map.set(r.item, [...(map.get(r.item) ?? []), r]);
  return map;
}

/** La tarifa vigente de `item` a la fecha `at` (la última con `effectiveFrom <= at`), o null si no hay. */
export function rateAt(rates: Map<string, RateRow[]>, item: string, at: Date): number | null {
  const fila = (rates.get(item) ?? []).find((r) => r.effectiveFrom.getTime() <= at.getTime());
  return fila ? Number(fila.priceUsd) : null;
}

export interface TokenUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
}

/**
 * Costo en USD de una llamada al modelo. Null si falta la tarifa de entrada o de salida de ese modelo. Si faltan las
 * de caché se usa la de entrada: sobreestima un poco la lectura de caché, pero no oculta el costo.
 */
export function modelCostUsd(rates: Map<string, RateRow[]>, model: string, t: TokenUsage, at: Date): number | null {
  const entrada = rateAt(rates, `${model}:input`, at);
  const salida = rateAt(rates, `${model}:output`, at);
  if (entrada === null || salida === null) return null;
  const lectura = rateAt(rates, `${model}:cache_read`, at) ?? entrada;
  const escritura = rateAt(rates, `${model}:cache_creation`, at) ?? entrada;
  const porMillon =
    (t.inputTokens ?? 0) * entrada +
    (t.outputTokens ?? 0) * salida +
    (t.cacheReadTokens ?? 0) * lectura +
    (t.cacheCreationTokens ?? 0) * escritura;
  return porMillon / 1_000_000;
}

/** `whatsapp:<categoría>:<PAÍS>`, y si no está, `whatsapp:<categoría>:*`. El texto de servicio es gratis si no hay tarifa. */
export function whatsappCostUsd(
  rates: Map<string, RateRow[]>,
  category: string,
  country: string | null,
  at: Date
): number | null {
  const porPais = country ? rateAt(rates, `whatsapp:${category}:${country.toUpperCase()}`, at) : null;
  const precio = porPais ?? rateAt(rates, `whatsapp:${category}:*`, at);
  if (precio !== null) return precio;
  return category === "service" ? 0 : null;
}

/** Cuánto vale una llamada a una integración: la tarifa cargada, 0 si es gratis por definición, o null. */
export function integrationCostUsd(rates: Map<string, RateRow[]>, key: string, at: Date): number | null {
  const entrada = COST_CATALOG.find((e) => e.key === key);
  const precio = rateAt(rates, key, at);
  if (precio !== null) return precio;
  return entrada?.free ? 0 : null;
}

// --- Registro (nunca lanzan: se llaman después de hacer lo que se mide) ---

export interface UsageInput {
  clinicId?: string | null;
  patientId?: string | null;
  provider: string;
  kind: string;
  category?: string | null;
  templateName?: string | null;
  country?: string | null;
  quantity?: number;
  /** Para los tests. */
  at?: Date;
}

/** Registra un evento con su costo congelado. **Nunca lanza**: que falle no puede tumbar lo que se estaba haciendo. */
export async function recordUsageEvent(e: UsageInput): Promise<void> {
  try {
    const at = e.at ?? new Date();
    const rates = await loadRates();
    const unidades = e.quantity ?? 1;
    const costo =
      e.provider === "whatsapp"
        ? whatsappCostUsd(rates, e.category ?? "utility", e.country ?? null, at)
        : integrationCostUsd(rates, `${e.provider}:${e.kind}`, at);
    await prisma.usageEvent.create({
      data: {
        occurredAt: at,
        clinicId: e.clinicId ?? null,
        patientId: e.patientId ?? null,
        provider: e.provider,
        kind: e.kind,
        category: e.category ?? null,
        templateName: e.templateName ?? null,
        country: e.country ? e.country.toUpperCase() : null,
        quantity: unidades,
        costUsd: costo === null ? null : costo * unidades,
      },
    });
  } catch (error) {
    console.error(`No se pudo registrar el uso de ${e.provider}/${e.kind}:`, error);
  }
}

/** El `Patient.phone` de WhatsApp de México lleva "521"; la API de envío lo recibe sin el 1. */
function phoneVariants(to: string): string[] {
  return /^52\d{10}$/.test(to) ? [to, `521${to.slice(2)}`] : [to];
}

/**
 * Un envío de WhatsApp que salió bien. La categoría sale del catálogo (`CLINIC_TEMPLATES[].categoria`,
 * la que Meta aplicó); si Meta reclasifica otra, hay que actualizarla ahí o lo facturado difiere de lo registrado.
 */
export async function recordWhatsAppSend(params: {
  clinicId: string;
  country: string | null;
  to: string;
  kind: "plantilla" | "texto";
  templateName?: string;
}): Promise<void> {
  try {
    const paciente = await prisma.patient.findFirst({
      where: { clinicId: params.clinicId, phone: { in: phoneVariants(params.to) } },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    await recordUsageEvent({
      clinicId: params.clinicId,
      patientId: paciente?.id ?? null,
      provider: "whatsapp",
      kind: params.kind,
      category: params.kind === "plantilla" ? templateCostCategory(params.templateName) : "service",
      templateName: params.templateName ?? null,
      country: params.country,
    });
  } catch (error) {
    console.error("No se pudo registrar el envío de WhatsApp:", error);
  }
}

/** Cuántos días se conservan los eventos de uso (los limpia `jobs/system-events-cleanup.ts`). */
export const USAGE_RETENTION_DAYS = 400;

export async function pruneUsageEvents(now = new Date()): Promise<number> {
  const corte = new Date(now.getTime() - USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.usageEvent.deleteMany({ where: { occurredAt: { lt: corte } } });
  return count;
}

// --- Lectura (la pantalla de Costos) ---

export const MAX_RANGE_DAYS = 366;
export const DEFAULT_RANGE_DAYS = 30;

export interface CostRange {
  desde: string;
  hasta: string;
  /** Instante de inicio (incluido) y de fin (excluido), en la zona de la plataforma. */
  from: Date;
  to: Date;
}

function addDays(dateKey: string, days: number): string {
  const d = dateKeyToUtcMidnight(dateKey)!;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Convierte `desde`/`hasta` (días de calendario de la plataforma, `PLATFORM_TIMEZONE`) en un rango de instantes.
 * Sin parámetros: los últimos 30 días hasta hoy. `{ error }` si no son fechas reales o el rango es inválido.
 */
export function parseCostRange(query: { desde?: unknown; hasta?: unknown }, now = new Date()): CostRange | { error: string } {
  const tz = env.platformTimezone;
  const hoy = clinicDateKey(now, tz);
  const hasta = typeof query.hasta === "string" && query.hasta ? query.hasta : hoy;
  const desde = typeof query.desde === "string" && query.desde ? query.desde : addDays(hasta, -(DEFAULT_RANGE_DAYS - 1));
  if (!dateKeyToUtcMidnight(desde) || !dateKeyToUtcMidnight(hasta)) return { error: "`desde` y `hasta` tienen que ser fechas AAAA-MM-DD reales." };
  if (desde > hasta) return { error: "`desde` no puede ser posterior a `hasta`." };
  const dias = (dateKeyToUtcMidnight(hasta)!.getTime() - dateKeyToUtcMidnight(desde)!.getTime()) / 86_400_000 + 1;
  if (dias > MAX_RANGE_DAYS) return { error: `El rango no puede pasar de ${MAX_RANGE_DAYS} días.` };
  return { desde, hasta, from: wallDayStart(desde, tz), to: wallDayStart(addDays(hasta, 1), tz) };
}

/** La medianoche de `dateKey` en la zona dada, como instante. */
function wallDayStart(dateKey: string, tz: string): Date {
  const utc = dateKeyToUtcMidnight(dateKey)!;
  // Se prueba el desfase de la zona en esa fecha y se corrige: alcanza para zonas sin cambios de hora a medianoche.
  const probe = new Date(utc.getTime() + 12 * 3_600_000);
  const local = new Date(probe.toLocaleString("en-US", { timeZone: tz }));
  const offset = local.getTime() - new Date(probe.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  return new Date(utc.getTime() - offset);
}

interface Totals {
  costoModeloUsd: number;
  costoWhatsappUsd: number;
  costoOtrosUsd: number;
  costoTotalUsd: number;
  llamadasModelo: number;
  llamadasSinTarifa: number;
  tokensEntrada: number;
  tokensSalida: number;
  tokensCache: number;
  mensajesWhatsapp: number;
  mensajesSinTarifa: number;
  eventosOtros: number;
}

const vacio = (): Totals => ({
  costoModeloUsd: 0, costoWhatsappUsd: 0, costoOtrosUsd: 0, costoTotalUsd: 0, llamadasModelo: 0, llamadasSinTarifa: 0,
  tokensEntrada: 0, tokensSalida: 0, tokensCache: 0, mensajesWhatsapp: 0, mensajesSinTarifa: 0, eventosOtros: 0,
});

function redondear(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function cerrar(t: Totals): Totals {
  t.costoModeloUsd = redondear(t.costoModeloUsd);
  t.costoWhatsappUsd = redondear(t.costoWhatsappUsd);
  t.costoOtrosUsd = redondear(t.costoOtrosUsd);
  t.costoTotalUsd = redondear(t.costoModeloUsd + t.costoWhatsappUsd + t.costoOtrosUsd);
  return t;
}

async function sandboxPatientIds(): Promise<Set<string>> {
  const rows = await prisma.patient.findMany({ where: { phone: { startsWith: SANDBOX_PHONE_PREFIX } }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

interface Fx {
  currency: string;
  unitsPerUsd: number;
  effectiveFrom: string;
}

/** El tipo de cambio vigente HOY de cada moneda que alguna clínica usa (para mostrar el equivalente local). */
async function currentFx(): Promise<Map<string, Fx>> {
  const filas = await prisma.fxRate.findMany({ orderBy: { effectiveFrom: "desc" } });
  const ahora = Date.now();
  const mapa = new Map<string, Fx>();
  for (const f of filas) {
    if (f.effectiveFrom.getTime() > ahora || mapa.has(f.currency)) continue;
    mapa.set(f.currency, { currency: f.currency, unitsPerUsd: Number(f.unitsPerUsd), effectiveFrom: f.effectiveFrom.toISOString().slice(0, 10) });
  }
  return mapa;
}

/** Suma un evento (llamada al modelo o evento de uso) a sus totales. `usd` null = sin tarifa. */
function sumar(t: Totals, tipo: "modelo" | "whatsapp" | "otro", usd: number | null, cantidad: number) {
  if (tipo === "modelo") {
    t.llamadasModelo += 1;
    if (usd === null) t.llamadasSinTarifa += 1;
    else t.costoModeloUsd += usd;
  } else if (tipo === "whatsapp") {
    t.mensajesWhatsapp += cantidad;
    if (usd === null) t.mensajesSinTarifa += cantidad;
    else t.costoWhatsappUsd += usd;
  } else {
    t.eventosOtros += cantidad;
    if (usd !== null) t.costoOtrosUsd += usd;
  }
}

export interface CostSummary {
  rango: { desde: string; hasta: string; zona: string };
  total: Totals;
  /** Lo que gastaron las conversaciones del Chat de pruebas: cuesta de verdad, pero no es de ningún paciente. */
  pruebas: Totals;
  porDia: Array<Totals & { dia: string }>;
  porClinica: Array<Totals & { clinicId: string; clinica: string; pais: string | null; moneda: string | null; cambio: Fx | null }>;
  porProveedor: Array<{ provider: string; etiqueta: string; eventos: number; costoUsd: number; sinTarifa: number }>;
  /** Lo que está sin tarifa, para avisarlo arriba de todo. */
  sinTarifa: { modelos: string[]; mensajes: number; llamadas: number };
}

/** El resumen de un rango, global o de UNA clínica. Las pruebas del chat van aparte y no suman al total. */
export async function buildCostSummary(range: CostRange, clinicId?: string): Promise<CostSummary> {
  const tz = env.platformTimezone;
  const [requests, events, sandbox, clinics, fx] = await Promise.all([
    prisma.agentRequest.findMany({
      where: { occurredAt: { gte: range.from, lt: range.to }, ...(clinicId ? { clinicId } : {}) },
      select: { occurredAt: true, clinicId: true, patientId: true, model: true, inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheCreationTokens: true, costUsd: true },
    }),
    prisma.usageEvent.findMany({
      where: { occurredAt: { gte: range.from, lt: range.to }, ...(clinicId ? { clinicId } : {}) },
      select: { occurredAt: true, clinicId: true, provider: true, quantity: true, costUsd: true },
    }),
    sandboxPatientIds(),
    prisma.clinic.findMany({ select: { id: true, name: true, country: true } }),
    currentFx(),
  ]);

  const paises = await prisma.country.findMany({ select: { id: true, currency: true } });
  const monedaDe = (iso: string | null) => (iso ? paises.find((p) => p.id.toUpperCase() === iso.toUpperCase())?.currency ?? null : null);

  const total = vacio();
  const pruebas = vacio();
  const dias = new Map<string, Totals>();
  const clinicas = new Map<string, Totals>();
  const proveedores = new Map<string, { eventos: number; costoUsd: number; sinTarifa: number }>();
  const modelosSinTarifa = new Set<string>();

  const aDia = (d: Date) => clinicDateKey(d, tz);
  const dato = <K>(m: Map<K, Totals>, k: K) => {
    const v = m.get(k) ?? vacio();
    m.set(k, v);
    return v;
  };
  const prov = (p: string) => {
    const v = proveedores.get(p) ?? { eventos: 0, costoUsd: 0, sinTarifa: 0 };
    proveedores.set(p, v);
    return v;
  };

  for (const r of requests) {
    const usd = r.costUsd === null ? null : Number(r.costUsd);
    const esPrueba = r.patientId !== null && sandbox.has(r.patientId);
    const destinos = esPrueba ? [pruebas] : [total, dato(dias, aDia(r.occurredAt)), dato(clinicas, r.clinicId)];
    for (const t of destinos) {
      sumar(t, "modelo", usd, 1);
      t.tokensEntrada += r.inputTokens ?? 0;
      t.tokensSalida += r.outputTokens ?? 0;
      t.tokensCache += (r.cacheReadTokens ?? 0) + (r.cacheCreationTokens ?? 0);
    }
    if (!esPrueba) {
      const p = prov("anthropic");
      p.eventos += 1;
      if (usd === null) {
        p.sinTarifa += 1;
        modelosSinTarifa.add(r.model);
      } else p.costoUsd += usd;
    }
  }

  for (const e of events) {
    const usd = e.costUsd === null ? null : Number(e.costUsd);
    const tipo = e.provider === "whatsapp" ? "whatsapp" : "otro";
    const cl = e.clinicId ? dato(clinicas, e.clinicId) : null;
    for (const t of [total, dato(dias, aDia(e.occurredAt)), ...(cl ? [cl] : [])]) sumar(t, tipo, usd, e.quantity);
    const p = prov(e.provider);
    p.eventos += e.quantity;
    if (usd === null) p.sinTarifa += e.quantity;
    else p.costoUsd += usd;
  }

  const porClinica = clinics
    .filter((c) => clinicas.has(c.id))
    .map((c) => {
      const moneda = monedaDe(c.country);
      return { clinicId: c.id, clinica: c.name, pais: c.country, moneda, cambio: moneda ? fx.get(moneda) ?? null : null, ...cerrar(clinicas.get(c.id)!) };
    })
    .sort((a, b) => b.costoTotalUsd - a.costoTotalUsd);

  return {
    rango: { desde: range.desde, hasta: range.hasta, zona: tz },
    total: cerrar(total),
    pruebas: cerrar(pruebas),
    porDia: [...dias.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dia, t]) => ({ dia, ...cerrar(t) })),
    porClinica,
    porProveedor: [...proveedores.entries()]
      .map(([provider, v]) => ({ provider, etiqueta: PROVIDER_LABELS[provider] ?? provider, eventos: v.eventos, costoUsd: redondear(v.costoUsd), sinTarifa: v.sinTarifa }))
      .sort((a, b) => b.costoUsd - a.costoUsd),
    sinTarifa: { modelos: [...modelosSinTarifa].sort(), mensajes: total.mensajesSinTarifa, llamadas: total.llamadasSinTarifa },
  };
}

export interface ConversationRow extends Totals {
  dia: string;
  /** Un identificador corto de la ficha (no el nombre ni el teléfono). `null` = mensajes sin paciente (avisos internos). */
  conversacion: string | null;
  prueba: boolean;
}

/** Tokens, mensajes y costo por conversación (el titular) y por día, de UNA clínica. Lo más caro primero. */
export async function buildConversationCosts(range: CostRange, clinicId: string, limit = 200): Promise<ConversationRow[]> {
  const tz = env.platformTimezone;
  const [requests, events, sandbox] = await Promise.all([
    prisma.agentRequest.findMany({
      where: { clinicId, occurredAt: { gte: range.from, lt: range.to } },
      select: { occurredAt: true, patientId: true, inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheCreationTokens: true, costUsd: true },
    }),
    prisma.usageEvent.findMany({
      where: { clinicId, provider: "whatsapp", occurredAt: { gte: range.from, lt: range.to } },
      select: { occurredAt: true, patientId: true, quantity: true, costUsd: true },
    }),
    sandboxPatientIds(),
  ]);

  const filas = new Map<string, ConversationRow>();
  const fila = (d: Date, patientId: string | null) => {
    const dia = clinicDateKey(d, tz);
    const clave = `${dia}|${patientId ?? ""}`;
    const f = filas.get(clave) ?? { ...vacio(), dia, conversacion: patientId ? patientId.slice(-6) : null, prueba: patientId !== null && sandbox.has(patientId) };
    filas.set(clave, f);
    return f;
  };
  for (const r of requests) {
    const f = fila(r.occurredAt, r.patientId);
    sumar(f, "modelo", r.costUsd === null ? null : Number(r.costUsd), 1);
    f.tokensEntrada += r.inputTokens ?? 0;
    f.tokensSalida += r.outputTokens ?? 0;
    f.tokensCache += (r.cacheReadTokens ?? 0) + (r.cacheCreationTokens ?? 0);
  }
  for (const e of events) sumar(fila(e.occurredAt, e.patientId), "whatsapp", e.costUsd === null ? null : Number(e.costUsd), e.quantity);

  return [...filas.values()]
    .map((f) => ({ ...f, ...cerrar(f) }))
    .sort((a, b) => b.costoTotalUsd - a.costoTotalUsd || b.tokensEntrada + b.tokensSalida - (a.tokensEntrada + a.tokensSalida))
    .slice(0, Math.min(Math.max(limit, 1), 500));
}

export interface InventoryRow {
  key: string;
  provider: string;
  proveedor: string;
  operacion: string;
  cobro: string;
  unidad: string | null;
  gratis: boolean;
  registradoEn: string;
  eventos: number;
  costoUsd: number;
  sinTarifa: number;
  /** `true` si hay una tarifa vigente cargada (o si es gratis por definición). */
  conTarifa: boolean;
}

/** El inventario: cada integración y operación, con su volumen y costo del rango y si tiene tarifa. */
export async function buildInventory(range: CostRange): Promise<{ filas: InventoryRow[]; noRegistrado: string[] }> {
  const [events, requests, rates] = await Promise.all([
    prisma.usageEvent.groupBy({
      by: ["provider", "kind"],
      where: { occurredAt: { gte: range.from, lt: range.to } },
      _sum: { quantity: true, costUsd: true },
    }),
    prisma.agentRequest.aggregate({
      where: { occurredAt: { gte: range.from, lt: range.to } },
      _count: { _all: true },
      _sum: { costUsd: true },
    }),
    loadRates(),
  ]);
  const sinTarifaModelo = await prisma.agentRequest.count({ where: { occurredAt: { gte: range.from, lt: range.to }, costUsd: null } });
  const ahora = new Date();

  const filas = COST_CATALOG.map((c): InventoryRow => {
    let eventos = 0;
    let costoUsd = 0;
    let sinTarifa = 0;
    if (c.provider === "anthropic") {
      eventos = requests._count._all;
      costoUsd = Number(requests._sum.costUsd ?? 0);
      sinTarifa = sinTarifaModelo;
    } else {
      const e = events.find((x) => `${x.provider}:${x.kind}` === c.key);
      eventos = e?._sum.quantity ?? 0;
      costoUsd = Number(e?._sum.costUsd ?? 0);
    }
    const conTarifa =
      c.free ||
      (c.provider === "anthropic"
        ? sinTarifaModelo === 0
        : [...rates.keys()].some((item) => item === c.key || item.startsWith(`${c.provider}:`)) && rateAt(rates, c.key, ahora) !== null) ||
      (c.provider === "whatsapp" && [...rates.keys()].some((item) => item.startsWith("whatsapp:utility:")));
    return {
      key: c.key, provider: c.provider, proveedor: c.providerLabel, operacion: c.label, cobro: c.billing, unidad: c.unit,
      gratis: c.free, registradoEn: c.recordedIn, eventos, costoUsd: redondear(costoUsd), sinTarifa, conTarifa,
    };
  });
  return { filas, noRegistrado: UNMETERED_NOTES };
}

// --- Tarifas y tipos de cambio (se editan en la pantalla) ---

export const RATE_UNITS = ["usd_por_millon_tokens", "usd_por_mensaje", "usd_por_llamada"] as const;

export function validateRateInput(b: Record<string, unknown>):
  | { ok: true; value: { provider: string; item: string; unit: (typeof RATE_UNITS)[number]; priceUsd: number; effectiveFrom: Date; note: string | null } }
  | { ok: false; error: string } {
  const texto = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const provider = texto(b.provider);
  const item = texto(b.item);
  if (!provider || !/^[a-z0-9_]+$/.test(provider)) return { ok: false, error: "`provider` es obligatorio (minúsculas, números y guion bajo)." };
  if (!item || item.length > 120 || /\s/.test(item)) return { ok: false, error: "`item` es obligatorio, sin espacios y de hasta 120 caracteres." };
  if (!RATE_UNITS.includes(b.unit as never)) return { ok: false, error: `\`unit\` tiene que ser una de: ${RATE_UNITS.join(", ")}.` };
  if (typeof b.priceUsd !== "number" || !Number.isFinite(b.priceUsd) || b.priceUsd < 0 || b.priceUsd > 100000) return { ok: false, error: "`priceUsd` tiene que ser un número entre 0 y 100000." };
  const fecha = typeof b.effectiveFrom === "string" ? dateKeyToUtcMidnight(b.effectiveFrom) : null;
  if (!fecha) return { ok: false, error: "`effectiveFrom` tiene que ser una fecha real AAAA-MM-DD." };
  const note = texto(b.note);
  if (note.length > 200 || /[\r\n]/.test(note)) return { ok: false, error: "`note` es de una línea, hasta 200 caracteres." };
  return { ok: true, value: { provider, item, unit: b.unit as (typeof RATE_UNITS)[number], priceUsd: b.priceUsd, effectiveFrom: fecha, note: note || null } };
}
