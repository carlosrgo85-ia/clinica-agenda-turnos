import type { Clinic, Patient } from "@prisma/client";
import type { ClaudeAgentResponse } from "../types";

/**
 * Arma el resumen que recibe el equipo de la clínica cuando el agente
 * escala una conversación. No hace una llamada nueva a Claude — se arma
 * con los datos que ya extrajo la interpretación del mensaje, para no
 * sumar costo ni latencia en un momento sensible (una urgencia).
 */
export function buildEscalationSummary(params: {
  clinic: Clinic;
  patient: Patient;
  patientPhone: string;
  agentResponse: ClaudeAgentResponse;
  lastPatientMessage: string;
}): string {
  const { agentResponse, patient, clinic } = params;

  const motivoLabel: Record<string, string> = {
    urgencia: "Urgencia",
    consulta_clinica: "Consulta clínica",
    otro: "Otro / no clasificado",
  };

  return `
Escalamiento — ${clinic.name}
Motivo: ${motivoLabel[agentResponse.motivo_escalar ?? "otro"] ?? "Otro"}

Paciente: ${patient.name ?? agentResponse.nombre_paciente ?? "sin nombre registrado"}
Teléfono: ${params.patientPhone}
Servicio mencionado: ${agentResponse.servicio ?? "no especificado"}

Último mensaje del paciente:
"${params.lastPatientMessage}"

Responder directamente al paciente por WhatsApp.
`.trim();
}
