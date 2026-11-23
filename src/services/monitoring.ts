import { prisma } from "../db/client";
import { MONITORED_JOBS, WORKER_PULSE_JOB } from "../config/monitored-jobs";
import { ABANDONED_AFTER_MS } from "../jobs/inbound-sweeper";
import { agentRequestStats, type AgentRequestStats } from "./agent-requests";
import { SYSTEM_EVENT_LABELS, type SystemEventKind } from "./system-events";

/**
 * Lo que muestra la pantalla "Monitoreo" del super-admin.
 *
 * Todo sale de Postgres: no llama a Meta, a Google ni a Anthropic. Una
 * pantalla de monitoreo que se cuelga cuando una de esas APIs anda mal no
 * sirve justo cuando más hace falta. El estado de las plantillas de WhatsApp
 * por clínica, que sí requiere llamar a Meta, sigue en el detalle de cada
 * clínica.
 */

/** Cuánto margen sobre el hueco normal antes de dar una tarea por atrasada. */
const STALE_FACTOR = 1.5;
/** Y un mínimo fijo, para que el reloj de un job de un minuto no dispare falsas alarmas. */
const STALE_GRACE_MS = 2 * 60_000;

/**
 * ¿Lleva una tarea demasiado sin correr?
 *
 * Nunca corrió = atrasada, salvo que el worker recién arranque: lo decide
 * quien llama, que sabe si hay un latido más viejo que lo comparable.
 */
export function isJobStale(
  now: Date,
  lastRunAt: Date | null,
  maxGapMs: number
): boolean {
  if (!lastRunAt) return true;
  return now.getTime() - lastRunAt.getTime() > maxGapMs * STALE_FACTOR + STALE_GRACE_MS;
}

export type JobState = "ok" | "atrasado" | "con_error" | "nunca_corrio";

export function jobState(params: {
  now: Date;
  lastRunAt: Date | null;
  hasError: boolean;
  maxGapMs: number;
}): JobState {
  if (!params.lastRunAt) return "nunca_corrio";
  if (isJobStale(params.now, params.lastRunAt, params.maxGapMs)) return "atrasado";
  return params.hasError ? "con_error" : "ok";
}

export interface MonitoringSnapshot {
  generadoEn: string;
  worker: {
    /** La tarea que corre cada minuto está al día. */
    vivo: boolean;
    ultimaSeñal: string | null;
  };
  tareas: Array<{
    name: string;
    label: string;
    schedule: string;
    estado: JobState;
    ultimaCorrida: string | null;
    ultimoError: string | null;
    ultimoErrorEn: string | null;
  }>;
  cola: {
    /** Mensajes de pacientes esperando respuesta. */
    pendientes: number;
    /** Los que llevan más que lo que tarda el camino normal: nadie los levantó. */
    abandonados: number;
    masViejoEn: string | null;
  };
  derivacionesSinAvisar: {
    cantidad: number;
    masViejaEn: string | null;
  };
  eventos24h: Array<{ kind: string; label: string; cantidad: number }>;
  /** Las solicitudes al agente (llamadas al modelo) de las últimas 24 horas. */
  agente24h: AgentRequestStats;
  clinicas: Array<{
    id: string;
    name: string;
    ultimoMensajeDePacienteEn: string | null;
    eventos24h: number;
  }>;
}

export async function getMonitoringSnapshot(now = new Date()): Promise<MonitoringSnapshot> {
  const hace24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const corteAbandono = new Date(now.getTime() - ABANDONED_AFTER_MS);

  const [
    heartbeats,
    pendientes,
    abandonados,
    masViejo,
    derivaciones,
    derivacionMasVieja,
    eventosPorTipo,
    eventosPorClinica,
    clinicas,
    ultimosMensajes,
    agente24h,
  ] = await Promise.all([
    prisma.cronHeartbeat.findMany(),
    prisma.pendingInboundMessage.count(),
    prisma.pendingInboundMessage.count({ where: { receivedAt: { lte: corteAbandono } } }),
    prisma.pendingInboundMessage.findFirst({ orderBy: { receivedAt: "asc" }, select: { receivedAt: true } }),
    prisma.escalation.count({ where: { resolvedAt: null, notifiedByEmail: false } }),
    prisma.escalation.findFirst({
      where: { resolvedAt: null, notifiedByEmail: false },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.systemEvent.groupBy({
      by: ["kind"],
      where: { createdAt: { gte: hace24h } },
      _count: { _all: true },
    }),
    prisma.systemEvent.groupBy({
      by: ["clinicId"],
      where: { createdAt: { gte: hace24h }, clinicId: { not: null } },
      _count: { _all: true },
    }),
    prisma.clinic.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.conversationMessage.groupBy({
      by: ["clinicId"],
      where: { role: "patient" },
      _max: { createdAt: true },
    }),
    agentRequestStats(hace24h),
  ]);

  const porJob = new Map(heartbeats.map((h) => [h.jobName, h]));
  const tareas = MONITORED_JOBS.map((job) => {
    const beat = porJob.get(job.name);
    const lastRunAt = beat?.lastFinishedAt ?? beat?.lastStartedAt ?? null;
    return {
      name: job.name,
      label: job.label,
      schedule: job.schedule,
      estado: jobState({
        now,
        lastRunAt,
        hasError: Boolean(beat?.lastError),
        maxGapMs: job.maxGapMs,
      }),
      ultimaCorrida: lastRunAt?.toISOString() ?? null,
      ultimoError: beat?.lastError ?? null,
      ultimoErrorEn: beat?.lastErrorAt?.toISOString() ?? null,
    };
  });

  const pulso = tareas.find((t) => t.name === WORKER_PULSE_JOB);
  const eventosClinica = new Map(eventosPorClinica.map((e) => [e.clinicId, e._count._all]));
  const mensajeClinica = new Map(ultimosMensajes.map((m) => [m.clinicId, m._max.createdAt]));

  return {
    generadoEn: now.toISOString(),
    worker: {
      vivo: pulso?.estado === "ok" || pulso?.estado === "con_error",
      ultimaSeñal: pulso?.ultimaCorrida ?? null,
    },
    tareas,
    cola: {
      pendientes,
      abandonados,
      masViejoEn: masViejo?.receivedAt.toISOString() ?? null,
    },
    derivacionesSinAvisar: {
      cantidad: derivaciones,
      masViejaEn: derivacionMasVieja?.createdAt.toISOString() ?? null,
    },
    agente24h,
    eventos24h: eventosPorTipo.map((e) => ({
      kind: e.kind,
      label: SYSTEM_EVENT_LABELS[e.kind as SystemEventKind] ?? e.kind,
      cantidad: e._count._all,
    })),
    clinicas: clinicas.map((c) => ({
      id: c.id,
      name: c.name,
      ultimoMensajeDePacienteEn: mensajeClinica.get(c.id)?.toISOString() ?? null,
      eventos24h: eventosClinica.get(c.id) ?? 0,
    })),
  };
}

export interface EventFilters {
  clinicId?: string;
  kind?: string;
  /** Solo los anteriores a esta fecha: paginación por cursor. */
  before?: Date;
  limit?: number;
}

export async function listSystemEvents(filters: EventFilters) {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const rows = await prisma.systemEvent.findMany({
    where: {
      ...(filters.clinicId ? { clinicId: filters.clinicId } : {}),
      ...(filters.kind ? { kind: filters.kind } : {}),
      ...(filters.before ? { createdAt: { lt: filters.before } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
  });

  const hayMas = rows.length > limit;
  const pagina = rows.slice(0, limit);
  return {
    eventos: pagina.map((e) => ({
      id: e.id,
      createdAt: e.createdAt.toISOString(),
      kind: e.kind,
      label: SYSTEM_EVENT_LABELS[e.kind as SystemEventKind] ?? e.kind,
      severity: e.severity,
      clinicId: e.clinicId,
      message: e.message,
    })),
    siguiente: hayMas ? pagina[pagina.length - 1].createdAt.toISOString() : null,
  };
}
