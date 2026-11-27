import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import { recordAgentRequest } from "../src/services/agent-requests";
import { sendTemplateMessage, sendTextMessage, clinicWhatsAppCreds } from "../src/services/whatsapp";
import {
  buildConversationCosts,
  buildCostSummary,
  buildInventory,
  integrationCostUsd,
  loadRates,
  modelCostUsd,
  parseCostRange,
  rateAt,
  recordUsageEvent,
  recordWhatsAppSend,
  buildServiceQuota,
  validateRateInput,
  whatsappCostUsd,
} from "../src/services/costs";

/**
 * Costos: el costo se congela al ocurrir el evento, sin tarifa es null (nunca 0), lo gratis por definición es 0, y
 * lo registrado no lleva teléfonos, nombres ni texto.
 */

const MODEL = "test-model-xyz";
const clinicIds: string[] = [];
const rateIds: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of clinicIds) {
    await prisma.usageEvent.deleteMany({ where: { clinicId: id } });
    await prisma.agentRequest.deleteMany({ where: { clinicId: id } });
    await prisma.patient.deleteMany({ where: { clinicId: id } });
    await prisma.clinic.delete({ where: { id } });
  }
  clinicIds.length = 0;
  await prisma.costRate.deleteMany({ where: { OR: [{ id: { in: rateIds } }, { item: { startsWith: `${MODEL}:` } }] } });
  rateIds.length = 0;
  await prisma.usageEvent.deleteMany({ where: { clinicId: null, provider: "google_places", occurredAt: { gte: new Date(Date.now() - 60_000) } } });
});

async function crearClinica(country: string | null = "MX") {
  const c = await prisma.clinic.create({
    data: {
      name: `Clínica costos ${Date.now()}-${Math.random()}`, whatsappPhoneNumberId: `co-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"), email: "t@example.com", timezone: "America/Mexico_City", country, services: "Limpieza",
    },
  });
  clinicIds.push(c.id);
  return c;
}

async function tarifa(item: string, priceUsd: number, effectiveFrom = "2020-01-01", unit = "usd_por_mensaje") {
  const t = await prisma.costRate.create({
    data: { provider: item.split(":")[0], item, unit, priceUsd, effectiveFrom: new Date(`${effectiveFrom}T00:00:00Z`) },
  });
  rateIds.push(t.id);
  return t;
}

const cargarModelo = async (entrada: number, salida: number) => {
  await tarifa(`${MODEL}:input`, entrada, "2020-01-01", "usd_por_millon_tokens");
  await tarifa(`${MODEL}:output`, salida, "2020-01-01", "usd_por_millon_tokens");
};

describe("el costo del modelo", () => {
  it("sale de los tokens y la tarifa de ESE modelo; la caché sin tarifa propia usa la de entrada", async () => {
    await cargarModelo(3, 15);
    const rates = await loadRates();
    const usd = modelCostUsd(rates, MODEL, { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000 }, new Date());
    expect(usd).toBeCloseTo(3 + 1.5 + 1.5, 6);
  });

  it("sin tarifa de entrada o de salida es null, nunca cero", async () => {
    await tarifa(`${MODEL}:input`, 3, "2020-01-01", "usd_por_millon_tokens");
    expect(modelCostUsd(await loadRates(), MODEL, { inputTokens: 10, outputTokens: 10 }, new Date())).toBeNull();
    expect(modelCostUsd(await loadRates(), "otro-modelo", { inputTokens: 10, outputTokens: 10 }, new Date())).toBeNull();
  });

  it("rige la tarifa vigente a la fecha del evento, no la más nueva", async () => {
    await tarifa(`${MODEL}:input`, 1, "2020-01-01", "usd_por_millon_tokens");
    await tarifa(`${MODEL}:input`, 10, "2030-01-01", "usd_por_millon_tokens");
    const rates = await loadRates();
    expect(rateAt(rates, `${MODEL}:input`, new Date("2026-06-01T00:00:00Z"))).toBe(1);
    expect(rateAt(rates, `${MODEL}:input`, new Date("2031-06-01T00:00:00Z"))).toBe(10);
    expect(rateAt(rates, `${MODEL}:input`, new Date("2019-01-01T00:00:00Z"))).toBeNull();
  });

  it("recordAgentRequest congela el costo: cambiar la tarifa después no lo mueve", async () => {
    const c = await crearClinica();
    await cargarModelo(2, 10);
    const base = { clinicId: c.id, trace: { turnId: "t1", kind: "interpretacion" as const, attempt: 1, patientId: null }, model: MODEL, latencyMs: 5, outcome: "ok" as const };
    await recordAgentRequest({ ...base, inputTokens: 1_000_000, outputTokens: 0 });
    await prisma.costRate.updateMany({ where: { item: `${MODEL}:input` }, data: { priceUsd: 99 } });
    const fila = await prisma.agentRequest.findFirstOrThrow({ where: { clinicId: c.id } });
    expect(Number(fila.costUsd)).toBeCloseTo(2, 6);
  });

  it("sin tarifa guarda null, y una llamada que falló (sin tokens) también", async () => {
    const c = await crearClinica();
    const base = { clinicId: c.id, trace: { turnId: "t2", kind: "interpretacion" as const, attempt: 1, patientId: null }, model: MODEL, latencyMs: 5 };
    await recordAgentRequest({ ...base, outcome: "ok", inputTokens: 100, outputTokens: 50 });
    await recordAgentRequest({ ...base, outcome: "error", error: new Error("x") });
    const filas = await prisma.agentRequest.findMany({ where: { clinicId: c.id } });
    expect(filas).toHaveLength(2);
    expect(filas.every((f) => f.costUsd === null)).toBe(true);
  });
});

describe("el costo de WhatsApp y de las integraciones", () => {
  it("la tarifa del país gana sobre la general; sin ninguna es null, salvo el texto de servicio que es gratis", async () => {
    await tarifa("whatsapp:utility:MX", 0.04);
    await tarifa("whatsapp:utility:*", 0.02);
    const rates = await loadRates();
    const ahora = new Date();
    expect(whatsappCostUsd(rates, "utility", "MX", ahora)).toBe(0.04);
    expect(whatsappCostUsd(rates, "utility", "AR", ahora)).toBe(0.02);
    expect(whatsappCostUsd(rates, "marketing", "MX", ahora)).toBeNull();
    expect(whatsappCostUsd(rates, "service", "MX", ahora)).toBe(0);
  });

  it("lo gratis por definición (Calendar) cuesta 0, y lo que se cobra sin tarifa es null", async () => {
    const rates = await loadRates();
    expect(integrationCostUsd(rates, "google_calendar:crear_evento", new Date())).toBe(0);
    expect(integrationCostUsd(rates, "google_places:text_search", new Date())).toBeNull();
  });

  it("recordUsageEvent congela el costo y NUNCA lanza, aunque falle la base", async () => {
    const c = await crearClinica();
    await tarifa("whatsapp:utility:MX", 0.05);
    await recordUsageEvent({ clinicId: c.id, provider: "whatsapp", kind: "plantilla", category: "utility", country: "MX", quantity: 2 });
    const fila = await prisma.usageEvent.findFirstOrThrow({ where: { clinicId: c.id } });
    expect(Number(fila.costUsd)).toBeCloseTo(0.1, 6);
    await expect(recordUsageEvent({ clinicId: "no-existe", provider: "whatsapp", kind: "texto" })).resolves.toBeUndefined();
  });
});

describe("el registro de los envíos de WhatsApp", () => {
  it("sendTemplateMessage y sendTextMessage registran el envío que salió, sin teléfono ni texto", async () => {
    const c = await crearClinica("MX");
    const p = await prisma.patient.create({ data: { clinicId: c.id, phone: "5215511112222", name: "Persona Reconocible" } });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "" })));
    const creds = clinicWhatsAppCreds({ ...c, whatsappTokenEncrypted: c.whatsappTokenEncrypted });
    await sendTemplateMessage(creds, "5215511112222", "recordatorio_turno", "es", ["Persona Reconocible"]);
    await sendTextMessage(creds, "5215511112222", "Texto muy reconocible del mensaje");
    vi.unstubAllGlobals();

    const filas = await prisma.usageEvent.findMany({ where: { clinicId: c.id }, orderBy: { occurredAt: "asc" } });
    expect(filas.map((f) => [f.kind, f.category, f.templateName, f.patientId])).toEqual([
      ["plantilla", "utility", "recordatorio_turno", p.id],
      ["texto", "service", null, p.id],
    ]);
    const crudo = JSON.stringify(filas);
    expect(crudo).not.toContain("5215511112222");
    expect(crudo).not.toContain("Reconocible");
  });

  it("una plantilla de Marketing del catálogo se registra con su categoría real", async () => {
    const c = await crearClinica("MX");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "" })));
    const creds = clinicWhatsAppCreds({ ...c, whatsappTokenEncrypted: c.whatsappTokenEncrypted });
    await sendTemplateMessage(creds, "5215511112222", "proximo_control", "es", ["a", "b", "c"]);
    vi.unstubAllGlobals();
    const filas = await prisma.usageEvent.findMany({ where: { clinicId: c.id } });
    expect(filas.map((f) => [f.templateName, f.category])).toEqual([["proximo_control", "marketing"]]);
  });

  it("el cupo mensual de servicio: dentro es gratis, el exceso usa la tarifa o queda sin tarifa", async () => {
    const c = await crearClinica("MX");
    const otra = await crearClinica("MX");
    await tarifa("whatsapp:cupo_servicio_mensual:MX", 2, "2020-01-01", "mensajes_por_mes");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "" })));
    const creds = clinicWhatsAppCreds({ ...c, whatsappTokenEncrypted: c.whatsappTokenEncrypted });
    for (let i = 0; i < 3; i++) await sendTextMessage(creds, "5215511112222", "x");
    // sin tarifa de servicio, el que pasa del cupo queda sin tarifa
    let filas = await prisma.usageEvent.findMany({ where: { clinicId: c.id }, orderBy: { occurredAt: "asc" } });
    expect(filas.map((f) => (f.costUsd === null ? null : Number(f.costUsd)))).toEqual([0, 0, null]);
    await tarifa("whatsapp:service:MX", 0.0085);
    await sendTextMessage(creds, "5215511112222", "x");
    filas = await prisma.usageEvent.findMany({ where: { clinicId: c.id }, orderBy: { occurredAt: "asc" } });
    expect(Number(filas[3].costUsd)).toBe(0.0085);
    // otra clínica tiene su propio cupo
    const credsOtra = clinicWhatsAppCreds({ ...otra, whatsappTokenEncrypted: otra.whatsappTokenEncrypted });
    await sendTextMessage(credsOtra, "5215511113333", "x");
    vi.unstubAllGlobals();
    const f2 = await prisma.usageEvent.findMany({ where: { clinicId: otra.id } });
    expect(Number(f2[0].costUsd)).toBe(0);

    const m = await buildServiceQuota(c.id);
    expect(m.filas).toEqual([expect.objectContaining({ enviados: 4, cupo: 2, gratis: 2, cobrados: 2 })]);
  });

  it("un envío que Meta rechazó no se registra", async () => {
    const c = await crearClinica();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, text: async () => "no" })));
    await expect(sendTextMessage(clinicWhatsAppCreds(c), "5491100000000", "hola")).rejects.toThrow();
    vi.unstubAllGlobals();
    expect(await prisma.usageEvent.count({ where: { clinicId: c.id } })).toBe(0);
  });

  it("encuentra al paciente aunque el teléfono guardado lleve el 1 de México y el destinatario no", async () => {
    const c = await crearClinica("MX");
    const p = await prisma.patient.create({ data: { clinicId: c.id, phone: "5215599998888" } });
    await recordWhatsAppSend({ clinicId: c.id, country: "MX", to: "525599998888", kind: "plantilla", templateName: "x" });
    expect((await prisma.usageEvent.findFirstOrThrow({ where: { clinicId: c.id } })).patientId).toBe(p.id);
  });
});

describe("el resumen, las conversaciones y el inventario", () => {
  const hoy = () => parseCostRange({}) as Exclude<ReturnType<typeof parseCostRange>, { error: string }>;

  it("suma por clínica, por día y por proveedor, y deja las pruebas del chat aparte", async () => {
    const c = await crearClinica("MX");
    await cargarModelo(1, 1);
    await tarifa("whatsapp:utility:MX", 0.5);
    const real = await prisma.patient.create({ data: { clinicId: c.id, phone: "5215500000001" } });
    const prueba = await prisma.patient.create({ data: { clinicId: c.id, phone: "prueba:u1" } });
    const base = { clinicId: c.id, model: MODEL, latencyMs: 1, outcome: "ok" as const, inputTokens: 1_000_000, outputTokens: 0 };
    await recordAgentRequest({ ...base, trace: { turnId: "a", kind: "interpretacion", attempt: 1, patientId: real.id } });
    await recordAgentRequest({ ...base, trace: { turnId: "b", kind: "interpretacion", attempt: 1, patientId: prueba.id } });
    await recordWhatsAppSend({ clinicId: c.id, country: "MX", to: "5215500000001", kind: "plantilla", templateName: "recordatorio_turno" });

    const r = await buildCostSummary(hoy(), c.id);
    expect(r.total.llamadasModelo).toBe(1);
    expect(r.total.costoModeloUsd).toBeCloseTo(1, 6);
    expect(r.total.mensajesWhatsapp).toBe(1);
    expect(r.total.costoWhatsappUsd).toBeCloseTo(0.5, 6);
    expect(r.total.costoTotalUsd).toBeCloseTo(1.5, 6);
    expect(r.pruebas.llamadasModelo).toBe(1); // cuesta de verdad, pero no suma al total
    expect(r.porClinica).toHaveLength(1);
    expect(r.porDia).toHaveLength(1);
    expect(r.porProveedor.map((p) => p.provider).sort()).toEqual(["anthropic", "whatsapp"]);
  });

  it("avisa lo que quedó sin tarifa en vez de contarlo como cero", async () => {
    const c = await crearClinica("MX");
    const base = { clinicId: c.id, model: MODEL, latencyMs: 1, outcome: "ok" as const, inputTokens: 10, outputTokens: 5 };
    await recordAgentRequest({ ...base, trace: { turnId: "z", kind: "interpretacion", attempt: 1, patientId: null } });
    await recordWhatsAppSend({ clinicId: c.id, country: "MX", to: "5215500000002", kind: "plantilla", templateName: "x" });
    const r = await buildCostSummary(hoy(), c.id);
    expect(r.sinTarifa.llamadas).toBe(1);
    expect(r.sinTarifa.modelos).toEqual([MODEL]);
    expect(r.sinTarifa.mensajes).toBe(1);
    expect(r.total.costoTotalUsd).toBe(0);
  });

  it("por conversación agrupa tokens y mensajes del mismo titular en el mismo día, sin nombre ni teléfono", async () => {
    const c = await crearClinica("MX");
    await cargarModelo(1, 1);
    const p = await prisma.patient.create({ data: { clinicId: c.id, phone: "5215500000003", name: "Nombre Reconocible" } });
    const base = { clinicId: c.id, model: MODEL, latencyMs: 1, outcome: "ok" as const, inputTokens: 100, outputTokens: 50 };
    await recordAgentRequest({ ...base, trace: { turnId: "1", kind: "interpretacion", attempt: 1, patientId: p.id } });
    await recordAgentRequest({ ...base, trace: { turnId: "2", kind: "reinterpretacion", attempt: 1, patientId: p.id } });
    await recordWhatsAppSend({ clinicId: c.id, country: "MX", to: "5215500000003", kind: "texto" });
    const filas = await buildConversationCosts(hoy(), c.id);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ llamadasModelo: 2, tokensEntrada: 200, tokensSalida: 100, mensajesWhatsapp: 1, conversacion: p.id.slice(-6), prueba: false });
    expect(JSON.stringify(filas)).not.toMatch(/Reconocible|5215500000003/);
  });

  it("el inventario lista cada integración del catálogo con su volumen y si tiene tarifa", async () => {
    await recordUsageEvent({ provider: "google_places", kind: "text_search" });
    const { filas, noRegistrado } = await buildInventory(hoy());
    const places = filas.find((f) => f.key === "google_places:text_search")!;
    expect(places.eventos).toBeGreaterThanOrEqual(1);
    expect(places.conTarifa).toBe(false);
    expect(filas.find((f) => f.key === "google_calendar:crear_evento")!.gratis).toBe(true);
    expect(filas.map((f) => f.provider)).toEqual(expect.arrayContaining(["anthropic", "whatsapp", "google_places", "google_calendar", "microsoft_graph"]));
    expect(noRegistrado.length).toBeGreaterThan(0);
  });
});

describe("el rango de fechas y la carga de tarifas", () => {
  it("sin parámetros son los últimos 30 días; rechaza días falsos, rangos al revés y más de 366 días", () => {
    const ok = parseCostRange({}, new Date("2026-11-19T12:00:00Z"));
    expect(ok).toMatchObject({ desde: "2026-10-21", hasta: "2026-11-19" });
    expect(parseCostRange({ desde: "2026-02-31", hasta: "2026-03-01" })).toHaveProperty("error");
    expect(parseCostRange({ desde: "2026-03-02", hasta: "2026-03-01" })).toHaveProperty("error");
    expect(parseCostRange({ desde: "2024-01-01", hasta: "2026-01-01" })).toHaveProperty("error");
  });

  it("validateRateInput exige proveedor, ítem sin espacios, unidad válida, precio y fecha reales", () => {
    const bueno = { provider: "whatsapp", item: "whatsapp:utility:MX", unit: "usd_por_mensaje", priceUsd: 0.04, effectiveFrom: "2026-01-01" };
    expect(validateRateInput(bueno).ok).toBe(true);
    for (const malo of [
      { ...bueno, provider: "" }, { ...bueno, item: "con espacio" }, { ...bueno, unit: "euros" },
      { ...bueno, priceUsd: -1 }, { ...bueno, priceUsd: "0.04" }, { ...bueno, effectiveFrom: "2026-02-31" }, { ...bueno, note: "a\nb" },
    ]) expect(validateRateInput(malo as never).ok).toBe(false);
  });
});
