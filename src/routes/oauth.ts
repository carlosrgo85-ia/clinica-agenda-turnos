import { Router, type Response } from "express";
import type { CalendarProviderKind } from "@prisma/client";
import { prisma } from "../db/client";
import { PERMISSIONS } from "../config/permissions";
import { authenticate } from "../middleware/authenticate";
import { userCanAccessClinic } from "../middleware/authorize";
import { buildConsentUrl, exchangeCodeAndSaveAccount, isOAuthConfigured } from "../services/google-auth";
import {
  buildMicrosoftConsentUrl,
  exchangeCodeAndSaveMicrosoftAccount,
  isMicrosoftOAuthConfigured,
} from "../services/microsoft-auth";
import { readOAuthState } from "../services/oauth-state";
import { syncClinicBlocksNow } from "../jobs/calendar-sync";

export const oauthRouter = Router();

/**
 * Flujo de OAuth para que una clínica conecte su calendario (Google o
 * Microsoft). Las dos rutas de cada proveedor las arma la MISMA función
 * (`mountProvider`), así las reglas de seguridad no pueden divergir.
 *
 * Todas exigen sesión y el permiso `calendarios.editar` sobre la clínica.
 * Sin eso, cualquiera que conociera el id de una clínica podía conectarle SU
 * propia cuenta: los turnos (paciente, servicio, hora) se habrían espejado en
 * un calendario ajeno.
 *
 * Funciona con la cookie de sesión (`SameSite=Lax`): viaja tanto en el click
 * del dashboard como en la redirección de vuelta, que son navegaciones de
 * primer nivel por GET.
 *
 * El `state` firmado lleva el usuario, la clínica y el proveedor, y el
 * callback exige que coincidan con la sesión (ver `services/oauth-state.ts`).
 */
interface OAuthProvider {
  kind: CalendarProviderKind;
  /** Segmento de la URL: /oauth/<path>/start. */
  path: string;
  /** Cómo se nombra en los mensajes al usuario. */
  label: string;
  isConfigured: () => boolean | Promise<boolean>;
  /** Variables que faltan, para el 503. */
  configHint: string;
  buildConsentUrl: (clinicId: string, userId: string) => string | Promise<string>;
  exchange: (params: { clinicId: string; code: string }) => Promise<{ email: string }>;
}

const PROVIDERS: OAuthProvider[] = [
  {
    kind: "google",
    path: "google",
    label: "Google",
    isConfigured: isOAuthConfigured,
    configHint: "Catálogos → Secretos, o GOOGLE_OAUTH_* en el .env",
    buildConsentUrl,
    exchange: exchangeCodeAndSaveAccount,
  },
  {
    kind: "microsoft",
    path: "microsoft",
    label: "Microsoft",
    isConfigured: isMicrosoftOAuthConfigured,
    configHint: "MICROSOFT_OAUTH_*",
    buildConsentUrl: buildMicrosoftConsentUrl,
    exchange: exchangeCodeAndSaveMicrosoftAccount,
  },
];

/** Los links con `code`/`state` no se cachean ni se filtran por Referer. */
function noStore(res: Response) {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
}

function mountProvider(provider: OAuthProvider) {
  /** Manda a la pantalla de consentimiento del proveedor. */
  oauthRouter.get(`/${provider.path}/start`, authenticate, async (req, res) => {
    noStore(res);

    if (!(await provider.isConfigured())) {
      return res.status(503).json({
        error: `El OAuth de ${provider.label} no está configurado en esta instalación (${provider.configHint}). Ver docs/onboarding-clinica.md.`,
      });
    }

    const clinicId = typeof req.query.clinicId === "string" ? req.query.clinicId : "";
    if (!clinicId) {
      return res.status(400).json({ error: "Falta el parámetro clinicId." });
    }

    const user = req.user!;
    // La autorización va antes que la búsqueda: un 404 distinto le diría a
    // quien no tiene acceso qué ids de clínica existen.
    if (!userCanAccessClinic(user, clinicId, PERMISSIONS.CALENDARIOS_EDITAR)) {
      return res.status(403).json({ error: "No tienes permiso para conectar calendarios de esta clínica." });
    }

    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { id: true } });
    if (!clinic) {
      return res.status(404).json({ error: "Clínica no encontrada" });
    }

    res.redirect(await provider.buildConsentUrl(clinicId, user.id));
  });

  /**
   * Vuelta del proveedor. Canjea el código por tokens y guarda la cuenta.
   *
   * Después de esto la clínica todavía tiene que ELEGIR un calendario: esto
   * solo deja la cuenta conectada. La lista sale de
   * `GET /dashboard/clinics/:clinicId/<proveedor>-accounts/:accountId/calendars`.
   */
  oauthRouter.get(`/${provider.path}/callback`, authenticate, async (req, res) => {
    noStore(res);
    const { code, state, error: providerError } = req.query;

    if (typeof providerError === "string") {
      // El caso normal: la persona apretó "Cancelar" en la pantalla del proveedor.
      return res
        .status(400)
        .send(renderPage("No se conectó la cuenta", `${provider.label} devolvió: ${escapeHtml(providerError)}`));
    }

    if (typeof code !== "string" || typeof state !== "string") {
      return res.status(400).send(renderPage("Solicitud incompleta", "Faltan el código o el state."));
    }

    const parsed = readOAuthState(state, provider.kind);
    if (!parsed) {
      // State inválido, vencido, firmado con otra clave, o de otro proveedor.
      return res
        .status(400)
        .send(renderPage("El link venció", "Vuelve a empezar la conexión del calendario."));
    }

    // El flujo lo tiene que completar la misma sesión que lo inició, y esa
    // sesión tiene que conservar el permiso (pudo cambiar de rol en el medio).
    const user = req.user!;
    const { clinicId } = parsed;
    if (parsed.userId !== user.id || !userCanAccessClinic(user, clinicId, PERMISSIONS.CALENDARIOS_EDITAR)) {
      console.warn(
        `OAuth de ${provider.label} rechazado: usuario ${user.id} no corresponde al flujo de la clínica ${clinicId}.`
      );
      return res
        .status(403)
        .send(
          renderPage(
            "No se pudo conectar la cuenta",
            "Este link no corresponde a tu sesión. Vuelve a empezar desde Calendarios."
          )
        );
    }

    try {
      const account = await provider.exchange({ clinicId, code });
      // Una reconexión devuelve a la vida un calendario que ya estaba enlazado:
      // se importan los bloqueos ahora, no dentro de 15 minutos.
      syncClinicBlocksNow(clinicId, `cuenta de ${provider.label} conectada`);
      res.send(
        renderPage(
          "Cuenta conectada",
          `Ya puedes elegir qué calendario usar para <strong>${escapeHtml(account.email)}</strong>.`
        )
      );
    } catch (error) {
      console.error(`Error conectando la cuenta de ${provider.label} de la clínica ${clinicId}:`, error);
      const detalle = error instanceof Error ? error.message : "Error inesperado";
      res.status(500).send(renderPage("No se pudo conectar la cuenta", escapeHtml(detalle)));
    }
  });
}

PROVIDERS.forEach(mountProvider);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Página mínima de respuesta. El callback lo abre una persona en un
 * navegador, así que devolver JSON crudo sería poco amable.
 *
 * TODO (Claude Code): cuando exista el frontend del dashboard, redirigir
 * ahí en vez de servir este HTML.
 */
function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; line-height: 1.5">
  <h1>${escapeHtml(title)}</h1>
  <p>${body}</p>
</body>
</html>`;
}
