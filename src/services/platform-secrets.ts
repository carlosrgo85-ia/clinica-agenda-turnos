import { env } from "../config/env";
import { TRACKED_SECRETS, type TrackedSecretKey } from "../config/tracked-secrets";
import { getPlatformSecretValueEncrypted } from "../repositories/platform-secrets.repository";
import { decryptToken } from "./crypto";

/**
 * El valor de un secreto de la plataforma, de donde esté.
 *
 * Es el ÚNICO lugar que descifra un secreto guardado en la base — mismo
 * criterio que `clinicWhatsAppCreds()` con el token de WhatsApp: si cada
 * llamador lo hiciera por su cuenta, tarde o temprano alguno lo loguea o lo
 * mete en una respuesta de la API.
 *
 * Orden: lo guardado en la base manda sobre la variable del `.env`. Eso es lo
 * que permite renovar el secreto desde la pantalla sin reiniciar nada; y el
 * `.env` queda de respaldo para las instalaciones que no lo cargaron.
 */

export type SecretSource = "base" | "env";

export interface ResolvedSecret {
  value: string;
  source: SecretSource;
}

/** Cuánto se recuerda un valor antes de volver a mirar la base. */
export const SECRET_CACHE_TTL_MS = 60_000;

const ENV_FALLBACKS: Record<TrackedSecretKey, () => string | undefined> = {
  microsoft_oauth_client_secret: () => env.microsoftOAuth.clientSecret,
};

const cache = new Map<string, { at: number; resolved: ResolvedSecret | null }>();

/**
 * Se llama al guardar o quitar un valor. Solo limpia ESTE proceso: el otro
 * (servidor web y worker son procesos distintos) se entera cuando vence su
 * caché, a lo sumo `SECRET_CACHE_TTL_MS` después.
 */
export function invalidatePlatformSecretCache(key?: TrackedSecretKey): void {
  if (key) cache.delete(key);
  else cache.clear();
}

export async function getPlatformSecretValue(
  key: TrackedSecretKey,
  now = Date.now()
): Promise<ResolvedSecret | null> {
  const hit = cache.get(key);
  if (hit && now - hit.at < SECRET_CACHE_TTL_MS) return hit.resolved;

  const resolved = await resolve(key);
  cache.set(key, { at: now, resolved });
  return resolved;
}

async function resolve(key: TrackedSecretKey): Promise<ResolvedSecret | null> {
  const encrypted = await getPlatformSecretValueEncrypted(key);
  if (encrypted) {
    try {
      return { value: decryptToken(encrypted), source: "base" };
    } catch (error) {
      // Se cambió la clave de cifrado: el valor guardado ya no se puede leer.
      // Se cae al `.env` en vez de dejar la integración sin secreto, pero se
      // loguea fuerte: alguien tiene que volver a cargarlo.
      console.error(
        `No se pudo descifrar el secreto guardado de ${key} (¿cambió CALENDAR_TOKEN_ENCRYPTION_KEY?). Se usa ${TRACKED_SECRETS[key].envVar}:`,
        error
      );
    }
  }

  const fromEnv = ENV_FALLBACKS[key]();
  return fromEnv ? { value: fromEnv, source: "env" } : null;
}

/** De dónde sale hoy el valor, sin exponerlo: lo que muestra la pantalla. */
export async function describeSecretSource(key: TrackedSecretKey): Promise<SecretSource | "ninguno"> {
  return (await getPlatformSecretValue(key))?.source ?? "ninguno";
}

/** ¿Hay una variable del `.env` que respalde este secreto si se quita el guardado? */
export function hasEnvFallback(key: TrackedSecretKey): boolean {
  return Boolean(ENV_FALLBACKS[key]());
}

/**
 * El valor que llega del formulario, o null si no sirve. Los espacios al
 * principio o al final son casi siempre un copy-paste que arrastró un salto de
 * línea, y adentro no puede haber ninguno: un secreto con un espacio no lo
 * acepta ningún proveedor, y es mejor decirlo acá que como un "credenciales
 * inválidas" después.
 */
export function parseSecretValue(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (value.length < 8 || value.length > 512) return null;
  if (/\s/.test(value)) return null;
  return value;
}
