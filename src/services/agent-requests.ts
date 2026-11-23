import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import type { ClaudeAgentResponse } from "../types";
import { describeError } from "./system-events";
import { loadRates, modelCostUsd } from "./costs";

/**
 * El registro de cada solicitud que se le manda al agente (`AgentRequest`): la
 * llamada al modelo de IA, cuánto tardó, cuánto costó, cómo terminó y qué decidió.
 *
 * Es el rastro de lo que hace el asistente: sirve para calidad, para costos (los
 * tokens) y para poder reconstruir por qué contestó lo que contestó.
 *
 * **No guarda texto**: ni el prompt (lleva el historial y las notas del paciente), ni el
 * mensaje del paciente, ni la respuesta, ni nombres. Eso ya está en
 * `ConversationMessage`; duplicarlo en otra tabla multiplicaría los datos sensibles.
 * Guarda metadatos y la DECISIÓN estructurada del modelo, que es lo que se audita.
 *
 * **Registrar es obligatorio**: `interpretPatientMessage()` exige un `trace`, así que no
 * hay forma de llamar al modelo sin dejar el rastro.
 */

export type AgentRequestKind = "interpretacion" | "reinterpretacion" | "explicacion_fallo";
export type AgentRequestOutcome = "ok" | "sin_texto" | "no_interpretable" | "error";

/** Contexto que `agent-turn.ts` le pasa a cada llamada para que quede registrada. */
export interface AgentTrace {
  /** Agrupa las llamadas de UN mismo mensaje entrante. */
  turnId: string;
  kind: AgentRequestKind;
  /** 1 la primera vez; 2 si es el reintento tras una falla. */
  attempt: number;
  /** El titular de la conversación. */
  patientId: string | null;
}

/** Cuántos días se conservan (la limpieza periódica los borra). Más que los eventos de monitoreo. */
export const AGENT_REQUEST_RETENTION_DAYS = 90;

/**
 * La decisión del modelo, sin nombres ni textos. Qué hizo (intención, servicio, fecha,
 * hora, profesional pedido), qué marcó (escalar, confirmar, ubicación, queja) y a qué
 * cita se refirió. NO incluye `nombre_paciente`, `paciente_del_turno`,
 * `respuesta_al_paciente` ni el motivo de cancelación en texto.
 */
export function decisionOf(r: ClaudeAgentResponse): Prisma.InputJsonValue {
  return {
    intent: r.intent,
    servicio: r.servicio,
    fecha_solicitada: r.fecha_solicitada,
    hora_solicitada: r.hora_solicitada,
    profesional_solicitado: r.profesional_solicitado,
    turno_a_modificar: r.turno_a_modificar,
    turno_cancelado: r.turno_cancelado ?? null,
    requiere_horarios_disponibles: r.requiere_horarios_disponibles,
    confirmacion_explicita: r.confirmacion_explicita,
    pidio_ubicacion: r.pidio_ubicacion,
    escalar_a_humano: r.escalar_a_humano,
    motivo_escalar: r.motivo_escalar,
    motivo_es_queja: r.motivo_es_queja ?? false,
    dio_motivo_de_cancelacion: Boolean(r.motivo_cancelacion),
  };
}

export interface AgentRequestEntry {
  clinicId: string;
  trace: AgentTrace;
  model: string;
  latencyMs: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  stopReason?: string | null;
  promptChars?: number | null;
  outcome: AgentRequestOutcome;
  error?: unknown;
  response?: ClaudeAgentResponse | null;
}

/**
 * Registra una solicitud. **Nunca lanza**: se llama después de hablar con el modelo, y que
 * falle el registro no puede tumbar la respuesta al paciente. Pero queda en el log.
 */
export async function recordAgentRequest(e: AgentRequestEntry): Promise<void> {
  try {
    // El costo se congela acá con la tarifa vigente (`CostRate`); sin tarifa queda null, nunca 0. Una llamada que
    // falló no consumió tokens y su costo es null. Si no se puede leer la tarifa, el registro igual se guarda.
    let costUsd: number | null = null;
    try {
      const entrada = e.inputTokens ?? null;
      const salida = e.outputTokens ?? null;
      if (entrada !== null || salida !== null) {
        costUsd = modelCostUsd(await loadRates(), e.model, e, new Date());
      }
    } catch (error) {
      console.error("No se pudo calcular el costo de la solicitud al agente:", error);
    }
    await prisma.agentRequest.create({
      data: {
        clinicId: e.clinicId,
        patientId: e.trace.patientId,
        turnId: e.trace.turnId,
        kind: e.trace.kind,
        attempt: e.trace.attempt,
        model: e.model,
        latencyMs: Math.max(0, Math.round(e.latencyMs)),
        inputTokens: e.inputTokens ?? null,
        outputTokens: e.outputTokens ?? null,
        cacheReadTokens: e.cacheReadTokens ?? null,
        cacheCreationTokens: e.cacheCreationTokens ?? null,
        stopReason: e.stopReason ?? null,
        promptChars: e.promptChars ?? null,
        outcome: e.outcome,
        errorMessage: e.error === undefined ? null : describeError(e.error),
        intent: e.response?.intent ?? null,
        decision: e.response ? decisionOf(e.response) : undefined,
        costUsd,
      },
    });
  } catch (error) {
    console.error("No se pudo registrar la solicitud al agente:", error);
  }
}

/** Borra las solicitudes que pasaron la retención. Devuelve cuántas. */
export async function pruneAgentRequests(now = new Date()): Promise<number> {
  const corte = new Date(now.getTime() - AGENT_REQUEST_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.agentRequest.deleteMany({ where: { occurredAt: { lt: corte } } });
  return count;
}

// --- Consulta (Monitoreo) ---

export interface AgentRequestStats {
  llamadas: number;
  errores: number;
  sinInterpretar: number;
  latenciaMediaMs: number | null;
  latenciaMaximaMs: number | null;
  tokensEntrada: number;
  tokensSalida: number;
  /** Mensajes entrantes distintos (los `turnId`) en el período. */
  mensajes: number;
}

export async function agentRequestStats(since: Date): Promise<AgentRequestStats> {
  const where = { occurredAt: { gte: since } };
  const [total, porResultado, agregados, turnos] = await Promise.all([
    prisma.agentRequest.count({ where }),
    prisma.agentRequest.groupBy({ by: ["outcome"], where, _count: { _all: true } }),
    prisma.agentRequest.aggregate({
      where,
      _avg: { latencyMs: true },
      _max: { latencyMs: true },
      _sum: { inputTokens: true, outputTokens: true },
    }),
    prisma.agentRequest.groupBy({ by: ["turnId"], where }),
  ]);
  const cuenta = (o: string) => porResultado.find((r) => r.outcome === o)?._count._all ?? 0;
  return {
    llamadas: total,
    errores: cuenta("error"),
    sinInterpretar: cuenta("sin_texto") + cuenta("no_interpretable"),
    latenciaMediaMs: agregados._avg.latencyMs === null ? null : Math.round(agregados._avg.latencyMs),
    latenciaMaximaMs: agregados._max.latencyMs,
    tokensEntrada: agregados._sum.inputTokens ?? 0,
    tokensSalida: agregados._sum.outputTokens ?? 0,
    mensajes: turnos.length,
  };
}

export async function listAgentRequests(filters: {
  clinicId?: string;
  outcome?: string;
  turnId?: string;
  before?: Date;
  limit?: number;
}) {
  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 200);
  const rows = await prisma.agentRequest.findMany({
    where: {
      ...(filters.clinicId ? { clinicId: filters.clinicId } : {}),
      ...(filters.outcome ? { outcome: filters.outcome } : {}),
      ...(filters.turnId ? { turnId: filters.turnId } : {}),
      ...(filters.before ? { occurredAt: { lt: filters.before } } : {}),
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hayMas = rows.length > limit;
  const pagina = rows.slice(0, limit);
  return {
    solicitudes: pagina.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt.toISOString(),
      clinicId: r.clinicId,
      turnId: r.turnId,
      kind: r.kind,
      attempt: r.attempt,
      model: r.model,
      latencyMs: r.latencyMs,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      stopReason: r.stopReason,
      promptChars: r.promptChars,
      outcome: r.outcome,
      errorMessage: r.errorMessage,
      intent: r.intent,
      decision: r.decision,
    })),
    siguiente: hayMas ? pagina[pagina.length - 1].occurredAt.toISOString() : null,
  };
}
