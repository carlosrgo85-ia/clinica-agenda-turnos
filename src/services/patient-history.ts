import { prisma } from "../db/client";
import {
  MAX_COMMENTS,
  MAX_TREATMENTS,
  type PatientHistoryForPrompt,
} from "../prompts/patient-history-context";
import { patientNameParts } from "./patient-admin";
import { clinicDateKey } from "./time";

/**
 * Arma el historial de las personas de un WhatsApp para el prompt del asistente.
 *
 * Acotado por `clinicId` y por los ids de las personas de ESE número: el modelo
 * nunca ve a otro paciente, y un id ajeno no devuelve nada.
 *
 * "Lo que se le hizo" son las citas cumplidas: las que una persona confirmó
 * (`attendedAt`) o que quedaron en `atendido`. Las canceladas y las que todavía
 * no pasaron no cuentan: no se le hizo nada.
 */
export async function loadPatientHistories(params: {
  clinicId: string;
  patientIds: string[];
  timezone: string;
}): Promise<PatientHistoryForPrompt[]> {
  if (params.patientIds.length === 0) return [];

  const pacientes = await prisma.patient.findMany({
    where: { clinicId: params.clinicId, id: { in: params.patientIds } },
    orderBy: { createdAt: "asc" },
    include: {
      appointments: {
        where: { OR: [{ status: "atendido" }, { attendedAt: { not: null } }] },
        orderBy: { startTime: "desc" },
        take: MAX_TREATMENTS,
        select: { startTime: true, service: true, professional: { select: { name: true } } },
      },
      comments: { orderBy: { createdAt: "desc" }, take: MAX_COMMENTS },
    },
  });

  return pacientes.map((p) => ({
    nombre: p.name ?? "",
    nombreDePila: patientNameParts(p).firstName,
    tratamientos: p.appointments.map((a) => ({
      fecha: clinicDateKey(a.startTime, params.timezone),
      servicio: a.service,
      profesional: a.professional.name,
    })),
    proximaCitaSugerida: p.suggestedNextVisitDate
      ? {
          fecha: p.suggestedNextVisitDate.toISOString().slice(0, 10),
          nota: p.suggestedNextVisitNote,
        }
      : null,
    observaciones: p.observations,
    comentarios: p.comments.map((c) => ({
      fecha: clinicDateKey(c.createdAt, params.timezone),
      texto: c.text,
    })),
  }));
}
