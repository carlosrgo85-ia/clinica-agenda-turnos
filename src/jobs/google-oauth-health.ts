import { trackedCron } from "./tracked-cron";
import { env } from "../config/env";
import { listPlatformAdminEmails } from "../repositories/platform-secrets.repository";
import { sendGoogleOAuthInvalidAlert } from "../services/email";
import { getGoogleOAuthConfig } from "../services/google-oauth-config";
import { verifyGoogleOAuthClient } from "../services/google-auth";
import { recordSystemEvent, SYSTEM_EVENT_KINDS } from "../services/system-events";

/**
 * Comprobación diaria de que Google sigue aceptando la app de OAuth de la plataforma.
 *
 * El secreto puede dejar de servir sin que nadie toque nada acá (alguien lo rota o lo borra en
 * Google Cloud Console) y el síntoma llega tarde y de lado: una clínica que no puede conectar
 * su calendario, o cuentas que dejan de refrescar. Este job lo detecta antes, con la misma
 * prueba que se hace al guardar (`verifyGoogleOAuthClient()`: un `code` inventado). No necesita
 * ninguna cuenta ni cambia nada.
 *
 * Corre una vez por día: eso es el "no repetir el aviso" (un mail por día mientras siga mal).
 * Si el SMTP está caído ese día, el evento igual queda en Monitoreo y se reintenta mañana.
 */
export function scheduleGoogleOAuthHealth(): void {
  trackedCron("google-oauth-health", "10 8 * * *", async () => {
    await runGoogleOAuthHealthCheck(defaultDeps());
  });
}

export interface GoogleOAuthHealthDeps {
  getConfig: typeof getGoogleOAuthConfig;
  verify: typeof verifyGoogleOAuthClient;
  listRecipients: () => Promise<string[]>;
  send: typeof sendGoogleOAuthInvalidAlert;
  recordEvent: typeof recordSystemEvent;
}

function defaultDeps(): GoogleOAuthHealthDeps {
  return {
    getConfig: getGoogleOAuthConfig,
    verify: verifyGoogleOAuthClient,
    listRecipients: listPlatformAdminEmails,
    send: sendGoogleOAuthInvalidAlert,
    recordEvent: recordSystemEvent,
  };
}

export type GoogleOAuthHealth = "sin_configurar" | "valido" | "invalido" | "no_se_pudo_verificar";

/**
 * Verifica y, si Google la rechaza, deja un evento en Monitoreo y avisa por mail a los
 * administradores de la plataforma. Devuelve qué encontró, para poder probarlo sin cron.
 *
 * - Sin app configurada no hay nada que verificar (no es una falla: puede que la plataforma no
 *   use Google).
 * - Una falla de red o una caída de Google **no prueba nada sobre el secreto**: no se avisa
 *   como inválida, solo se registra que no se pudo comprobar.
 */
export async function runGoogleOAuthHealthCheck(deps: GoogleOAuthHealthDeps): Promise<GoogleOAuthHealth> {
  const config = await deps.getConfig();
  if (!config) return "sin_configurar";

  let estado: "valido" | "invalido";
  try {
    estado = await deps.verify({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
    });
  } catch (error) {
    console.warn("No se pudo verificar la app de Google (no prueba nada sobre el secreto):", error);
    return "no_se_pudo_verificar";
  }
  if (estado === "valido") return "valido";

  await deps.recordEvent({
    kind: SYSTEM_EVENT_KINDS.GOOGLE_OAUTH_INVALIDO,
    clinicId: null,
    severity: "error",
    message: `Google rechazó la app de OAuth de la plataforma (origen: ${config.source}).`,
  });

  const recipients = await deps.listRecipients();
  if (recipients.length === 0) {
    console.error("Google rechaza la app de OAuth y no hay ningún administrador de plataforma activo a quien avisar.");
    return "invalido";
  }
  try {
    await deps.send({ to: recipients, screenUrl: `${env.frontendUrl}/app/platform/catalogs/secrets` });
  } catch (error) {
    console.error("No se pudo mandar el aviso de que Google rechaza la app de OAuth:", error);
  }
  return "invalido";
}
