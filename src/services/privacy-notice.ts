import type { Clinic } from "@prisma/client";

/**
 * Los dos avisos que el asistente manda por su cuenta, en código y no en el prompt (un link que el modelo reescribe puede
 * salir mal, y esto es información que no puede depender de que el modelo la mencione). Los dos van DENTRO de la respuesta (el primero al comienzo, el segundo al final: no son mensajes aparte),
 * **una sola vez por persona**, y son mensajes de respuesta (la persona escribió primero): entran en la ventana de 24 h y no
 * necesitan plantilla de Meta. Van de usted.
 *
 * 1. **Quién atiende** (`buildAssistantIntroMessage`): al comienzo de la primera respuesta (en el mismo mensaje), una línea corta: lo atiende un asistente
 *    virtual. Es un requisito de la política de uso de Anthropic para los chatbots que hablan con clientes ("debe avisarse al
 *    menos al comienzo de cada sesión de chat"), y no hacerlo pone en riesgo la cuenta del modelo de TODAS las clínicas. Por eso
 *    está en código y no se puede apagar por clínica. Se mantiene breve y sin tono legal para no asustar a nadie.
 *
 * 2. **Aviso de privacidad** (`buildPrivacyNoticeMessage`): el link al aviso de la clínica (que es la responsable de los datos de
 *    sus pacientes), al final de la respuesta al SEGUNDO mensaje de la persona y no al primero (decidido el 2026-11-20, para no abrumar de entrada):
 *    "Mientras tanto, le dejamos el aviso de privacidad de {clínica}: {link}". Sin link cargado no se manda nada (no hay qué
 *    mostrar) y la marca no se pone, así que cuando se cargue lo recibe quien todavía no lo tenía.
 *
 * Ninguno afirma que la persona "acepta" algo: informan y enlazan. Si alcanza para el consentimiento de datos de salud lo decide
 * la ley y un abogado. Ver "Reglas transversales" (legislación mexicana) y `docs/legal/`.
 */
export function buildAssistantIntroMessage(clinic: Pick<Clinic, "name">): string {
  return `Le atiende el asistente virtual de ${clinic.name}.`;
}

/** `null` si la clínica no cargó el link: sin aviso que mostrar no se manda nada. */
export function buildPrivacyNoticeMessage(clinic: Pick<Clinic, "name" | "privacyNoticeUrl">): string | null {
  const url = clinic.privacyNoticeUrl?.trim();
  if (!url) return null;
  return `Mientras tanto, le dejamos el aviso de privacidad de ${clinic.name}: ${url}`;
}

export const PRIVACY_NOTICE_URL_MAX_LENGTH = 500;

/** Un link https a una página pública. Sin espacios ni saltos de línea: va dentro de un mensaje de WhatsApp. */
export function isValidPrivacyNoticeUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!v || v.length > PRIVACY_NOTICE_URL_MAX_LENGTH || /\s/.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname.includes(".");
  } catch {
    return false;
  }
}
