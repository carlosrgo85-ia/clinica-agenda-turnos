import type { EscalationReason } from "@prisma/client";
import { prisma } from "../db/client";

/**
 * Escalamientos: los casos que el asistente derivó a una persona.
 *
 * Se persisten siempre, ANTES de intentar notificar. El bot ya le prometió al
 * paciente que alguien lo va a contactar, así que un aviso que falla no puede
 * ser la única huella del caso.
 */

/** `ClaudeAgentResponse.motivo_escalar` puede venir null; el enum no. */
export function toEscalationReason(motivo: string | null | undefined): EscalationReason {
  return motivo === "urgencia" || motivo === "consulta_clinica" ? motivo : "otro";
}

export function createEscalation(params: {
  clinicId: string;
  patientId: string | null;
  patientPhone: string;
  patientName: string | null;
  reason: EscalationReason;
  patientMessage: string;
  summary: string;
}) {
  return prisma.escalation.create({ data: params });
}

export function markEscalationNotified(id: string) {
  return prisma.escalation.update({ where: { id }, data: { notifiedByEmail: true } });
}

/**
 * Los escalamientos de una clínica, sin resolver primero: es una cola de
 * trabajo, no un historial.
 */
export function listEscalations(params: {
  clinicId: string;
  incluirResueltos?: boolean;
}) {
  return prisma.escalation.findMany({
    where: {
      clinicId: params.clinicId,
      ...(params.incluirResueltos ? {} : { resolvedAt: null }),
    },
    orderBy: [{ resolvedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
    take: 200,
  });
}

export async function countPendingEscalations(clinicId: string): Promise<number> {
  return prisma.escalation.count({ where: { clinicId, resolvedAt: null } });
}

/**
 * Marcar atendido es idempotente a propósito: dos personas de la clínica
 * pueden tocar el botón a la vez y ninguna tiene que ver un error.
 */
export async function resolveEscalation(
  id: string,
  clinicId: string,
  resolvedBy: string
): Promise<boolean> {
  const { count } = await prisma.escalation.updateMany({
    where: { id, clinicId },
    data: { resolvedAt: new Date(), resolvedBy },
  });
  return count > 0;
}

export async function reopenEscalation(id: string, clinicId: string): Promise<boolean> {
  const { count } = await prisma.escalation.updateMany({
    where: { id, clinicId },
    data: { resolvedAt: null, resolvedBy: null },
  });
  return count > 0;
}

export type { EscalationReason };
