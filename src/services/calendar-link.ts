import type { CalendarProviderId } from "./calendar-providers/types";

/**
 * Qué credencial acompaña a un calendario cuando una clínica lo enlaza (al
 * calendario compartido o al de un profesional). Es la regla que evita dejar
 * un calendario de Microsoft con la cuenta de Google de otro, o con ninguna.
 *
 * Es pura a propósito: la usan los dos endpoints de enlace del dashboard y es
 * la parte que se rompe en silencio (un espejo que no se crea) si queda mal.
 */
export type CredentialChoice =
  | {
      ok: true;
      /** undefined = el pedido no tocó el proveedor: se deja como está. */
      provider: CalendarProviderId | undefined;
      /** undefined = no tocar; null = soltar la credencial. */
      googleAccountId: string | null | undefined;
      microsoftAccountId: string | null | undefined;
    }
  | { ok: false; error: string };

const isIdOrNull = (v: unknown): v is string | null | undefined =>
  v === undefined || v === null || typeof v === "string";

export function chooseCalendarCredential(
  input: { provider?: unknown; googleAccountId?: unknown; microsoftAccountId?: unknown },
  options: { calendarBeingSet: boolean }
): CredentialChoice {
  const { provider: rawProvider, googleAccountId, microsoftAccountId } = input;

  if (rawProvider !== undefined && rawProvider !== "google" && rawProvider !== "microsoft") {
    return { ok: false, error: 'provider tiene que ser "google" o "microsoft".' };
  }
  if (!isIdOrNull(googleAccountId)) {
    return { ok: false, error: "googleAccountId tiene que ser un string o null." };
  }
  if (!isIdOrNull(microsoftAccountId)) {
    return { ok: false, error: "microsoftAccountId tiene que ser un string o null." };
  }
  if (googleAccountId && microsoftAccountId) {
    return { ok: false, error: "Un calendario usa una sola cuenta: Google o Microsoft, no las dos." };
  }

  // Si no dicen el proveedor, se deduce de la cuenta que mandaron.
  const provider: CalendarProviderId | undefined =
    rawProvider ??
    (microsoftAccountId ? "microsoft" : googleAccountId !== undefined ? "google" : undefined);

  if (provider === "google" && microsoftAccountId) {
    return { ok: false, error: "Un calendario de Google no puede usar una cuenta de Microsoft." };
  }
  if (provider === "microsoft" && googleAccountId) {
    return { ok: false, error: "Un calendario de Microsoft no puede usar una cuenta de Google." };
  }
  if (provider === "microsoft" && options.calendarBeingSet && !microsoftAccountId) {
    // A diferencia de Google, no hay cuenta de servicio de respaldo.
    return { ok: false, error: "Un calendario de Microsoft necesita una cuenta conectada." };
  }

  return {
    ok: true,
    provider,
    // Al cambiar de proveedor se suelta la credencial del otro, para no
    // dejar una cuenta apuntando a un calendario que ya no es suyo.
    googleAccountId: provider === "microsoft" ? null : googleAccountId,
    microsoftAccountId: provider === "google" ? null : microsoftAccountId,
  };
}
