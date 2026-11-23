import type { MicrosoftAccount } from "@prisma/client";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { decryptToken, encryptToken } from "./crypto";
import { buildOAuthState } from "./oauth-state";
import { getPlatformSecretValue } from "./platform-secrets";

/**
 * OAuth con Microsoft (Entra ID) para que cada clínica conecte su propio
 * Microsoft 365 / Outlook, y acceso a Microsoft Graph con esa cuenta.
 *
 * Se habla con los endpoints HTTP directamente y no con una librería: son
 * tres llamadas (autorizar, canjear/refrescar, y Graph), y así no se suma una
 * dependencia que además guarda tokens en su propia caché.
 *
 * Permisos delegados, los mínimos que necesita la plataforma:
 *
 * - `Calendars.ReadWrite` — crear y borrar los eventos espejo de los turnos,
 *   leer los eventos ajenos para importarlos como bloqueos, y listar los
 *   calendarios para que la clínica elija. No existe una variante "solo
 *   eventos": es el permiso mínimo que alcanza para las tres cosas.
 * - `User.Read` — saber de qué cuenta se trata (el email que se muestra en la
 *   interfaz y que evita duplicar la cuenta al reconectar).
 * - `offline_access` — es lo que hace que Microsoft devuelva un refresh token.
 *   Sin él el acceso se cae en una hora y los cron jobs dejan de funcionar.
 *
 * Dos diferencias con Google que importan:
 *
 * - **Microsoft rota el refresh token en cada uso.** El que devuelve el
 *   refresh es el que hay que guardar; si se pierde, la cuenta se desconecta.
 *   Por eso el refresh es serializado por cuenta (`refreshing`) y se guarda
 *   antes de devolver el access token.
 * - **No hay "cuenta de servicio" de respaldo.** Sin cuenta conectada no hay
 *   forma de acceder al calendario.
 */
export const MICROSOFT_SCOPES = ["offline_access", "Calendars.ReadWrite", "User.Read"];

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const REQUEST_TIMEOUT_MS = 15_000;

/** Margen para no usar un access token que vence en medio de la llamada. */
const EXPIRY_MARGIN_MS = 2 * 60 * 1000;

/** Errores de OAuth que significan "este refresh token ya no sirve, hay que reconectar". */
const REVOKED_ERROR_CODES = new Set(["invalid_grant", "interaction_required", "consent_required"]);

/** Falló la autenticación contra Microsoft. `revoked` = hay que volver a conectar la cuenta. */
export class MicrosoftAuthError extends Error {
  constructor(
    message: string,
    readonly revoked: boolean
  ) {
    super(message);
    this.name = "MicrosoftAuthError";
  }
}

/** Falta configuración de la plataforma (no es un problema de red ni del secreto). */
export class MicrosoftConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicrosoftConfigError";
  }
}

/** Respuesta de error de Microsoft Graph. */
export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    /** Lo que Graph pidió esperar (`Retry-After`), en milisegundos. */
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "GraphError";
  }
}

/** ¿Este error significa que la clínica tiene que volver a conectar la cuenta? */
export function isMicrosoftRevokedError(error: unknown): boolean {
  return error instanceof MicrosoftAuthError && error.revoked;
}

/**
 * ¿Está configurado el OAuth de Microsoft a nivel plataforma? El secreto
 * puede estar guardado en la base o en el `.env` (ver `platform-secrets.ts`),
 * por eso es asíncrono.
 */
export async function isMicrosoftOAuthConfigured(): Promise<boolean> {
  const { clientId, redirectUri } = env.microsoftOAuth;
  if (!clientId || !redirectUri) return false;
  return (await getPlatformSecretValue("microsoft_oauth_client_secret")) !== null;
}

/** Lo que no es secreto: lo que hace falta para armar la URL de consentimiento. */
function requirePublicConfig(): { clientId: string; redirectUri: string; tenant: string } {
  const { clientId, redirectUri, tenant } = env.microsoftOAuth;
  if (!clientId || !redirectUri) {
    throw new MicrosoftConfigError(
      "Falta configurar el OAuth de Microsoft. Hacen falta MICROSOFT_OAUTH_CLIENT_ID y MICROSOFT_OAUTH_REDIRECT_URI — ver docs/onboarding-clinica.md."
    );
  }
  return { clientId, redirectUri, tenant };
}

async function requireConfig(): Promise<{
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tenant: string;
}> {
  const pub = requirePublicConfig();
  const secret = await getPlatformSecretValue("microsoft_oauth_client_secret");
  if (!secret) {
    throw new MicrosoftConfigError(
      "Falta el secreto de la app de Microsoft: cárgalo en Catálogos → Secretos, o en MICROSOFT_OAUTH_CLIENT_SECRET."
    );
  }
  return { ...pub, clientSecret: secret.value };
}

function endpoint(tenant: string, name: "authorize" | "token"): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/${name}`;
}

/** URL de consentimiento a la que se manda a quien conecta la cuenta. */
export function buildMicrosoftConsentUrl(clinicId: string, userId: string): string {
  const { clientId, redirectUri, tenant } = requirePublicConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: MICROSOFT_SCOPES.join(" "),
    // Si la persona tiene varias cuentas de Microsoft abiertas en el
    // navegador, que elija cuál conectar en vez de tomar una sin preguntar.
    prompt: "select_account",
    state: buildOAuthState("microsoft", clinicId, userId),
  });
  return `${endpoint(tenant, "authorize")}?${params.toString()}`;
}

/** Link que arranca el flujo desde el dashboard. */
export function buildMicrosoftConnectLink(clinicId: string): string {
  return `${env.publicBaseUrl}/oauth/microsoft/start?clinicId=${encodeURIComponent(clinicId)}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

async function requestToken(body: Record<string, string>): Promise<TokenResponse> {
  const { clientId, clientSecret, tenant } = await requireConfig();
  const response = await fetch(endpoint(tenant, "token"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...body }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    error_description?: string;
  } & Partial<TokenResponse>;

  if (!response.ok || !payload.access_token) {
    const code = payload.error ?? `http_${response.status}`;
    // El detalle de Microsoft puede traer ids de correlación y trace: se
    // loguea completo en el servidor, pero el mensaje que sube es el código.
    console.error(`Microsoft rechazó la solicitud de token (${code}):`, payload.error_description);
    throw new MicrosoftAuthError(`Microsoft rechazó el acceso (${code}).`, REVOKED_ERROR_CODES.has(code));
  }
  return payload as TokenResponse;
}

/**
 * Comprueba contra Microsoft que un secreto sea válido para esta app, ANTES
 * de guardarlo: un secreto mal pegado desconectaría a todas las clínicas de
 * golpe, y recién se enterarían cuando falle el próximo refresh.
 *
 * Usa `client_credentials`, que no necesita ninguna cuenta ni permiso: si el
 * par cliente/secreto es correcto devuelve un token, y si no, `invalid_client`.
 *
 * Devuelve "invalido" solo cuando Microsoft lo rechaza de forma definitiva;
 * cualquier otra falla (red, caída) se propaga, porque no prueba nada sobre el
 * secreto y no hay que descartarlo por eso.
 */
export async function verifyMicrosoftClientSecret(candidate: string): Promise<"valido" | "invalido"> {
  const { clientId, tenant } = requirePublicConfig();
  const response = await fetch(endpoint(tenant, "token"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: candidate,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.ok) return "valido";

  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  // `invalid_client`: el secreto (o el id) no corresponde a la app.
  if (payload.error === "invalid_client") return "invalido";
  throw new Error(`Microsoft respondió ${response.status} (${payload.error ?? "sin detalle"}) al verificar el secreto.`);
}

/**
 * Cierra el flujo: canjea el `code` por tokens, averigua de qué cuenta se
 * trata, y guarda (o actualiza) la MicrosoftAccount de esa clínica.
 */
export async function exchangeCodeAndSaveMicrosoftAccount(params: {
  clinicId: string;
  code: string;
}): Promise<MicrosoftAccount> {
  const { redirectUri } = requirePublicConfig();
  const tokens = await requestToken({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: redirectUri,
    scope: MICROSOFT_SCOPES.join(" "),
  });

  if (!tokens.refresh_token) {
    // Sin refresh token el acceso dura una hora y no sirve para los cron
    // jobs: mejor fallar claro que guardar algo que va a dejar de funcionar.
    throw new Error(
      "Microsoft no devolvió un refresh token. Revisa que la app tenga el permiso offline_access y vuelve a conectar."
    );
  }

  const me = await graphRequest<{ mail?: string | null; userPrincipalName?: string | null }>(
    tokens.access_token,
    "/me?$select=mail,userPrincipalName"
  );
  const email = (me.mail || me.userPrincipalName || "").toLowerCase();
  if (!email) {
    throw new Error("No se pudo determinar el email de la cuenta de Microsoft que autorizó.");
  }

  const shared = {
    refreshTokenEncrypted: encryptToken(tokens.refresh_token),
    accessTokenEncrypted: encryptToken(tokens.access_token),
    accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    scope: tokens.scope ?? MICROSOFT_SCOPES.join(" "),
    // Una reconexión reactiva una cuenta que estaba revocada.
    revokedAt: null,
    revokedAlertSentAt: null,
  };

  return prisma.microsoftAccount.upsert({
    where: { clinicId_email: { clinicId: params.clinicId, email } },
    create: { clinicId: params.clinicId, email, ...shared },
    update: shared,
  });
}

/**
 * Refrescos en curso, por cuenta. Con refresh tokens rotativos, dos
 * refrescos en paralelo gastan el mismo token: el segundo recibiría un error
 * y la cuenta parecería revocada sin estarlo. Comparten el mismo intento.
 */
const refreshing = new Map<string, Promise<string>>();

async function refreshAccessToken(account: MicrosoftAccount): Promise<string> {
  const tokens = await requestToken({
    grant_type: "refresh_token",
    refresh_token: decryptToken(account.refreshTokenEncrypted),
    scope: MICROSOFT_SCOPES.join(" "),
  });

  // Se guarda ANTES de devolver el token, y se espera: el refresh token
  // nuevo reemplaza al anterior y perderlo desconecta la cuenta.
  await prisma.microsoftAccount.update({
    where: { id: account.id },
    data: {
      accessTokenEncrypted: encryptToken(tokens.access_token),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      ...(tokens.refresh_token ? { refreshTokenEncrypted: encryptToken(tokens.refresh_token) } : {}),
    },
  });
  return tokens.access_token;
}

/** Un access token vigente para la cuenta, refrescándolo si hace falta. */
export async function getMicrosoftAccessToken(
  account: MicrosoftAccount,
  options: { forceRefresh?: boolean } = {}
): Promise<string> {
  if (account.revokedAt) {
    throw new MicrosoftAuthError(
      `La cuenta de Microsoft ${account.email} tiene el acceso revocado. La clínica tiene que volver a conectar su calendario.`,
      true
    );
  }

  if (
    !options.forceRefresh &&
    account.accessTokenEncrypted &&
    account.accessTokenExpiresAt &&
    account.accessTokenExpiresAt.getTime() - Date.now() > EXPIRY_MARGIN_MS
  ) {
    return decryptToken(account.accessTokenEncrypted);
  }

  const inFlight = refreshing.get(account.id);
  if (inFlight) return inFlight;

  const attempt = refreshAccessToken(account).finally(() => refreshing.delete(account.id));
  refreshing.set(account.id, attempt);
  return attempt;
}

/**
 * Marca una cuenta como revocada. Se llama cuando Microsoft rechaza el
 * refresh token: la clínica revocó el acceso o cambió la contraseña, y no hay
 * forma de recuperarlo sin que vuelvan a autorizar.
 */
export async function markMicrosoftAccountRevoked(accountId: string): Promise<void> {
  await prisma.microsoftAccount.update({
    where: { id: accountId },
    data: { revokedAt: new Date() },
  });
}

/** `Retry-After` viene en segundos. Se ignora lo que no sea un número. */
function parseRetryAfter(header: string | null): number | null {
  const seconds = header === null ? NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/** Tope de espera ante un 429: este código corre dentro de un job y de un turno. */
const MAX_RETRY_WAIT_MS = 5000;

/**
 * Una llamada a Microsoft Graph con un access token ya resuelto. Devuelve el
 * JSON, o `undefined` si la respuesta no trae cuerpo (un DELETE).
 */
async function graphRequest<T>(
  accessToken: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<T> {
  const url = path.startsWith("https://") ? path : `${GRAPH_BASE}${path}`;
  // El nextLink de paginación viene como URL completa: solo se sigue si es de
  // Graph, para que un valor inesperado no mande el token a otro host.
  if (!url.startsWith(`${GRAPH_BASE}/`)) {
    throw new Error("URL de Graph inesperada.");
  }

  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    throw new GraphError(
      payload.error?.message ?? `Graph respondió ${response.status}`,
      response.status,
      payload.error?.code ?? null,
      parseRetryAfter(response.headers.get("Retry-After"))
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * Llamada a Graph como una cuenta conectada.
 *
 * - Un 401 se reintenta una vez con un token refrescado (el access token pudo
 *   revocarse antes de su vencimiento).
 * - Un 429 o 503 se reintenta una vez respetando `Retry-After` (con tope): es
 *   lo que Graph pide cuando se pasa de cuota.
 */
export async function graphFetch<T>(
  account: MicrosoftAccount,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<T> {
  let token = await getMicrosoftAccessToken(account);
  try {
    return await graphRequest<T>(token, path, init);
  } catch (error) {
    if (error instanceof GraphError && error.status === 401) {
      token = await getMicrosoftAccessToken(account, { forceRefresh: true });
      return graphRequest<T>(token, path, init);
    }
    if (error instanceof GraphError && (error.status === 429 || error.status === 503)) {
      const wait = Math.min(error.retryAfterMs ?? 2000, MAX_RETRY_WAIT_MS);
      await new Promise((resolve) => setTimeout(resolve, wait));
      return graphRequest<T>(token, path, init);
    }
    throw error;
  }
}
