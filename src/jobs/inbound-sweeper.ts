import { trackedCron } from "./tracked-cron";
import { prisma } from "../db/client";
import { runAgentTurn } from "../services/agent-turn";
import { CLINIC_CALENDAR_INCLUDE } from "../services/calendar";
import { getOrCreateConversationPatient } from "../repositories/patients.repository";
import { claimConversationBatch, joinBatch } from "../services/inbound-queue";

/**
 * Contesta los mensajes que quedaron encolados sin que nadie los levante.
 *
 * El camino normal es el del webhook: encola, espera unos segundos y contesta
 * el lote (`services/inbound-queue.ts`). Esa espera vive en el proceso web,
 * así que si la instancia se cae o la matan en medio —un deploy con rolling
 * restart lo hace de rutina— las filas quedan en la tabla y el paciente no
 * recibe nada. Este job es la red: cada minuto busca pendientes viejos y los
 * procesa.
 *
 * Es recuperación, no el camino principal: con el worker apagado los
 * pacientes se siguen atendiendo normalmente, y lo único que se pierde es el
 * rescate de lo que dejó una instancia caída.
 */

/**
 * Desde cuándo un pendiente se considera abandonado.
 *
 * Tiene que ser bastante mayor que `DEBOUNCE_MS` + `MAX_WAIT_MS` del
 * inbound-queue: si fuera parecido, el barrido le robaría el lote a un
 * webhook que todavía está esperando, y el paciente recibiría la respuesta
 * partida — justo lo que esto viene a evitar.
 */
export const ABANDONED_AFTER_MS = 2 * 60_000;

/** Inyectable para poder probar el barrido sin llamar al modelo. */
export type RunTurn = typeof runAgentTurn;

export function scheduleInboundSweeper(): void {
  // `trackedCron` ya envuelve todo en un try/catch (incluida la query que trae
  // los pendientes): una promesa rechazada que escape de acá mata el proceso
  // entero y con él a los otros jobs.
  trackedCron("inbound-sweeper", "* * * * *", () => sweepAbandonedInbound());
}

export async function sweepAbandonedInbound(
  now: Date = new Date(),
  runTurn: RunTurn = runAgentTurn
): Promise<void> {
  const cutoff = new Date(now.getTime() - ABANDONED_AFTER_MS);

  // Agrupado: lo que importa es qué conversaciones tienen algo viejo, no
  // cuántas filas. Después se levanta el lote completo de cada una.
  const conversaciones = await prisma.pendingInboundMessage.groupBy({
    by: ["clinicId", "patientPhone"],
    where: { receivedAt: { lte: cutoff } },
  });

  for (const conversacion of conversaciones) {
    // Una conversación que falla no puede dejar sin contestar a las que
    // faltaban recorrer.
    try {
      await sweepConversation(conversacion.clinicId, conversacion.patientPhone, runTurn);
    } catch (error) {
      console.error(
        `No se pudo rescatar la conversación ${conversacion.patientPhone} de la clínica ${conversacion.clinicId}:`,
        error
      );
    }
  }
}

async function sweepConversation(
  clinicId: string,
  patientPhone: string,
  runTurn: RunTurn
): Promise<void> {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    include: { ...CLINIC_CALENDAR_INCLUDE, plan: true },
  });

  // Una clínica dada de baja con mensajes colgando: se descartan, si no
  // quedan para siempre y el barrido los reintenta cada minuto.
  if (!clinic || !clinic.active) {
    await prisma.pendingInboundMessage.deleteMany({ where: { clinicId, patientPhone } });
    return;
  }

  // El mismo claim que usa el webhook: si justo lo levantó una instancia
  // viva, acá llegan cero filas y no se contesta dos veces.
  //
  // `notNewerThan` es el umbral de abandono y no "ahora": si mientras tanto
  // llegó un mensaje nuevo, hay un webhook vivo esperándolo y el lote es
  // suyo. Rescatar solo lo que nadie está mirando.
  const batch = await claimConversationBatch({
    clinicId,
    patientPhone,
    notNewerThan: new Date(Date.now() - ABANDONED_AFTER_MS),
  });
  if (batch.length === 0) return;

  console.warn(
    JSON.stringify({
      evento: "lote_rescatado",
      clinicId,
      mensajes: batch.length,
      masViejo: batch[0].receivedAt.toISOString(),
    })
  );

  const patient = await getOrCreateConversationPatient(clinicId, patientPhone);
  await runTurn({ clinic, patient, from: patientPhone, text: joinBatch(batch) });
}
