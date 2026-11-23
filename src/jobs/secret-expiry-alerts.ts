import { trackedCron } from "./tracked-cron";
import { env } from "../config/env";
import { TRACKED_SECRETS, isTrackedSecretKey } from "../config/tracked-secrets";
import {
  listPlatformAdminEmails,
  listPlatformSecrets,
  markSecretReminded,
  type PlatformSecretRecord,
} from "../repositories/platform-secrets.repository";
import { sendSecretExpiryReminder } from "../services/email";
import { describeDays, daysUntil, shouldRemindToday } from "../services/secret-expiry";
import { clinicDateKey } from "../services/time";

/**
 * Recordatorio diario de que vence un secreto de la plataforma, desde una
 * semana antes y hasta que se registre la fecha del secreto nuevo.
 *
 * Corre cada hora entre las 8 y las 18 y no una sola vez al día: el primero
 * que sale marca el día como avisado (`lastReminderOn`) y el resto no hace
 * nada, pero si el SMTP está caído a las 8 el aviso se reintenta a las 9 en
 * vez de perderse hasta mañana. Es un aviso que, de perderse, se entera uno
 * cuando ya se rompió la integración.
 *
 * El día se decide con `PLATFORM_TIMEZONE`, no con la hora del servidor.
 */
export function scheduleSecretExpiryAlerts(): void {
  trackedCron("secret-expiry-alerts", "0 8-18 * * *", async () => {
    await runSecretExpiryReminders(defaultDeps());
  });
}

export interface SecretReminderDeps {
  today: string;
  listSecrets: () => Promise<PlatformSecretRecord[]>;
  listRecipients: () => Promise<string[]>;
  send: typeof sendSecretExpiryReminder;
  markReminded: (key: string, today: string) => Promise<void>;
}

function defaultDeps(now = new Date()): SecretReminderDeps {
  return {
    today: clinicDateKey(now, env.platformTimezone),
    listSecrets: listPlatformSecrets,
    listRecipients: listPlatformAdminEmails,
    send: sendSecretExpiryReminder,
    markReminded: markSecretReminded,
  };
}

/**
 * Manda los recordatorios que toquen hoy. Devuelve las claves a las que se
 * les avisó, para poder testearlo sin cron ni base.
 *
 * Un secreto se marca como avisado SOLO si el mail salió: si falla, no se
 * marca y el próximo intento lo reintenta. Y si no hay a quién avisar tampoco
 * se marca ni se manda: se loguea fuerte, porque ese es un aviso que nadie va
 * a leer.
 */
export async function runSecretExpiryReminders(deps: SecretReminderDeps): Promise<string[]> {
  const secrets = await deps.listSecrets();
  const reminded: string[] = [];

  for (const secret of secrets) {
    // Cada secreto va aparte: uno con un problema no deja sin aviso a los demás.
    try {
      // Sin fecha no se sigue el vencimiento (puede tener solo el valor guardado).
      if (secret.expiresOn === null) continue;
      const days = daysUntil(secret.expiresOn, deps.today);
      if (days === null || !isTrackedSecretKey(secret.key)) continue;
      if (!shouldRemindToday(days, secret.lastReminderOn, deps.today)) continue;

      const recipients = await deps.listRecipients();
      if (recipients.length === 0) {
        console.error(
          `El secreto ${secret.key} ${describeDays(days)} y no hay ningún administrador de plataforma activo a quien avisar.`
        );
        continue;
      }

      const definition = TRACKED_SECRETS[secret.key];
      await deps.send({
        to: recipients,
        label: definition.label,
        cuando: describeDays(days),
        vencido: days < 0,
        expiresOn: secret.expiresOn,
        impact: definition.impact,
        renewal: definition.renewal,
        note: secret.note,
        screenUrl: `${env.frontendUrl}/app/platform/catalogs/secrets`,
      });
      await deps.markReminded(secret.key, deps.today);
      reminded.push(secret.key);
    } catch (error) {
      console.error(`No se pudo mandar el recordatorio de vencimiento de ${secret.key}:`, error);
    }
  }

  return reminded;
}
