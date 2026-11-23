import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

/**
 * Variable opcional. Se usa para los dos modos de acceso a Google Calendar
 * (cuenta de servicio y OAuth): una plataforma puede tener configurado uno,
 * el otro, o los dos, y no tiene sentido que falte uno y no arranque nada.
 * Quien la consume avisa con un error claro si hacía falta.
 */
function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

/**
 * Variables de entorno GLOBALES de la plataforma, iguales para todas las
 * clínicas. Todo lo que varía por clínica (token de WhatsApp, calendario,
 * nombre, horarios) vive en la tabla Clinic de la base de datos — ver
 * prisma/schema.prisma y repositories/clinics.repository.ts.
 */
export const env = {
  port: Number(process.env.PORT ?? 3000),

  // Cuántos proxies hay delante del servidor web (balanceador del hosting,
  // Cloudflare…). Sin esto, detrás de un proxy `req.ip` es la IP del proxy:
  // el límite de intentos de login contaría a todo el mundo como una sola
  // persona y la auditoría guardaría la IP equivocada. 0 = sin proxy (local).
  // Mal configurado, X-Forwarded-For se puede falsificar: ver docs/despliegue.md.
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? 0),

  databaseUrl: required("DATABASE_URL"),

  // Un mismo Meta App puede recibir mensajes de varios números de WhatsApp
  // (uno por clínica). El verify token del webhook es el mismo para todos.
  whatsappVerifyToken: required("WHATSAPP_VERIFY_TOKEN"),

  anthropic: {
    apiKey: required("ANTHROPIC_API_KEY"),
  },

  /**
   * Cuenta de servicio de Google, compartida — el modo viejo de acceso a
   * los calendarios: cada clínica comparte su calendario con este email
   * como editor (ver docs/onboarding-clinica.md).
   *
   * Opcional: una plataforma que conecte todos los calendarios por OAuth no
   * la necesita. Si un calendario la necesita y no está configurada,
   * services/calendar.ts avisa con un error explícito.
   */
  google: {
    clientEmail: optional("GOOGLE_CLIENT_EMAIL"),
    privateKey: optional("GOOGLE_PRIVATE_KEY")?.replace(/\\n/g, "\n"),
  },

  /**
   * Cliente de OAuth con el que las clínicas conectan su propia cuenta de
   * Google. Se crea una vez para toda la plataforma en Google Cloud
   * Console (tipo "Aplicación web") y la `redirectUri` tiene que estar
   * registrada ahí igual, carácter por carácter.
   */
  googleOAuth: {
    clientId: optional("GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: optional("GOOGLE_OAUTH_CLIENT_SECRET"),
    redirectUri: optional("GOOGLE_OAUTH_REDIRECT_URI"),
  },

  /**
   * App registration de Microsoft Entra ID (Azure) con la que las clínicas
   * conectan su Microsoft 365 / Outlook. Se crea una vez para toda la
   * plataforma, como "Aplicación web", con la `redirectUri` registrada igual
   * carácter por carácter. `tenant` en "common" acepta cuentas de trabajo,
   * educativas y personales de cualquier organización (el caso de una
   * plataforma que se vende a muchas clínicas); solo se cambia para
   * restringirla a un tenant concreto.
   */
  microsoftOAuth: {
    clientId: optional("MICROSOFT_OAUTH_CLIENT_ID"),
    clientSecret: optional("MICROSOFT_OAUTH_CLIENT_SECRET"),
    redirectUri: optional("MICROSOFT_OAUTH_REDIRECT_URI"),
    tenant: optional("MICROSOFT_OAUTH_TENANT") ?? "common",
  },

  /**
   * Clave con la que se cifran los refresh tokens de OAuth antes de
   * guardarlos, y con la que se firma el `state` del flujo. 32 bytes en
   * hex — generar con `openssl rand -hex 32`.
   *
   * Si se pierde o se cambia, los tokens guardados dejan de poder
   * descifrarse y cada clínica tiene que volver a conectar su calendario.
   */
  calendarTokenEncryptionKey: optional("CALENDAR_TOKEN_ENCRYPTION_KEY"),

  /**
   * Places API (New) de Google — para traer dirección, teléfono, sitio
   * web y horario de un negocio a partir de su link de Google (Maps /
   * "share.google"). Opcional: sin esta clave, `services/google-places.ts`
   * avisa con un error explícito y el resto de la plataforma sigue
   * funcionando igual. Requiere un proyecto de Google Cloud con la
   * "Places API (New)" habilitada y facturación activa (tiene uso
   * gratuito mensual, pero la API no arranca sin una cuenta de
   * facturación asociada).
   */
  googlePlacesApiKey: optional("GOOGLE_PLACES_API_KEY"),

  /**
   * URL pública del backend, para armar el link de "conectar calendario"
   * que se le manda a la clínica.
   */
  /**
   * Zona horaria con la que la plataforma decide qué día es "hoy" cuando no
   * hay una clínica de por medio (hoy: los recordatorios de vencimiento de
   * secretos). Una zona IANA; por default UTC.
   */
  platformTimezone: optional("PLATFORM_TIMEZONE") ?? "UTC",

  publicBaseUrl: optional("PUBLIC_BASE_URL") ?? `http://localhost:${process.env.PORT ?? 3000}`,

  /**
   * Con qué se firman los JWT de sesión (cookie httpOnly). Si se cambia,
   * todas las sesiones activas quedan inválidas — no es grave, cada
   * usuario vuelve a loguearse.
   */
  jwtSecret: required("JWT_SECRET"),
  jwtExpiresIn: optional("JWT_EXPIRES_IN") ?? "8h",

  /**
   * Origen público del frontend (la SPA). Se usa para armar los links de
   * los emails de invitación / recuperación de contraseña, y el que
   * `jobs/config-alerts.ts` manda cuando falta configuración.
   */
  frontendUrl: optional("FRONTEND_URL") ?? `http://localhost:${process.env.PORT ?? 3000}`,

  // Cuenta SMTP única desde la que se envían todos los reportes diarios,
  // uno por clínica, a la casilla de email configurada en cada Clinic.
  smtp: {
    host: required("SMTP_HOST"),
    port: Number(process.env.SMTP_PORT ?? 587),
    user: required("SMTP_USER"),
    pass: required("SMTP_PASS"),
  },
};
