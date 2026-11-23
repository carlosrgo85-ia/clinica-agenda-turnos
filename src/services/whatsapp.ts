import { decryptToken } from "./crypto";
import { recordWhatsAppSend } from "./costs";

/**
 * Todas las funciones reciben el token y el phoneNumberId de la clínica
 * puntual que está enviando el mensaje — nunca se leen de env global,
 * porque cada clínica tiene su propio número de WhatsApp.
 */

export const GRAPH_API_BASE = "https://graph.facebook.com/v20.0";

export interface ClinicWhatsAppCreds {
  token: string;
  phoneNumberId: string;
  /**
   * De qué clínica es el envío, para medir su consumo (`UsageEvent`). Va en las credenciales a propósito: toda
   * función de envío las recibe, así que ningún mensaje sale sin dejar su rastro de costo y no hay que tocar
   * a cada llamador.
   */
  clinicId: string;
  /** El país de la clínica (ISO alpha-2): Meta cobra distinto por país. */
  country: string | null;
}

/**
 * Credenciales de envío de una clínica, con el token ya descifrado.
 *
 * Es el ÚNICO lugar donde se descifra `Clinic.whatsappTokenEncrypted`: si
 * cada llamador lo hiciera por su cuenta, tarde o temprano alguno loguea el
 * token o lo mete en una respuesta de la API.
 */
export function clinicWhatsAppCreds(clinic: {
  id: string;
  country: string | null;
  whatsappTokenEncrypted: string;
  whatsappPhoneNumberId: string;
}): ClinicWhatsAppCreds {
  return {
    token: decryptToken(clinic.whatsappTokenEncrypted),
    phoneNumberId: clinic.whatsappPhoneNumberId,
    clinicId: clinic.id,
    country: clinic.country,
  };
}

/**
 * WhatsApp identifica a los móviles mexicanos como "521" + 10 dígitos (el 1
 * es un resabio histórico), y ese es el `wa_id` que llega en el webhook y el
 * que queda guardado en `Patient.phone`. Pero la Graph API **rechaza** ese
 * mismo string como destinatario con el error 131030; hay que mandarle el
 * número sin el 1, y ella lo resuelve al `wa_id` con 1.
 *
 * Ojo: el 9 de los móviles argentinos (`549`) NO es lo mismo — ese sí hace
 * falta al enviar, así que no se toca.
 */
function normalizeRecipient(to: string): string {
  return /^521\d{10}$/.test(to) ? `52${to.slice(3)}` : to;
}

async function postMessage(
  creds: ClinicWhatsAppCreds,
  payload: Record<string, unknown>
): Promise<void> {
  const response = await fetch(`${GRAPH_API_BASE}/${creds.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  // La Graph API contesta 200 con un error adentro muy pocas veces, pero un
  // token vencido, un destinatario no autorizado o la ventana de 24hs cerrada
  // vienen como 4xx. Sin esto el envío falla en silencio y la clínica cree
  // que el mensaje salió.
  if (!response.ok) {
    throw new Error(
      `WhatsApp devolvió ${response.status} al enviar a ${payload.to}: ${await response.text()}`
    );
  }
}

/** Envía un mensaje de texto libre (solo válido dentro de la ventana de 24hs). */
export async function sendTextMessage(
  creds: ClinicWhatsAppCreds,
  to: string,
  body: string
): Promise<void> {
  await postMessage(creds, {
    messaging_product: "whatsapp",
    to: normalizeRecipient(to),
    type: "text",
    text: { body },
  });
  // Solo si salió: un envío que Meta rechazó no se cobra. Nunca lanza.
  await recordWhatsAppSend({ clinicId: creds.clinicId, country: creds.country, to, kind: "texto" });
}

/**
 * Envía un mensaje de plantilla aprobada por Meta (necesario para mensajes
 * iniciados por la clínica, como el recordatorio de turno). El nombre de la
 * plantilla puede variar por clínica (Clinic.reminderTemplateName).
 */
export async function sendTemplateMessage(
  creds: ClinicWhatsAppCreds,
  to: string,
  templateName: string,
  languageCode: string,
  parameters: string[]
): Promise<void> {
  await postMessage(creds, {
    messaging_product: "whatsapp",
    to: normalizeRecipient(to),
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      components: [
        {
          type: "body",
          parameters: parameters.map((text) => ({ type: "text", text })),
        },
      ],
    },
  });
  await recordWhatsAppSend({ clinicId: creds.clinicId, country: creds.country, to, kind: "plantilla", templateName });
}
