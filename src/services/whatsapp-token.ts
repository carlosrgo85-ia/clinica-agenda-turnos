/**
 * El token de WhatsApp (de Meta) es una credencial: no tiene que quedar escrita en un mensaje de error,
 * en un log ni en un evento de Monitoreo. Meta, cuando rechaza un token mal formado, lo devuelve entero
 * dentro del mensaje ("Malformed access token EAA…"), y ese texto terminaba en pantalla.
 */

/** Los tokens de Meta empiezan con "EA" y son alfanuméricos y largos. */
const TOKEN_EN_TEXTO = /\bEA[A-Za-z0-9]{30,}/g;

export function redactTokens(text: string): string {
  return text.replace(TOKEN_EN_TEXTO, "[token oculto]");
}

/**
 * null = el token tiene forma de token. Se rechaza lo que trae espacios o saltos de línea: casi siempre
 * es que se copió algo de más (por ejemplo el rótulo "Identificador de…" que está pegado en la pantalla de
 * Meta), y un token así Meta lo rechaza con "Malformed access token" recién al primer envío.
 */
export function whatsAppTokenError(token: string): string | null {
  const t = token.trim();
  if (/\s/.test(t)) {
    return "El token de WhatsApp no puede tener espacios ni saltos de línea: se copió algo de más junto al token. Pega solo el token.";
  }
  if (t.length < 20 || t.length > 1000) {
    return "El token de WhatsApp no parece válido (largo inesperado). Cópialo de nuevo desde Meta.";
  }
  return null;
}
