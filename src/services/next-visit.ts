import { prisma } from "../db/client";
import { SANDBOX_PATIENT_FILTER } from "./sandbox-phone";
import { addDaysToDateKey, clinicDateKey } from "./time";
import { parseDateKey } from "./patient-admin";

/**
 * A quién hay que contactar por su próxima cita sugerida.
 *
 * `Patient.suggestedNextVisitDate` es una SUGERENCIA del personal (un control en
 * 6 meses), no una cita. Este proceso busca a quienes ya les toca y todavía no
 * tienen un turno, para que el asistente les escriba primero.
 */

/** Cuántos mensajes como máximo por clínica en cada corrida: nunca una ráfaga. */
export const MAX_OUTREACH_PER_RUN = 20;

export interface DuePatient {
  id: string;
  phone: string;
  name: string | null;
  firstName: string | null;
  suggestedNextVisitDate: Date;
  suggestedNextVisitNote: string | null;
}

/**
 * Los pacientes a los que hoy corresponde escribirles.
 *
 * - Su fecha sugerida es de hoy, anterior, o cae dentro de `leadDays` días: se les
 *   avisa ANTES, para que puedan elegir un horario cómodo.
 * - **No tienen ya un turno confirmado a futuro**: si ya sacaron la cita, avisarles
 *   es molestar.
 * - **No pidieron que no los contactemos** (`outreachOptOut`).
 * - **No se les escribió ya por esta sugerencia** (`nextVisitOutreachSentAt`): un
 *   solo mensaje por sugerencia, que se rearma al cambiar la fecha.
 *
 * "Hoy" es el día de la clínica, no el del servidor.
 */
export async function findPatientsDueForOutreach(params: {
  clinicId: string;
  timezone: string;
  leadDays: number;
  now?: Date;
  limit?: number;
}): Promise<DuePatient[]> {
  const now = params.now ?? new Date();
  const hoy = clinicDateKey(now, params.timezone);
  const limite = addDaysToDateKey(hoy, params.leadDays);
  const limiteDate = limite ? parseDateKey(limite) : null;
  if (!limiteDate) return [];

  const rows = await prisma.patient.findMany({
    where: {
      clinicId: params.clinicId,
      outreachOptOut: false,
      // Chat de pruebas: a un paciente de prueba no se le escribe.
      NOT: SANDBOX_PATIENT_FILTER,
      nextVisitOutreachSentAt: null,
      suggestedNextVisitDate: { not: null, lte: limiteDate },
      // Sin ninguna cita confirmada de aquí en adelante.
      appointments: { none: { status: "confirmado", startTime: { gte: now } } },
    },
    orderBy: [{ suggestedNextVisitDate: "asc" }, { createdAt: "asc" }],
    take: params.limit ?? MAX_OUTREACH_PER_RUN,
    select: {
      id: true,
      phone: true,
      name: true,
      firstName: true,
      suggestedNextVisitDate: true,
      suggestedNextVisitNote: true,
    },
  });
  return rows as DuePatient[];
}

/**
 * Un parámetro de plantilla de Meta no puede tener saltos de línea, tabuladores ni
 * más de tres espacios seguidos, y los largos desmedidos la rechazan. El texto del
 * personal ("control de ortodoncia") pasa por acá antes de mandarse.
 */
export function sanitizeTemplateParam(value: string, fallback: string, max = 60): string {
  const limpio = value.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  return (limpio || fallback).slice(0, max).trim();
}
