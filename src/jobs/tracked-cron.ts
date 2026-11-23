import cron from "node-cron";
import { prisma } from "../db/client";
import { describeError, recordSystemEvent, SYSTEM_EVENT_KINDS } from "../services/system-events";

/**
 * `cron.schedule()` con latido: anota en `CronHeartbeat` cuándo arrancó y
 * cuándo terminó cada corrida, y qué error tuvo.
 *
 * Es lo que permite ver, desde "Monitoreo", que el worker está apagado o que
 * una tarea lleva horas sin correr. Sin esto un worker caído no deja ningún
 * rastro: simplemente nadie recibe recordatorios.
 *
 * **Mantiene la regla de que cada cron se protege a sí mismo**: el callback
 * tiene su propio try/catch, así que una excepción no escapa como promesa
 * rechazada (que mataría el proceso y con él a los otros jobs). Y escribir el
 * latido tampoco puede fallar hacia afuera.
 *
 * Lo que el cuerpo atrapa por su cuenta (el try/catch por clínica) no llega
 * acá: el latido dice "corrió", no "todo salió perfecto". Esos errores se
 * registran como eventos desde el propio job.
 */
export function trackedCron(jobName: string, expression: string, run: () => Promise<void>): void {
  cron.schedule(expression, async () => {
    const startedAt = new Date();
    await beat(jobName, { startedAt });

    let error: unknown;
    try {
      await run();
    } catch (e) {
      error = e;
      console.error(`Error en la tarea programada ${jobName}:`, e);
      await recordSystemEvent({
        kind: SYSTEM_EVENT_KINDS.CRON_ERROR,
        message: `${jobName}: ${describeError(e)}`,
      });
    }

    await beat(jobName, { startedAt, finishedAt: new Date(), error });
  });
}

async function beat(
  jobName: string,
  data: { startedAt: Date; finishedAt?: Date; error?: unknown }
): Promise<void> {
  try {
    const failed = data.error !== undefined;
    await prisma.cronHeartbeat.upsert({
      where: { jobName },
      create: {
        jobName,
        lastStartedAt: data.startedAt,
        lastFinishedAt: data.finishedAt ?? null,
        lastError: failed ? describeError(data.error) : null,
        lastErrorAt: failed ? new Date() : null,
      },
      update: data.finishedAt
        ? {
            lastFinishedAt: data.finishedAt,
            // Una corrida que termina bien limpia el error; una que falla lo
            // deja con su fecha.
            ...(failed
              ? { lastError: describeError(data.error), lastErrorAt: new Date() }
              : { lastError: null, lastErrorAt: null }),
          }
        : { lastStartedAt: data.startedAt },
    });
  } catch (e) {
    console.error(`No se pudo anotar el latido de ${jobName}:`, e);
  }
}

/**
 * Para los errores que un job atrapa por su cuenta (el try/catch por clínica):
 * los registra como evento, con la clínica, y sigue. Sin esto el log era el
 * único rastro de que a una clínica puntual no le salieron los recordatorios.
 */
export async function reportJobError(
  jobName: string,
  context: string,
  error: unknown,
  clinicId?: string
): Promise<void> {
  console.error(`${context}:`, error);
  await recordSystemEvent({
    kind: SYSTEM_EVENT_KINDS.CRON_ERROR,
    clinicId,
    message: `${jobName}: ${context}: ${describeError(error)}`,
  });
}
