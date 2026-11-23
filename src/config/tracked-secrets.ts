/**
 * Los secretos de la plataforma cuyo vencimiento se registra y se avisa.
 *
 * El catálogo vive en el código y no en la base: cada entrada tiene que
 * explicar qué se rompe cuando vence y cómo se renueva, y eso es texto que
 * viaja en el mail de aviso. Sumar un secreto es una entrada más acá; la
 * tabla `PlatformSecret` solo guarda la fecha.
 */
export const TRACKED_SECRETS = {
  microsoft_oauth_client_secret: {
    label: "Secreto de la app de Microsoft (Outlook)",
    description:
      "Es el secreto de la app registrada en Microsoft Entra ID. Puede guardarse aquí, cifrado, o quedar en la variable MICROSOFT_OAUTH_CLIENT_SECRET del .env.",
    /** La variable del `.env` que se usa mientras no haya un valor guardado en la base. */
    envVar: "MICROSOFT_OAUTH_CLIENT_SECRET",
    /** Qué deja de funcionar cuando vence. */
    impact:
      "Ninguna clínica puede conectar su cuenta de Outlook ni se pueden refrescar las ya conectadas: las citas dejan de reflejarse en Outlook y los bloqueos dejan de importarse. Las citas en la plataforma siguen funcionando.",
    /** Pasos para renovarlo, en orden. */
    renewal: [
      "Entrar a Microsoft Entra ID → App registrations → la app de la plataforma → Certificates & secrets.",
      "Crear un secreto nuevo (New client secret). Copiar el VALOR en ese momento: después no se puede volver a ver. El secreto viejo sigue valiendo hasta que lo borres, así que no hay corte.",
      "Pegar el valor y la fecha de vencimiento del secreto nuevo en esta pantalla. Se verifica contra Microsoft antes de guardarlo y no hace falta reiniciar nada.",
      "Cuando todo funcione, borrar el secreto viejo en Entra ID.",
    ],
  },
} as const;

export type TrackedSecretKey = keyof typeof TRACKED_SECRETS;

export function isTrackedSecretKey(key: string): key is TrackedSecretKey {
  return Object.prototype.hasOwnProperty.call(TRACKED_SECRETS, key);
}
