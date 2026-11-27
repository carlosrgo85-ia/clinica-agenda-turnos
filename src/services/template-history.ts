import { appendConversationMessage } from "../repositories/clinics.repository";
import { renderTemplateBody } from "./whatsapp-templates";

/**
 * Deja en el historial de la conversación lo que se le mandó al paciente por una plantilla (recordatorio, aviso de
 * cancelación, seguimiento…). Sin esto el asistente no sabe a qué está contestando cuando el paciente responde: pasó el
 * 2026-11-26, la clínica canceló una cita desde la Agenda, le llegó el aviso, y al preguntar «¿por qué la cancelaron?» el
 * asistente contestó que no había ninguna cancelación.
 *
 * **Nunca lanza**: se llama después de un envío que ya salió. Una plantilla que no está en el catálogo (el nombre puede ser
 * propio de la clínica) no se puede reconstruir y se omite.
 */
export async function rememberTemplateSent(params: {
  clinicId: string;
  patientPhone: string;
  templateName: string;
  parameters: string[];
}): Promise<void> {
  try {
    const texto = renderTemplateBody(params.templateName, params.parameters);
    if (!texto) return;
    await appendConversationMessage({
      clinicId: params.clinicId,
      patientPhone: params.patientPhone,
      role: "assistant",
      content: texto,
    });
  } catch (error) {
    console.error("No se pudo guardar el mensaje de plantilla en el historial:", error);
  }
}
