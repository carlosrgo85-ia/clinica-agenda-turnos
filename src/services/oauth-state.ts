import type { CalendarProviderKind } from "@prisma/client";
import { signState, verifyState } from "./crypto";

/**
 * El `state` del OAuth de cualquier proveedor de calendario.
 *
 * Va firmado con HMAC y vence a los 10 minutos (ver `crypto.ts`), y lleva:
 *
 * - la clínica, para que nadie pueda mandar un callback con el id de otra;
 * - QUIÉN inició el flujo: el callback exige que sea la misma sesión, así un
 *   link de consentimiento armado por otro usuario no se puede completar
 *   desde otra cuenta (login CSRF);
 * - el PROVEEDOR: un `state` emitido para Google no vale en el callback de
 *   Microsoft ni al revés. Los dos comparten la misma clave de firma, así que
 *   sin esto un state servía para cualquiera de los dos.
 */
export interface OAuthState {
  clinicId: string;
  userId: string;
}

export function buildOAuthState(
  provider: CalendarProviderKind,
  clinicId: string,
  userId: string
): string {
  return signState({ provider, clinicId, userId });
}

/** Quién y para qué clínica se inició el flujo, o null si el state no sirve para ESE proveedor. */
export function readOAuthState(state: string, provider: CalendarProviderKind): OAuthState | null {
  const payload = verifyState(state);
  if (!payload) return null;
  const { clinicId, userId } = payload;
  if (payload.provider !== provider) return null;
  if (typeof clinicId !== "string" || typeof userId !== "string") return null;
  return { clinicId, userId };
}
