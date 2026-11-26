import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { GoogleAccount } from "@prisma/client";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { getGoogleOAuthConfig } from "./google-oauth-config";
import { decryptToken, encryptToken } from "./crypto";
import { buildOAuthState } from "./oauth-state";

/**
 * OAuth con Google, para que cada clínica conecte su propia cuenta y elija
 * el calendario de una lista, en vez de compartirle un calendario a mano a
 * la cuenta de servicio y copiar y pegar el id.
 *
 * Los scopes son los mínimos que necesita la plataforma:
 *
 * - `calendar.events` — crear y borrar los eventos espejo de los turnos, y
 *   leer los eventos ajenos para importarlos como bloqueos.
 * - `calendar.calendarlist.readonly` — listar los calendarios de la cuenta, para
 *   que la clínica elija cuál conectar (y leer el calendario "primary" para saber
 *   de qué cuenta es). Reemplaza a `calendar.readonly` (2026-11-26): ese da lectura
 *   de TODO el calendario y solo se usaba para esto; el más estrecho lo pide Google
 *   en la verificación. Las cuentas ya conectadas con `calendar.readonly` siguen
 *   funcionando: lo que se concedió no se revoca por cambiar este arreglo.
 *
 * A propósito NO se pide el scope `calendar` completo, que además permite
 * crear y borrar calendarios enteros.
 */
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

/** Se lanza cuando falta la app de OAuth de la plataforma. */
export class GoogleConfigError extends Error {}

/** ¿Está configurado el OAuth a nivel plataforma? (en la base o en el `.env`) */
export async function isOAuthConfigured(): Promise<boolean> {
  return (await getGoogleOAuthConfig()) !== null;
}

async function requireOAuthConfig(): Promise<{ clientId: string; clientSecret: string; redirectUri: string }> {
  const config = await getGoogleOAuthConfig();
  if (!config) {
    throw new GoogleConfigError(
      "Falta configurar el OAuth de Google: cárgalo en Catálogos → Secretos, o en GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REDIRECT_URI del .env — ver docs/onboarding-clinica.md."
    );
  }
  return config;
}

async function newOAuthClient(): Promise<OAuth2Client> {
  const { clientId, clientSecret, redirectUri } = await requireOAuthConfig();
  // `forceRefreshOnFailure`: si Google rechaza con 401 un access token que, según su `expiry_date` guardado, todavía no venció
  // (el token se invalidó del lado de Google, o el reloj se corrió), la librería pide uno nuevo con el refresh token y REINTENTA
  // UNA vez. Sin esto, con `expiry_date` seteado la librería no reintenta nunca, y cada pasada de `calendar-sync` fallaba con
  // "Invalid Credentials" hasta que el token vencía solo (visto el 2026-11-19). Si el refresh token también es inválido,
  // el error sigue siendo `invalid_grant` y la cuenta se marca como revocada, igual que antes.
  return new google.auth.OAuth2({ clientId, clientSecret, redirectUri, forceRefreshOnFailure: true });
}

/**
 * ¿Google reconoce este par id/secreto? Se prueba ANTES de guardarlo: un par
 * mal pegado desconectaría a todas las clínicas de golpe.
 *
 * Se canjea un `code` inventado: con credenciales buenas Google contesta
 * `invalid_grant` (el código no existe), con malas `invalid_client`. No
 * necesita cuenta ni permisos. Cualquier otra respuesta (red, caída) se
 * propaga, porque no prueba nada sobre las credenciales.
 */
export async function verifyGoogleOAuthClient(candidate: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<"valido" | "invalido"> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: candidate.clientId,
      client_secret: candidate.clientSecret,
      redirect_uri: candidate.redirectUri,
      grant_type: "authorization_code",
      code: "verificacion-de-credenciales",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (payload.error === "invalid_client") return "invalido";
  if (payload.error === "invalid_grant") return "valido";
  throw new Error(`Google respondió ${response.status} (${payload.error ?? "sin detalle"}) al verificar las credenciales.`);
}

/**
 * URL de consentimiento a la que se manda a la clínica.
 *
 * `access_type: offline` es lo que hace que Google devuelva un refresh
 * token; sin eso el acceso se cae en una hora y los cron jobs dejan de
 * funcionar. `prompt: consent` fuerza a que devuelva uno nuevo incluso si
 * la cuenta ya había autorizado antes — Google manda el refresh token una
 * sola vez por autorización, así que sin esto una reconexión puede quedar
 * sin token.
 */
export async function buildConsentUrl(clinicId: string, userId: string): Promise<string> {
  const client = await newOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_CALENDAR_SCOPES,
    include_granted_scopes: true,
    // El state va firmado: es lo que impide que alguien mande un callback
    // con el clinicId de otra clínica (ver services/crypto.ts). Lleva también
    // QUIÉN inició el flujo: el callback exige que sea la misma sesión, así
    // un link de consentimiento armado por otro usuario no se puede completar
    // desde otra cuenta (login CSRF).
    state: buildOAuthState("google", clinicId, userId),
  });
}

/**
 * Cierra el flujo: canjea el `code` por tokens, averigua de qué cuenta de
 * Google se trata, y guarda (o actualiza) la GoogleAccount de esa clínica.
 */
export async function exchangeCodeAndSaveAccount(params: {
  clinicId: string;
  code: string;
}): Promise<GoogleAccount> {
  const client = await newOAuthClient();
  const { tokens } = await client.getToken(params.code);

  if (!tokens.refresh_token) {
    // Pasa si la cuenta ya había autorizado y Google no vuelve a mandar el
    // refresh token. Sin refresh token el acceso dura una hora, así que no
    // sirve para los cron jobs: mejor fallar claro que guardar algo que va
    // a dejar de funcionar solo.
    throw new Error(
      "Google no devolvió un refresh token. Revoca el acceso de la app en https://myaccount.google.com/permissions y vuelve a conectar."
    );
  }

  client.setCredentials(tokens);

  // De qué cuenta es. Se usa solo para mostrarla en la interfaz y para no
  // duplicar filas si la misma cuenta se reconecta.
  //
  // El email sale del calendario "primary", cuyo id ES el email de la cuenta, y
  // no de la API de userinfo: esa pide el scope `email`/`openid`, que no
  // pedimos a propósito (solo los dos de Calendar). `calendar.calendarlist.readonly` alcanza.
  const calendar = google.calendar({ version: "v3", auth: client });
  const { data: primary } = await calendar.calendarList.get({ calendarId: "primary" });
  const email = primary.id;
  if (!email) {
    throw new Error("No se pudo determinar el email de la cuenta de Google que autorizó.");
  }

  const shared = {
    refreshTokenEncrypted: encryptToken(tokens.refresh_token),
    accessTokenEncrypted: tokens.access_token ? encryptToken(tokens.access_token) : null,
    accessTokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    scope: tokens.scope ?? GOOGLE_CALENDAR_SCOPES.join(" "),
    // Una reconexión reactiva una cuenta que estaba revocada.
    revokedAt: null,
    revokedAlertSentAt: null,
  };

  return prisma.googleAccount.upsert({
    where: { clinicId_email: { clinicId: params.clinicId, email } },
    create: { clinicId: params.clinicId, email, ...shared },
    update: shared,
  });
}

/**
 * Cliente autenticado como una cuenta conectada.
 *
 * La librería de Google refresca el access token sola cuando tiene el
 * refresh token. Lo que agregamos acá es persistir el token nuevo (evento
 * `tokens`), para no pedir uno nuevo en cada llamada, y marcar la cuenta
 * como revocada si el refresh falla de forma definitiva.
 */
export async function getClientForAccount(account: GoogleAccount): Promise<OAuth2Client> {
  const client = await newOAuthClient();

  client.setCredentials({
    refresh_token: decryptToken(account.refreshTokenEncrypted),
    access_token: account.accessTokenEncrypted
      ? decryptToken(account.accessTokenEncrypted)
      : undefined,
    expiry_date: account.accessTokenExpiresAt?.getTime(),
  });

  client.on("tokens", (tokens) => {
    // Se dispara cuando la librería consigue un access token nuevo. El
    // refresh token solo viene si Google lo rotó.
    void prisma.googleAccount
      .update({
        where: { id: account.id },
        data: {
          ...(tokens.access_token
            ? { accessTokenEncrypted: encryptToken(tokens.access_token) }
            : {}),
          ...(tokens.expiry_date
            ? { accessTokenExpiresAt: new Date(tokens.expiry_date) }
            : {}),
          ...(tokens.refresh_token
            ? { refreshTokenEncrypted: encryptToken(tokens.refresh_token) }
            : {}),
        },
      })
      .catch((error) => {
        // No es fatal: el peor caso es volver a refrescar en la próxima
        // llamada. No puede tumbar la operación en curso.
        console.error(`No se pudo guardar el token refrescado de ${account.email}:`, error);
      });
  });

  return client;
}

/**
 * Marca una cuenta como revocada. Se llama cuando Google rechaza el refresh
 * token (`invalid_grant`): la clínica revocó el acceso o cambió la
 * contraseña, y no hay forma de recuperarlo sin que vuelvan a autorizar.
 */
export async function markAccountRevoked(accountId: string): Promise<void> {
  await prisma.googleAccount.update({
    where: { id: accountId },
    data: { revokedAt: new Date() },
  });
}

/** ¿Este error de Google significa "el refresh token ya no sirve"? */
export function isInvalidGrantError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.includes("invalid_grant");
}

/** Link que se le manda a la clínica para que conecte su calendario. */
export function buildConnectLink(clinicId: string): string {
  return `${env.publicBaseUrl}/oauth/google/start?clinicId=${encodeURIComponent(clinicId)}`;
}
