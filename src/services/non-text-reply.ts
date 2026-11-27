import { appendConversationMessage } from "../repositories/clinics.repository";
import { prisma } from "../db/client";
import { clinicWhatsAppCreds, sendTextMessage } from "./whatsapp";
import { SANDBOX_PHONE_PREFIX } from "./sandbox-phone";

/**
 * Qué se le contesta a quien manda algo que el asistente no sabe leer (una nota de voz, una imagen, un archivo).
 *
 * Antes el webhook descartaba esos mensajes sin contestar y el paciente quedaba en visto (2026-11-27). Esta respuesta es
 * fija y no pasa por el modelo: **no procesa el contenido** (no se descarga el audio ni se envía a ningún tercero), solo avisa
 * y pide que lo escriban. Va de usted, como el resto de lo que sale sin pasar por el modelo.
 *
 * El día que se transcriban las notas de voz (pendiente: elegir el proveedor de voz a texto y actualizar `docs/legal/`), el
 * audio dejará de caer acá.
 */
export const RESPUESTA_A_AUDIO =
  "Por ahora no puedo escuchar notas de voz. ¿Me lo podría escribir, por favor? Con gusto le ayudo.";
export const RESPUESTA_A_ARCHIVO =
  "Por ahora solo puedo leer mensajes de texto, no imágenes ni archivos. ¿Me lo podría escribir, por favor?";

/**
 * El texto para ese tipo de mensaje de WhatsApp, o null si no se contesta. **No se contestan** los tipos que no piden nada:
 * reacciones (un emoji sobre un mensaje), stickers, cambios de sistema y los mensajes que Meta marca como no soportados.
 */
export function replyForNonTextType(type: string | undefined): string | null {
  switch (type) {
    case "audio":
      return RESPUESTA_A_AUDIO;
    case "image":
    case "video":
    case "document":
      return RESPUESTA_A_ARCHIVO;
    default:
      return null;
  }
}

/** No se repite el mismo aviso si el paciente manda varios audios seguidos. */
export const REPLY_COOLDOWN_MS = 10 * 60 * 1000;

export interface NonTextReplyDeps {
  send: (text: string) => Promise<void>;
  now?: Date;
}

/**
 * Contesta un mensaje que no es texto. Devuelve si se mandó algo. **Nunca lanza**: es una cortesía, y se llama desde el webhook,
 * después de responderle a Meta. Queda en el historial como mensaje del asistente (se ve en Conversaciones) y no se repite
 * dentro de `REPLY_COOLDOWN_MS`. No registra el contenido ni el tipo de archivo, y los teléfonos de prueba se ignoran.
 */
export async function replyToNonTextMessage(
  params: { clinicId: string; from: string; type: string | undefined },
  deps: NonTextReplyDeps
): Promise<boolean> {
  try {
    const texto = replyForNonTextType(params.type);
    if (!texto) return false;
    if (params.from.startsWith(SANDBOX_PHONE_PREFIX)) return false;

    const desde = new Date((deps.now ?? new Date()).getTime() - REPLY_COOLDOWN_MS);
    const reciente = await prisma.conversationMessage.findFirst({
      where: { clinicId: params.clinicId, patientPhone: params.from, role: "assistant", content: texto, createdAt: { gte: desde } },
      select: { id: true },
    });
    if (reciente) return false;

    await appendConversationMessage({ clinicId: params.clinicId, patientPhone: params.from, role: "assistant", content: texto });
    await deps.send(texto);
    return true;
  } catch (error) {
    console.error(`No se pudo contestar un mensaje que no es texto (clínica ${params.clinicId}):`, error);
    return false;
  }
}

/** El envío real, con las credenciales de la clínica. */
export function sendFor(clinic: Parameters<typeof clinicWhatsAppCreds>[0], to: string): (text: string) => Promise<void> {
  return (text) => sendTextMessage(clinicWhatsAppCreds(clinic), to, text);
}
