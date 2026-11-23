import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import { interpretWithClient, parseAgentResponse } from "../src/services/claude";
import {
  AGENT_REQUEST_RETENTION_DAYS,
  agentRequestStats,
  decisionOf,
  listAgentRequests,
  pruneAgentRequests,
  recordAgentRequest,
} from "../src/services/agent-requests";
import { buildSystemPrompt } from "../src/prompts/system-prompt";
import type { ClaudeAgentResponse } from "../src/types";

/**
 * Cada solicitud al agente (la llamada al modelo) queda registrada: cuánto tardó, cuánto
 * costó, cómo terminó y qué decidió. **Sin el texto**: ni el prompt, ni el mensaje del
 * paciente, ni la respuesta, ni nombres.
 */

const clinicIds: string[] = [];

async function clinica() {
  const c = await prisma.clinic.create({
    data: {
      name: `Clínica agente ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `ag-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: "UTC",
      services: "Limpieza",
    },
  });
  clinicIds.push(c.id);
  return c;
}

afterEach(async () => {
  for (const clinicId of clinicIds) {
    await prisma.agentRequest.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

const NOMBRE_SECRETO = "NOMBRE-DEL-PACIENTE-QUE-NO-DEBE-QUEDAR";
const MENSAJE_SECRETO = "MENSAJE-DEL-PACIENTE-QUE-NO-DEBE-QUEDAR";
const RESPUESTA_SECRETA = "RESPUESTA-AL-PACIENTE-QUE-NO-DEBE-QUEDAR";
const MOTIVO_SECRETO = "MOTIVO-EN-TEXTO-QUE-NO-DEBE-QUEDAR";

const respuestaDelModelo: ClaudeAgentResponse = {
  intent: "cancelar",
  servicio: "Limpieza",
  fecha_solicitada: null,
  hora_solicitada: null,
  nombre_paciente: NOMBRE_SECRETO,
  paciente_del_turno: NOMBRE_SECRETO,
  turno_a_modificar: "cita-123",
  profesional_solicitado: null,
  requiere_horarios_disponibles: false,
  confirmacion_explicita: false,
  pidio_ubicacion: false,
  escalar_a_humano: true,
  motivo_escalar: "otro",
  motivo_cancelacion: MOTIVO_SECRETO,
  motivo_es_queja: true,
  turno_cancelado: null,
  respuesta_al_paciente: RESPUESTA_SECRETA,
};

/** Un cliente de Anthropic falso: devuelve lo que se le pida y cuenta las llamadas. */
function clienteFalso(respuesta: unknown) {
  const llamadas: unknown[] = [];
  return {
    llamadas,
    cliente: {
      messages: {
        create: async (body: unknown) => {
          llamadas.push(body);
          if (respuesta instanceof Error) throw respuesta;
          return respuesta as never;
        },
      },
    } as unknown as Parameters<typeof interpretWithClient>[0],
  };
}

const exito = (json: unknown = respuestaDelModelo) => ({
  content: [{ type: "text", text: JSON.stringify(json) }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1200, output_tokens: 180, cache_read_input_tokens: 900, cache_creation_input_tokens: 300 },
});

async function llamar(c: Awaited<ReturnType<typeof clinica>>, cliente: Parameters<typeof interpretWithClient>[0], over?: { kind?: "interpretacion" | "reinterpretacion" | "explicacion_fallo"; attempt?: number; turnId?: string }) {
  return interpretWithClient(cliente, {
    clinic: c,
    patientMessage: MENSAJE_SECRETO,
    conversationHistory: "(sin historial)",
    turnosPaciente: "sin citas",
    historialPersonas: "ninguna de estas personas tiene atenciones",
    canceladasSinMotivo: "ninguna",
    esPrimeraVez: false,
    trace: { turnId: over?.turnId ?? "turno-1", kind: over?.kind ?? "interpretacion", attempt: over?.attempt ?? 1, patientId: null },
  });
}

describe("cada llamada al modelo queda registrada", () => {
  it("una llamada correcta guarda tiempo, tokens, cómo terminó, la intención y la decisión", async () => {
    const c = await clinica();
    const { cliente } = clienteFalso(exito());
    const r = await llamar(c, cliente);
    expect(r.intent).toBe("cancelar");

    const fila = await prisma.agentRequest.findFirstOrThrow({ where: { clinicId: c.id } });
    expect(fila).toMatchObject({
      turnId: "turno-1",
      kind: "interpretacion",
      attempt: 1,
      model: "claude-sonnet-5",
      inputTokens: 1200,
      outputTokens: 180,
      cacheReadTokens: 900,
      cacheCreationTokens: 300,
      stopReason: "end_turn",
      outcome: "ok",
      errorMessage: null,
      intent: "cancelar",
    });
    expect(fila.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fila.promptChars).toBeGreaterThan(500);
    expect(fila.decision).toMatchObject({
      intent: "cancelar",
      servicio: "Limpieza",
      turno_a_modificar: "cita-123",
      escalar_a_humano: true,
      motivo_es_queja: true,
      dio_motivo_de_cancelacion: true,
    });
  });

  it("NUNCA guarda el texto: ni el mensaje, ni la respuesta, ni nombres, ni el motivo en texto", async () => {
    const c = await clinica();
    const { cliente } = clienteFalso(exito());
    await llamar(c, cliente);
    const fila = await prisma.agentRequest.findFirstOrThrow({ where: { clinicId: c.id } });
    const todo = JSON.stringify(fila);
    for (const secreto of [NOMBRE_SECRETO, MENSAJE_SECRETO, RESPUESTA_SECRETA, MOTIVO_SECRETO]) {
      expect(todo).not.toContain(secreto);
    }
  });

  it("la decisión no incluye los textos aunque estén en la respuesta", () => {
    const d = JSON.stringify(decisionOf(respuestaDelModelo));
    for (const secreto of [NOMBRE_SECRETO, RESPUESTA_SECRETA, MOTIVO_SECRETO]) expect(d).not.toContain(secreto);
  });

  it("si la llamada falla: queda como error, con el mensaje, y el error sigue subiendo", async () => {
    const c = await clinica();
    const { cliente } = clienteFalso(new Error("429 rate limit"));
    await expect(llamar(c, cliente)).rejects.toThrow("429 rate limit");
    const fila = await prisma.agentRequest.findFirstOrThrow({ where: { clinicId: c.id } });
    expect(fila).toMatchObject({ outcome: "error", errorMessage: "429 rate limit", intent: null, inputTokens: null });
    expect(fila.promptChars).toBeGreaterThan(0);
  });

  it("si el modelo no devuelve texto: 'sin_texto', con el stop_reason", async () => {
    const c = await clinica();
    const { cliente } = clienteFalso({ content: [{ type: "tool_use" }], stop_reason: "max_tokens", usage: { input_tokens: 10, output_tokens: 2048 } });
    await expect(llamar(c, cliente)).rejects.toThrow(/no devolvió texto/);
    expect(await prisma.agentRequest.findFirstOrThrow({ where: { clinicId: c.id } })).toMatchObject({
      outcome: "sin_texto",
      stopReason: "max_tokens",
      outputTokens: 2048,
    });
  });

  it("si devuelve algo que no se puede leer: 'no_interpretable'", async () => {
    const c = await clinica();
    const { cliente } = clienteFalso({ content: [{ type: "text", text: "esto no es JSON" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
    await expect(llamar(c, cliente)).rejects.toThrow(/no se pudo interpretar/);
    expect((await prisma.agentRequest.findFirstOrThrow({ where: { clinicId: c.id } })).outcome).toBe("no_interpretable");
  });

  it("las llamadas de un mismo mensaje se agrupan por `turnId` y se distinguen por tipo e intento", async () => {
    const c = await clinica();
    const { cliente: roto } = clienteFalso(new Error("timeout"));
    await llamar(c, roto, { turnId: "T", kind: "interpretacion", attempt: 1 }).catch(() => undefined);
    const { cliente } = clienteFalso(exito());
    await llamar(c, cliente, { turnId: "T", kind: "interpretacion", attempt: 2 });
    await llamar(c, cliente, { turnId: "T", kind: "reinterpretacion", attempt: 1 });
    await llamar(c, cliente, { turnId: "OTRO", kind: "interpretacion", attempt: 1 });

    const delTurno = await prisma.agentRequest.findMany({ where: { turnId: "T" }, orderBy: { occurredAt: "asc" } });
    expect(delTurno.map((f) => [f.kind, f.attempt, f.outcome])).toEqual([
      ["interpretacion", 1, "error"],
      ["interpretacion", 2, "ok"],
      ["reinterpretacion", 1, "ok"],
    ]);
  });

  it("un fallo al escribir el registro no tumba la respuesta al paciente", async () => {
    // Una clínica que no existe: viola la FK y el INSERT falla.
    await expect(
      recordAgentRequest({
        clinicId: "no-existe",
        trace: { turnId: "t", kind: "interpretacion", attempt: 1, patientId: null },
        model: "m",
        latencyMs: 1,
        outcome: "ok",
      })
    ).resolves.toBeUndefined();
  });
});

describe("consultar las solicitudes", () => {
  it("las estadísticas suman llamadas, errores, tiempos, tokens y mensajes distintos", async () => {
    const c = await clinica();
    const { cliente } = clienteFalso(exito());
    await llamar(c, cliente, { turnId: "A" });
    await llamar(c, cliente, { turnId: "A", kind: "reinterpretacion" });
    await llamar(c, cliente, { turnId: "B" });
    const { cliente: roto } = clienteFalso(new Error("x"));
    await llamar(c, roto, { turnId: "C" }).catch(() => undefined);

    const e = await agentRequestStats(new Date(Date.now() - 60_000));
    // Hay otras clínicas en la base de pruebas: se compara contra un mínimo.
    expect(e.llamadas).toBeGreaterThanOrEqual(4);
    expect(e.errores).toBeGreaterThanOrEqual(1);
    expect(e.mensajes).toBeGreaterThanOrEqual(3);
    expect(e.tokensEntrada).toBeGreaterThanOrEqual(3600);
    expect(e.tokensSalida).toBeGreaterThanOrEqual(540);
    expect(e.latenciaMediaMs).not.toBeNull();
  });

  it("el listado filtra por clínica, resultado y mensaje, y pagina del más nuevo al más viejo", async () => {
    const c = await clinica();
    const otra = await clinica();
    const { cliente } = clienteFalso(exito());
    await llamar(c, cliente, { turnId: "X1" });
    await llamar(otra, cliente, { turnId: "X2" });
    const { cliente: roto } = clienteFalso(new Error("x"));
    await llamar(c, roto, { turnId: "X3" }).catch(() => undefined);

    const deC = await listAgentRequests({ clinicId: c.id });
    expect(deC.solicitudes).toHaveLength(2);
    expect(deC.solicitudes.every((s) => s.clinicId === c.id)).toBe(true);
    expect((await listAgentRequests({ clinicId: c.id, outcome: "error" })).solicitudes.map((s) => s.turnId)).toEqual(["X3"]);
    expect((await listAgentRequests({ turnId: "X2" })).solicitudes).toHaveLength(1);

    const primera = await listAgentRequests({ clinicId: c.id, limit: 1 });
    expect(primera.solicitudes[0].turnId).toBe("X3");
    expect(primera.siguiente).not.toBeNull();
    const segunda = await listAgentRequests({ clinicId: c.id, limit: 1, before: new Date(primera.siguiente!) });
    expect(segunda.solicitudes[0].turnId).toBe("X1");
  });

  it("la limpieza borra lo que pasó la retención y deja lo reciente", async () => {
    const c = await clinica();
    const viejo = await prisma.agentRequest.create({
      data: {
        clinicId: c.id, turnId: "viejo", kind: "interpretacion", model: "m", latencyMs: 1, outcome: "ok",
        occurredAt: new Date(Date.now() - (AGENT_REQUEST_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000),
      },
    });
    const reciente = await prisma.agentRequest.create({
      data: { clinicId: c.id, turnId: "reciente", kind: "interpretacion", model: "m", latencyMs: 1, outcome: "ok" },
    });
    await pruneAgentRequests();
    expect(await prisma.agentRequest.findUnique({ where: { id: viejo.id } })).toBeNull();
    expect(await prisma.agentRequest.findUnique({ where: { id: reciente.id } })).not.toBeNull();
  });

  it("se van con la clínica (CASCADE)", async () => {
    const c = await clinica();
    const { cliente } = clienteFalso(exito());
    await llamar(c, cliente);
    clinicIds.pop();
    await prisma.clinic.delete({ where: { id: c.id } });
    expect(await prisma.agentRequest.count({ where: { clinicId: c.id } })).toBe(0);
  });
});

describe("los campos nuevos de la respuesta del modelo", () => {
  const base = {
    intent: "cancelar", requiere_horarios_disponibles: false, confirmacion_explicita: false, escalar_a_humano: false,
    respuesta_al_paciente: "ok",
  };

  it("si faltan, no tiran la respuesta: significa 'no dio motivo'", () => {
    const r = parseAgentResponse(JSON.stringify(base));
    expect(r).toMatchObject({ motivo_cancelacion: null, motivo_es_queja: false, turno_cancelado: null });
  });

  it("los acepta cuando vienen bien, y normaliza lo raro", () => {
    expect(parseAgentResponse(JSON.stringify({ ...base, motivo_cancelacion: "Un viaje", motivo_es_queja: true, turno_cancelado: "c1" })))
      .toMatchObject({ motivo_cancelacion: "Un viaje", motivo_es_queja: true, turno_cancelado: "c1" });
    expect(parseAgentResponse(JSON.stringify({ ...base, motivo_cancelacion: "  ", motivo_es_queja: "sí", turno_cancelado: 5 })))
      .toMatchObject({ motivo_cancelacion: null, motivo_es_queja: false, turno_cancelado: null });
  });
});

describe("la regla del prompt sobre el motivo de la cancelación", () => {
  const clinic = {
    name: "Clínica Demo", customerNoun: "paciente", escalationCriteria: "x", country: "AR", timezone: "UTC",
    address: null, minLeadMinutes: 0, services: "Limpieza",
  } as unknown as Parameters<typeof buildSystemPrompt>[0];
  const prompt = buildSystemPrompt(clinic, { esPrimeraVez: false });

  it("pide preguntarlo con sutileza y SIN frenar ni condicionar la cancelación", () => {
    expect(prompt).toContain("Motivo de la cancelación");
    expect(prompt).toContain("CON MUCHA SUTILEZA");
    expect(prompt).toContain("SIN condicionar ni demorar");
    expect(prompt).toContain("cancela igual");
    expect(prompt).toContain("UNA sola vez");
    expect(prompt).toContain("Nunca condiciones la cancelación");
  });

  it("para una queja: una pregunta amable, queja marcada y a una persona", () => {
    expect(prompt).toContain('"motivo_es_queja": true');
    expect(prompt).toContain("UNA pregunta amable");
    expect(prompt).toContain('"escalar_a_humano": true');
    expect(prompt).toContain("no prometas compensaciones");
  });

  it("explica cómo registrar un motivo que llega después, con el id de la lista", () => {
    expect(prompt).toContain("Citas canceladas recientemente por este");
    expect(prompt).toContain("turno_cancelado");
    expect(prompt).toContain("no inventes un id");
  });

  it("los tres campos están en el JSON que se le pide", () => {
    for (const campo of ['"motivo_cancelacion"', '"motivo_es_queja"', '"turno_cancelado"']) expect(prompt).toContain(campo);
  });
});
