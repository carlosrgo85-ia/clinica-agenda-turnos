import { scheduleDailyReport } from "./jobs/daily-report";
import { scheduleDailyReminders } from "./jobs/daily-reminders";
import { scheduleTwoHourReminders } from "./jobs/two-hour-reminders";
import { schedulePostVisitFollowUp } from "./jobs/post-visit-followup";
import { scheduleCalendarSync } from "./jobs/calendar-sync";
import { scheduleConfigAlerts } from "./jobs/config-alerts";
import { scheduleInboundSweeper } from "./jobs/inbound-sweeper";
import { scheduleCalendarAccessAlerts } from "./jobs/calendar-access-alerts";
import { scheduleSecretExpiryAlerts } from "./jobs/secret-expiry-alerts";
import { scheduleGoogleOAuthHealth } from "./jobs/google-oauth-health";
import { scheduleSystemEventsCleanup } from "./jobs/system-events-cleanup";
import { schedulePackageReminders } from "./jobs/package-reminders";
import { scheduleNextVisitOutreach } from "./jobs/next-visit-outreach";
import { scheduleCampaignFollowUp } from "./jobs/campaign-followup";
import { scheduleSandboxCleanup } from "./jobs/sandbox-cleanup";

/**
 * Proceso de tareas programadas. Corre APARTE del servidor web
 * (`src/index.ts`) y tiene que haber **exactamente una** instancia.
 *
 * Antes los seis crons se programaban en el callback de `app.listen()`, así
 * que los programaba cada instancia del servidor web. Con una sola instancia
 * funciona; con dos, cada paciente recibe cada recordatorio dos veces, el
 * seguimiento post-visita sale duplicado y el sync de calendario importa los
 * mismos bloqueos en paralelo. Es decir: el servidor web no se podía escalar
 * horizontalmente, que es justo lo que necesita cuando entran muchos mensajes
 * juntos — cada mensaje retiene su conexión de Prisma mientras espera las dos
 * llamadas a Claude.
 *
 * Separarlos deja al servidor web sin nada que dependa de que haya una sola
 * instancia: se pueden levantar N atrás de un balanceador sin que a ningún
 * paciente le llegue nada duplicado.
 *
 * La contracara es que el worker hay que levantarlo aparte: en producción son
 * dos procesos (`npm start` y `npm run start:worker`), y en desarrollo
 * `npm run dev` levanta los dos junto con la SPA. Si el worker no está
 * corriendo, la plataforma atiende pacientes igual pero nadie recibe
 * recordatorios, reportes ni avisos de configuración, y los bloqueos de
 * Google Calendar dejan de importarse.
 *
 * `scheduleInboundSweeper` es el único que toca el camino del paciente, y aun
 * así no es su camino principal: contestar los mensajes lo sigue haciendo el
 * servidor web. Este solo rescata los que dejó colgando una instancia que se
 * cayó en medio de la espera.
 */
scheduleDailyReport();
scheduleDailyReminders(); // 24hs, incluido en Base
scheduleTwoHourReminders(); // Plus, se auto-filtra por clínica
schedulePostVisitFollowUp(); // Plus, se auto-filtra por clínica
scheduleCalendarSync(); // importa bloqueos de Calendar → Postgres, cada 15'
scheduleConfigAlerts(); // avisa a las clínicas sin horario de atención cargado
scheduleInboundSweeper(); // rescata mensajes que dejó colgando una instancia caída
scheduleCalendarAccessAlerts(); // avisa a las clínicas que hay que reconectar un calendario revocado
scheduleSecretExpiryAlerts(); // avisa a los admins de plataforma que vence un secreto
scheduleGoogleOAuthHealth(); // verifica contra Google que la app de OAuth de la plataforma siga valiendo
scheduleSystemEventsCleanup(); // borra los eventos de monitoreo que pasaron la retención
schedulePackageReminders(); // mail a la asistente: citas por paquete sin marcar como atendidas
scheduleSandboxCleanup(); // borra las conversaciones del chat de pruebas que quedaron sin actividad
scheduleCampaignFollowUp(); // seguimiento de quienes llegaron por una campaña y no agendaron (apagado por defecto, con tope)
scheduleNextVisitOutreach(); // WhatsApp a pacientes cuya próxima cita sugerida se acerca (apagado por defecto)

console.log("Worker de tareas programadas activo (15 jobs)");
