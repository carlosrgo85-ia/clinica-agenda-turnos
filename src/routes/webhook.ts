import { Router } from "express";
import { env } from "../config/env";
import { runAgentTurn } from "../services/agent-turn";
import { extractAdSourceId, recordCampaignContact } from "../services/campaigns";
import { findClinicByPhoneNumberId } from "../repositories/clinics.repository";
import { getOrCreateConversationPatient } from "../repositories/patients.repository";
import {
  DEBOUNCE_MS,
  claimConversationBatch,
  enqueueInboundMessage,
  joinBatch,
  sleep,
} from "../services/inbound-queue";
import { describeError, recordSystemEvent, SYSTEM_EVENT_KINDS } from "../services/system-events";

export const webhookRouter = Router();

webhookRouter.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === env.whatsappVerifyToken) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

webhookRouter.post("/", async (req, res) => {
  res.sendStatus(200);

  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];

  /**
   * Deja rastro de TODA entrega de Meta, antes de cualquier filtro.
   *
   * Va primero a propósito: si se loguea después de descartar lo que no es
   * texto, un acuse de recibo o un mensaje de audio no dejan rastro, y
   * entonces "Meta nunca nos llamó" y "nos llamó y lo descartamos" se ven
   * exactamente igual. Distinguir esas dos cosas es lo primero que hace
   * falta cuando el bot no contesta: la causa más común es de
   * configuración (callback URL mal cargada, WABA sin suscribir a la app) y
   * no deja ningún error en ningún lado.
   */
  console.log(
    JSON.stringify({
      evento: "webhook_recibido",
      phoneNumberId: value?.metadata?.phone_number_id ?? null,
      tipo: message?.type ?? (value?.statuses ? "status" : "sin_mensaje"),
    })
  );

  if (!message || message.type !== "text") return;

  const phoneNumberId: string | undefined = value?.metadata?.phone_number_id;
  if (!phoneNumberId) return;

  const clinic = await findClinicByPhoneNumberId(phoneNumberId);
  if (!clinic || !clinic.active) {
    console.warn(`Mensaje recibido de un número no registrado: ${phoneNumberId}`);
    return;
  }

  const from: string = message.from;
  const text: string = message.text.body;

  /**
   * ¿Llegó por una campaña o promoción? Se detecta ANTES de encolar, así el contacto ya existe cuando el
   * turno arranca y el asistente sabe por qué escribe. El origen sale de dos lados: el anuncio
   * "Click-to-WhatsApp" de Meta (`referral.source_id`, no depende de lo que escriba el paciente) o una frase
   * del texto prellenado de otro canal. **Nunca puede tumbar el mensaje**: si falla, se atiende igual.
   */
  try {
    await recordCampaignContact({
      clinicId: clinic.id,
      phone: from,
      text,
      adSourceId: extractAdSourceId(message),
    });
  } catch (error) {
    console.error(`No se pudo registrar el origen de campaña del mensaje (clínica ${clinic.id}):`, error);
  }

  /**
   * El mensaje no se contesta acá mismo: se encola y se espera a ver si el
   * paciente sigue escribiendo, porque una sola idea suele venir partida en
   * varios mensajes. Ver `services/inbound-queue.ts`.
   *
   * La respuesta HTTP a Meta ya salió arriba, así que esta espera no retiene
   * a nadie — tampoco una conexión de Prisma ni una transacción.
   */
  let encolado;
  try {
    encolado = await enqueueInboundMessage({ clinicId: clinic.id, patientPhone: from, text });
  } catch (error) {
    console.error(`No se pudo encolar el mensaje de la clínica ${clinic.id}:`, error);
    return;
  }

  await sleep(DEBOUNCE_MS);

  try {
    const batch = await claimConversationBatch({
      clinicId: clinic.id,
      patientPhone: from,
      // El mensaje propio, no un corte contra el reloj: si llegó algo después
      // de éste, el lote lo junta el intento de ese otro.
      notNewerThan: encolado.receivedAt,
    });
    // Vacío = el paciente siguió escribiendo y el lote lo va a juntar el
    // intento de un mensaje posterior, o ya se lo llevó otra instancia.
    if (batch.length === 0) return;

    console.log(
      JSON.stringify({
        evento: "lote_de_mensajes",
        clinicId: clinic.id,
        mensajes: batch.length,
      })
    );

    const patient = await getOrCreateConversationPatient(clinic.id, from);
    await runAgentTurn({ clinic, patient, from, text: joinBatch(batch) });
  } catch (error) {
    console.error(`Error procesando mensaje de la clínica ${clinic.id}:`, error);
    // El lote ya salió de la cola, así que si el turno murió acá el paciente
    // se quedó sin respuesta y nada más lo va a rescatar: que al menos quede
    // a la vista en "Monitoreo". Sin texto ni teléfono, a propósito.
    await recordSystemEvent({
      kind: SYSTEM_EVENT_KINDS.MENSAJE_SIN_PROCESAR,
      clinicId: clinic.id,
      message: describeError(error),
    });
  }
});
