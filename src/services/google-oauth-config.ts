import { env } from "../config/env";
import { getGoogleOAuthAppEncrypted } from "../repositories/platform-oauth-apps.repository";
import { decryptToken } from "./crypto";

/**
 * El cliente de OAuth de Google de la plataforma, de donde esté.
 *
 * Es el ÚNICO lugar que descifra el secreto guardado en la base — mismo
 * criterio que `getPlatformSecretValue()` y `clinicWhatsAppCreds()`.
 *
 * Orden: lo guardado en la base manda, ENTERO, sobre las variables
 * `GOOGLE_OAUTH_*` del `.env`. Eso permite cargarlo o rotarlo desde la
 * pantalla sin reiniciar ningún proceso; el `.env` queda de respaldo para las
 * instalaciones que no lo cargaron. No se mezclan campos de las dos fuentes:
 * un id de una app con el secreto de otra falla con un "invalid_client" que no
 * explica nada.
 */

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  source: "base" | "env";
}

/** Cuánto se recuerda antes de volver a mirar la base. Guardar invalida el de este proceso; el otro se entera a lo sumo después de esto. */
export const GOOGLE_OAUTH_CACHE_TTL_MS = 60_000;

let cache: { at: number; config: GoogleOAuthConfig | null } | null = null;

export function invalidateGoogleOAuthConfigCache(): void {
  cache = null;
}

export async function getGoogleOAuthConfig(now = Date.now()): Promise<GoogleOAuthConfig | null> {
  if (cache && now - cache.at < GOOGLE_OAUTH_CACHE_TTL_MS) return cache.config;
  const config = await resolve();
  cache = { at: now, config };
  return config;
}

async function resolve(): Promise<GoogleOAuthConfig | null> {
  const stored = await getGoogleOAuthAppEncrypted();
  if (stored) {
    try {
      return {
        clientId: stored.clientId,
        redirectUri: stored.redirectUri,
        clientSecret: decryptToken(stored.clientSecretEncrypted),
        source: "base",
      };
    } catch (error) {
      // Se cambió la clave de cifrado: el secreto guardado ya no se puede
      // leer. Se cae al `.env` en vez de dejar la integración rota, pero se
      // loguea fuerte: alguien tiene que volver a cargarlo.
      console.error(
        "No se pudo descifrar el secreto de Google guardado (¿cambió CALENDAR_TOKEN_ENCRYPTION_KEY?). Se usan las variables GOOGLE_OAUTH_* del .env:",
        error
      );
    }
  }

  const { clientId, clientSecret, redirectUri } = env.googleOAuth;
  if (clientId && clientSecret && redirectUri) {
    return { clientId, clientSecret, redirectUri, source: "env" };
  }
  return null;
}

/** ¿Hay un respaldo completo en el `.env`? Para avisar antes de quitar el guardado. */
export function hasGoogleOAuthEnvFallback(): boolean {
  const { clientId, clientSecret, redirectUri } = env.googleOAuth;
  return Boolean(clientId && clientSecret && redirectUri);
}
