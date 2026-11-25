import { env } from "../config/env";
import { randomUUID } from "node:crypto";
import { describeRecentCancellations } from "../prompts/appointments-context";
import {
  attachCancellationReason,
  cleanCancelReason,
  findRecentCancellationsWithoutReason,
} from "./appointment-events";
import { recordAppointmentEvent } from "./appointment-events";
import { describePatientHistories } from "../prompts/patient-history-context";
import { loadPatientHistories } from "./patient-history";
import { prisma } from "../db/client";
import {
  createEscalation,
  markEscalationNotified,
  toEscalationReason,
} from "../repositories/escalations.repository";
import { sendEscalationAlert } from "./email";
import { formatAvailableSlots } from "../prompts/availability-context";
import { describePeople, type PersonForPrompt } from "../prompts/appointments-context";
import { buildLocationMessage } from "./location";
import { buildAssistantIntroMessage, buildPrivacyNoticeMessage } from "./privacy-notice";
import { recordSystemAudit } from "./audit";
import {
  appendConversationMessage,
  getRecentConversation,
  type ClinicWithCalendarAccount,
} from "../repositories/clinics.repository";
import {
  findPatientsByPhone,
  resolvePatientForBooking,
  applyBookingPhones,
  setPatientName,
  correctPatientName,
  updatePatientStage,
} from "../repositories/patients.repository";
import { listActiveInsurersForClinic } from "../repositories/insurers.repository";
import { findSlotsForPatient, type AvailableSlotsResult } from "./availability-slots";
import { matchRequestedProfessional } from "./professional-match";
import { avisarPorWhatsApp } from "../jobs/config-alerts";
import { describeProfessionalLabel } from "../prompts/professional-label";
import { createAppointmentFromRequest, describeBookingFailure } from "./booking";
import {
  campaignExtraProfessionalIds,
  getCampaignContextForPhone,
  listVigentCampaigns,
  markLeadConverted,
  recordCampaignMention,
  type CampaignContext,
} from "./campaigns";
import { describeActivePromotions, describeCampaignContext } from "../prompts/campaign-context";
import { dateKeyOf, patientNameParts } from "./patient-admin";
import { clinicDateKey } from "./time";
import { isFirstTimePatient } from "./booking-rules";
import {
  PROFESSIONAL_CALENDAR_INCLUDE,
  removeMirroredEvent,
  resolveCalendarTargetForProfessional,
} from "./calendar";
import { interpretPatientMessage } from "./claude";
import { buildEscalationSummary } from "./escalation";
import { clinicWhatsAppCreds, sendTextMessage } from "./whatsapp";
import { reclaimRequeuedMessage, requeueMessageForRetry, sleep } from "./inbound-queue";
import type { ClaudeAgentResponse } from "../types";
import type { Patient } from "@prisma/client";
import { describeError, recordSystemEvent, SYSTEM_EVENT_KINDS } from "./system-events";

/**
 * Un turno de conversación completo: desde el mensaje del paciente hasta la
 * respuesta enviada.
 *
 * Vive acá y no en `routes/webhook.ts` por el mismo motivo que
 * `createAppointmentFromRequest` vive en `booking.ts`: el webhook tiene que
 * ser ruteo, y esto necesita poder testearse sin levantar Express ni pegarle
 * a la API de Anthropic — de ahí el objeto `deps`.
 *
 * El agente llama a Claude DOS veces cuando hace falta consultar la agenda:
 * la primera interpreta el mensaje y avisa que necesita horarios, y la
 * segunda redacta la respuesta final ya con los huecos reales a la vista. Es
 * el diseño original del proyecto (ver docs/system_prompt_clinica_dental.md);
 * los parámetros `horariosDisponibles` de `interpretPatientMessage` estaban
 * esperando esto desde el principio.
 */

export interface AgentTurnDeps {
  interpret: typeof interpretPatientMessage;
  findSlots: typeof findSlotsForPatient;
  send: typeof sendTextMessage;
  book: typeof createAppointmentFromRequest;
  /**
   * Espera antes de reintentar la primera llamada al modelo. Inyectable para
   * que los tests no esperen 30 segundos.
   */
  retryDelayMs?: number;
  /**
   * Respaldo del mensaje mientras se espera el reintento: sin él, un proceso que muere en esos
   * segundos pierde el mensaje (el lote ya salió de la cola). Opcional para que los tests que no
   * lo prueban no toquen la cola.
   */
  respaldo?: {
    guardar: typeof requeueMessageForRetry;
    reclamar: typeof reclaimRequeuedMessage;
  };
  /**
   * **Chat de pruebas** (`services/sandbox.ts`). Con esto el turno no deja ningún efecto hacia afuera: no se crea la
   * derivación ni se avisa por mail ni por WhatsApp (se deja una nota en `notas` para mostrarla en el chat), y no se
   * registran eventos de monitoreo del catálogo. La reserva se aísla aparte, con `skipExternalEffects`.
   */
  sandbox?: SandboxCollector;
}

/** Lo que el turno le cuenta al chat de pruebas en lugar de hacerlo de verdad. */
export interface SandboxCollector {
  notas: string[];
}

/**
 * Cuánto se espera antes de reintentar si falla la primera llamada a Claude.
 * Las fallas típicas (429, 529, timeout) son pasajeras y 15 segundos le dan
 * margen a la API. Es un compromiso: más espera aumenta la chance de que el
 * reintento salga bien, pero también la ventana en que, si el proceso muere,
 * el lote ya salió de la cola; por eso durante la espera se deja un respaldo
 * del mensaje en la cola (`deps.respaldo`) que el barrido rescata.
 */
export const MODEL_RETRY_DELAY_MS = 15_000;

/**
 * Se manda antes de esperar el reintento, para que el paciente no vea 15
 * segundos de silencio. Fijo y en español neutro, como la disculpa.
 */
export const AVISO_DE_ESPERA = "Un momento, por favor, estoy revisando su mensaje.";

/**
 * Lo que se le dice al paciente cuando el modelo falló dos veces. Fijo y en
 * español neutro: no pasa por el modelo, que es justamente lo que está caído.
 */
export const DISCULPA_POR_FALLA =
  "Disculpe, tuvimos un problema para procesar su mensaje. " +
  "Una persona de nuestro equipo se va a contactar con usted a la brevedad.";

export const defaultAgentTurnDeps: AgentTurnDeps = {
  interpret: interpretPatientMessage,
  findSlots: findSlotsForPatient,
  send: sendTextMessage,
  book: createAppointmentFromRequest,
  respaldo: { guardar: requeueMessageForRetry, reclamar: reclaimRequeuedMessage },
};

/**
 * Lo que sí o sí tiene que valer después de la segunda interpretación, más
 * allá de lo que haya devuelto el modelo.
 *
 * El prompt también pide estas cosas, pero un prompt es probabilístico y esto
 * son invariantes: acá se imponen por código.
 */
export function applyAvailabilityGuards(
  primera: ClaudeAgentResponse,
  segunda: ClaudeAgentResponse,
  slots: AvailableSlotsResult
): ClaudeAgentResponse {
  return {
    ...segunda,
    // Solo se confirma un horario que esté realmente libre y que el modelo
    // haya nombrado completo. Es más fuerte que "nunca confirmar en el mensaje
    // en que se ofrecen horarios": ese criterio bloqueaba al paciente que
    // elige una opción y el modelo, de paso, revisa la agenda — cosa que pasa
    // seguido y dejaba turnos confirmados de palabra que nunca se creaban.
    confirmacion_explicita: segunda.confirmacion_explicita && eligioUnHuecoReal(segunda, slots),
    // Anti-loop: una sola consulta de agenda por mensaje entrante.
    requiere_horarios_disponibles: false,
    // Si el paciente pidió un profesional en el primer mensaje y la segunda
    // respuesta no lo repite, no se pierde.
    profesional_solicitado: segunda.profesional_solicitado ?? primera.profesional_solicitado,
    // El escalamiento nunca se pierde por el camino.
    escalar_a_humano: primera.escalar_a_humano || segunda.escalar_a_humano,
    // Tampoco el pedido de la dirección: "quiero un turno, ¿dónde quedan?" lo
    // marca la primera, y la segunda —que solo ve los horarios— no tiene por
    // qué repetirlo.
    pidio_ubicacion: primera.pidio_ubicacion || segunda.pidio_ubicacion,
    motivo_escalar: primera.escalar_a_humano
      ? primera.motivo_escalar
      : segunda.motivo_escalar,
  };
}

/**
 * ¿El horario que dice el modelo es uno de los que estaban libres?
 *
 * No alcanza con que venga fecha y hora: el modelo podría inventarlas. Tienen
 * que coincidir textualmente con un hueco calculado contra la agenda.
 */
function eligioUnHuecoReal(
  respuesta: ClaudeAgentResponse,
  slots: AvailableSlotsResult
): boolean {
  const { fecha_solicitada: fecha, hora_solicitada: hora } = respuesta;
  if (!fecha || !hora) return false;

  return slots.days.some(
    (day) => day.dateKey === fecha && day.slots.some((slot) => slot.time === hora)
  );
}

export async function runAgentTurn(
  input: {
    clinic: ClinicWithCalendarAccount;
    patient: Patient;
    /** Teléfono del paciente, tal como llegó en el webhook. */
    from: string;
    text: string;
  },
  deps: AgentTurnDeps = defaultAgentTurnDeps
): Promise<void> {
  const { clinic, patient, from, text } = input;
  // Agrupa las llamadas al modelo que salen de ESTE mensaje entrante (la primera, el
  // reintento, la segunda con los horarios, la explicación de un fallo): `AgentRequest`.
  const turnId = randomUUID();

  if (patient.stage === "nuevo_contacto") {
    await updatePatientStage(patient.id, "interesado", { origin: "whatsapp", motivo: "primer_mensaje" });
  }

  const history = await getRecentConversation(clinic.id, from);
  const conversationHistory = history
    .map((m) => `${m.role === "patient" ? "Paciente" : "Asistente"}: ${m.content}`)
    .join("\n");

  // Una sola lectura por turno de conversación, no una por llamada al modelo.
  const servicios = await prisma.service.findMany({
    where: { clinicId: clinic.id, active: true },
    orderBy: { name: "asc" },
    select: { name: true, durationMinutes: true, priceNote: true },
  });

  // Solo los nombres: qué cubre cada plan no se le informa al modelo nunca
  // (ver `prompts/insurers-context.ts`).
  const seguros = await listActiveInsurersForClinic(clinic.id);

  /**
   * Los profesionales activos: de acá copia el modelo `profesional_solicitado`
   * y contra esta misma lista se resuelve a un id. Mismo orden que el
   * enumerador de huecos.
   */
  const profesionalesActivos = await prisma.professional
    .findMany({
      where: { clinicId: clinic.id, active: true },
      orderBy: { id: "asc" },
      select: { id: true, name: true, title: { select: { name: true } } },
    })
    .then((rows) => rows.map((p) => ({ id: p.id, name: p.name, title: p.title?.name ?? null })));
  const profesionales = profesionalesActivos.map((p) => describeProfessionalLabel(p.name, p.title));

  /**
   * Quién hace qué. Solo cuando la clínica tiene catálogo: sin él no hay
   * restricción y el prompt no dice nada. `servicioPrimeraVez` es el
   * diagnóstico inicial (si marcó uno): el paciente nuevo parte por ahí.
   */
  const catalogoConProfesionales = await prisma.service.findMany({
    where: { clinicId: clinic.id, active: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, firstVisit: true, professionals: { select: { id: true } } },
  });
  const serviciosPorProfesional =
    catalogoConProfesionales.length === 0
      ? []
      : profesionalesActivos.map((p) => {
          const hace = catalogoConProfesionales
            .filter((svc) => svc.professionals.some((x) => x.id === p.id))
            .map((svc) => svc.name);
          return `${describeProfessionalLabel(p.name, p.title)}: ${hace.length ? hace.join(", ") : "ninguno por ahora"}`;
        });
  const servicioPrimeraVez = catalogoConProfesionales.find((svc) => svc.firstVisit)?.name ?? null;

  /**
   * Las personas de este WhatsApp con sus turnos.
   *
   * Un número suele ser de una familia, así que se traen TODAS las fichas
   * —no solo la del titular—: si no, quien escribe pregunta "¿qué citas
   * tenemos?" y no ve la de su papá. Solo los turnos que todavía no pasaron
   * y que siguen en pie: sobre uno cancelado o ya atendido no hay nada que
   * hacer, y ofrecerle al modelo cancelar algo que ya ocurrió lo lleva a
   * prometer cosas que `booking.ts` después rechaza.
   */
  const personasDelNumero = await findPatientsByPhone(clinic.id, from);
  const turnosDelNumero = await prisma.appointment.findMany({
    where: {
      clinicId: clinic.id,
      patientId: { in: personasDelNumero.map((p) => p.id) },
      status: "confirmado",
      startTime: { gte: new Date() },
    },
    orderBy: { startTime: "asc" },
    select: {
      id: true,
      patientId: true,
      startTime: true,
      service: true,
      professional: { select: { name: true, title: { select: { name: true } } } },
    },
  });
  // Primera vez POR PERSONA: alguien con cualquier cita, aunque esté cancelada
  // o ya atendida, no es nuevo. Es lo que el código usa para decidir el
  // servicio de primera vez, así que el modelo tiene que verlo igual — si no,
  // dice "agendo la extracción" y el sistema agenda el diagnóstico inicial.
  const conHistorial = new Set(
    (
      await prisma.appointment.groupBy({
        by: ["patientId"],
        where: { clinicId: clinic.id, patientId: { in: personasDelNumero.map((p) => p.id) } },
      })
    ).map((r) => r.patientId)
  );
  const personas: PersonForPrompt[] = personasDelNumero.map((p) => ({
    id: p.id,
    name: p.name,
    esTitular: p.id === patient.id,
    appointments: turnosDelNumero.filter((t) => t.patientId === p.id),
    primeraVez: !conHistorial.has(p.id) && !p.priorHistory,
  }));
  const turnosPaciente = describePeople(personas, clinic.timezone);
  // Qué se le hizo a cada persona, su próxima cita sugerida y las notas internas:
  // es lo que permite recordarle su tratamiento, preguntarle cómo le fue y
  // proponerle una nueva cita. Solo las personas de ESTE número.
  // Las cancelaciones recientes de este número que todavía no tienen motivo: lo que
  // permite registrar el motivo cuando llega en un mensaje POSTERIOR a la cancelación.
  const canceladasSinMotivo = describeRecentCancellations(
    await findRecentCancellationsWithoutReason({
      clinicId: clinic.id,
      patientIds: personasDelNumero.map((p) => p.id),
    }),
    clinic.timezone
  );
  const historialPersonas = describePatientHistories(
    await loadPatientHistories({
      clinicId: clinic.id,
      patientIds: personasDelNumero.map((p) => p.id),
      timezone: clinic.timezone,
    })
  );

  /**
   * La campaña o promoción por la que llegó este número (si llegó por una). Es lo que se le cuenta al
   * asistente, lo que se le atribuye a la cita que saque y lo que puede sumarle profesionales al servicio
   * de la promoción. **Nunca puede tumbar el turno**: sin ella se atiende como cualquier mensaje.
   */
  let campaignCtx: CampaignContext | null = null;
  try {
    campaignCtx = await getCampaignContextForPhone({ clinicId: clinic.id, phone: from, timezone: clinic.timezone });
  } catch (error) {
    console.error(`No se pudo leer la campaña del número (clínica ${clinic.id}):`, error);
  }
  /** Quiénes atienden el servicio de una campaña: los del catálogo MÁS los que la campaña suma (si está vigente). */
  const atiendenLaCampana = (campaign: CampaignContext["campaign"]): string[] => {
    const delServicio = campaign.serviceId
      ? (catalogoConProfesionales.find((svc) => svc.id === campaign.serviceId)?.professionals.map((p) => p.id) ?? [])
      : [];
    const extras = campaign.serviceId
      ? campaignExtraProfessionalIds(campaign, campaign.serviceId, clinicDateKey(new Date(), clinic.timezone))
      : [];
    const atienden = new Set([...delServicio, ...extras]);
    return profesionalesActivos.filter((p) => atienden.has(p.id)).map((p) => describeProfessionalLabel(p.name, p.title));
  };
  const promptDeCampana = (ctx: CampaignContext | null): string =>
    describeCampaignContext(
      ctx
        ? {
            name: ctx.campaign.name,
            channel: ctx.campaign.channel,
            description: ctx.campaign.description,
            status: ctx.status,
            startsOn: dateKeyOf(ctx.campaign.startsOn),
            endsOn: dateKeyOf(ctx.campaign.endsOn),
            serviceName: ctx.campaign.service?.active ? ctx.campaign.service.name : null,
            professionals: atiendenLaCampana(ctx.campaign),
          }
        : null
    );

  // Se pueden reasignar: si el asistente reconoce la campaña por lo que dijo la persona (más abajo), el resto del turno ya
  // la tiene en cuenta (el contexto, los horarios y la reserva).
  let campaignId = campaignCtx?.campaign.id ?? null;
  let campana = promptDeCampana(campaignCtx);

  /**
   * Las promociones que hoy rigen, para que el asistente reconozca a cuál se refiere quien no escribió la frase exacta de ningún
   * formato ("vengo por la promo de implantes"). Solo las vigentes. Nunca puede tumbar el turno.
   */
  let promocionesVigentes: Awaited<ReturnType<typeof listVigentCampaigns>> = [];
  try {
    promocionesVigentes = await listVigentCampaigns(clinic.id, clinic.timezone);
  } catch (error) {
    console.error(`No se pudieron leer las promociones vigentes (clínica ${clinic.id}):`, error);
  }
  const promociones = describeActivePromotions(
    promocionesVigentes.map((c) => ({
      name: c.name,
      description: c.description,
      serviceName: c.service?.active ? c.service.name : null,
      professionals: atiendenLaCampana(c),
    }))
  );

  // El horario que el bot le cuenta al paciente sale de la MISMA tabla que
  // valida `booking.ts`. Solo los tramos de la clínica: los de cada
  // profesional recortan hacia adentro y no son lo que se anuncia.
  const workingHours = await prisma.workingHours.findMany({
    where: { clinicId: clinic.id, professionalId: null },
  });

  /*
   * "Primera vez" para el prompt es que NADIE de este número haya venido
   * nunca: es lo que decide si el bot explica la política del profesional
   * principal. Quién la cumple de verdad lo decide `booking.ts` con la
   * persona concreta del turno, que recién se sabe después de interpretar.
   */
  const turnosHistoricos = await prisma.appointment.count({
    where: { clinicId: clinic.id, patientId: { in: personasDelNumero.map((p) => p.id) } },
  });
  const esPrimeraVez = turnosHistoricos === 0;

  const interpretarPrimera = (attempt: number) =>
    deps.interpret({
      clinic,
      patientMessage: text,
      conversationHistory,
      turnosPaciente,
      historialPersonas,
      canceladasSinMotivo,
      campana,
      promociones,
      trace: { turnId, kind: "interpretacion", attempt, patientId: patient.id },
      esPrimeraVez,
      servicios,
      workingHours,
      seguros,
      profesionales,
      serviciosPorProfesional,
      servicioPrimeraVez,
    });

  /**
   * Un reintento tras una espera, y si vuelve a fallar se disculpa y se
   * deriva a una persona. Antes el error subía hasta el webhook, que solo lo
   * logueaba: el paciente quedaba en visto y, como el lote ya estaba borrado
   * de la cola, ni el barrido de `inbound-sweeper` lo rescataba.
   *
   * Se reintenta SOLO esta llamada y no el turno entero: hasta acá no se
   * escribió nada, así que repetirla no puede duplicar un turno ni el
   * historial.
   */
  let primera: ClaudeAgentResponse;
  try {
    primera = await interpretarPrimera(1);
  } catch (firstError) {
    console.error(
      `Falló la interpretación de la clínica ${clinic.id}, se reintenta:`,
      firstError
    );
    await recordSystemEvent({
      kind: SYSTEM_EVENT_KINDS.MODELO_FALLO,
      severity: "warning",
      clinicId: clinic.id,
      message: `Primer intento: ${describeError(firstError)}`,
    });
    // Si falla el envío no pasa nada: es solo cortesía y el reintento sigue.
    try {
      await deps.send(clinicWhatsAppCreds(clinic), from, AVISO_DE_ESPERA);
    } catch (error) {
      console.error(`No se pudo enviar el aviso de espera (clínica ${clinic.id}):`, error);
    }

    // El lote ya salió de la cola: si el proceso muere durante la espera, el mensaje se perdería y
    // el paciente quedaría con un "dame un momento" y nada más. Se deja un respaldo en la cola para
    // que el barrido lo rescate, y se reclama al volver. Si no se puede guardar, se sigue sin él:
    // es lo que pasaba antes y no puede impedir el reintento.
    let respaldoId: string | null = null;
    try {
      respaldoId = (await deps.respaldo?.guardar({ clinicId: clinic.id, patientPhone: from, text })) ?? null;
    } catch (error) {
      console.error(`No se pudo dejar el respaldo del mensaje (clínica ${clinic.id}):`, error);
    }

    await sleep(deps.retryDelayMs ?? MODEL_RETRY_DELAY_MS);

    if (respaldoId && deps.respaldo) {
      let esMio = true;
      try {
        esMio = await deps.respaldo.reclamar(respaldoId);
      } catch (error) {
        // Sin poder confirmar, se sigue: contestar de más es mejor que no contestar.
        console.error(`No se pudo reclamar el respaldo del mensaje (clínica ${clinic.id}):`, error);
      }
      if (!esMio) {
        // Lo tomó el barrido o el turno de un mensaje nuevo que lo juntó en su lote: ese turno lo
        // va a contestar. Seguir acá duplicaría la respuesta.
        console.warn(JSON.stringify({ evento: "reintento_cedido", clinicId: clinic.id }));
        return;
      }
    }

    try {
      primera = await interpretarPrimera(2);
    } catch (secondError) {
      console.error(
        `Falló de nuevo la interpretación de la clínica ${clinic.id}, se deriva:`,
        secondError
      );
      await recordSystemEvent({
        kind: SYSTEM_EVENT_KINDS.MODELO_FALLO,
        clinicId: clinic.id,
        message: `Falló dos veces, se derivó a una persona: ${describeError(secondError)}`,
      });
      await atenderFallaDelModelo({ clinic, patient, from, text, deps, error: secondError });
      return;
    }
  }

  let agentResponse = primera;
  // Ya se derivó por un servicio sin cubrir: que no se registre dos veces si
  // además el modelo marca `escalar_a_humano`.
  let servicioSinCubrir = false;

  /**
   * ¿Habla de una promoción vigente aunque el mensaje no traiga la frase de ningún formato? El asistente devuelve el nombre de la
   * promoción y el código lo resuelve contra las vigentes (un nombre que no figure no atribuye nada). Recién ahí el contacto
   * existe y el resto del turno —el contexto, los horarios y la reserva— ya tiene la campaña. Solo si todavía no se había
   * atribuido por un formato. Nunca puede tumbar el turno.
   */
  if (!campaignCtx && primera.campana_mencionada) {
    try {
      const reconocida = await recordCampaignMention({
        clinicId: clinic.id,
        phone: from,
        campaignName: primera.campana_mencionada,
        timezone: clinic.timezone,
        // Primer mensaje de ese número, sin conversación ni citas: un contacto nuevo.
        isNewContact: history.length === 0 && esPrimeraVez,
      });
      if (reconocida) {
        campaignCtx = await getCampaignContextForPhone({ clinicId: clinic.id, phone: from, timezone: clinic.timezone });
        campaignId = campaignCtx?.campaign.id ?? null;
        campana = promptDeCampana(campaignCtx);
      }
    } catch (error) {
      console.error(`No se pudo registrar la campaña que mencionó la persona (clínica ${clinic.id}):`, error);
    }
  }

  // Solo si el titular todavía no tiene nombre: `nombre_paciente` es cómo se
  // llama QUIEN ESCRIBE. Pisar un nombre ya cargado con el de otro es
  // exactamente el bug que esto viene a arreglar — ver `paciente_del_turno`.
  if (primera.nombre_paciente && !patient.name) {
    await setPatientName(patient.id, primera.nombre_paciente, primera.apellido_paciente);
  } else if (primera.corrige_nombre && primera.nombre_paciente && patient.name) {
    // Corrección explícita de quien escribe ("te di mi nombre mal, es María"): el modelo la marca y el código la aplica solo
    // sobre la ficha del titular de este número. Sin la marca, un nombre ya cargado no se pisa. Nunca puede tumbar el turno.
    try {
      // Si no vino el apellido se conserva el de la ficha: corregir "Maía" a "María" no puede borrar "Bolivar".
      await correctPatientName(
        patient,
        primera.nombre_paciente,
        primera.apellido_paciente || patientNameParts(patient).lastName || null
      );
    } catch (error) {
      console.error(`No se pudo corregir el nombre de la ficha (clínica ${clinic.id}):`, error);
    }
  }

  /**
   * De quién es el turno. Se resuelve ANTES de buscar huecos, no al agendar:
   * si el turno es para una persona nueva, la regla de primera vez la manda
   * con el profesional principal, y los horarios que se ofrecen tienen que
   * ser los de él. Resolviéndolo después se le ofrecerían huecos de
   * cualquiera y el turno rebotaría al confirmar.
   */
  const pacienteDelTurno = await resolvePatientForBooking({
    clinicId: clinic.id,
    phone: from,
    nombre: primera.paciente_del_turno,
    apellido: primera.apellido_paciente_del_turno,
    titular: patient,
  });

  // Una urgencia no se resuelve ofreciendo turnos, así que no se consulta la
  // agenda ni se gasta una segunda llamada. Mismo criterio que
  // `buildEscalationSummary`, que tampoco vuelve a llamar al modelo.
  // Reprogramar: la cita a mover, ya acotada a las personas de este número. Si
  // existe, los horarios se buscan para SU persona, con SU servicio y SU
  // profesional por default, y sin contarla como ocupada.
  const turnoAMoverPrimera = esReprogramacion(primera)
    ? await buscarTurnoVigente(clinic.id, primera.turno_a_modificar, personasDelNumero.map((p) => p.id))
    : null;

  if (primera.requiere_horarios_disponibles && !primera.escalar_a_humano) {
    const slots = await buscarHuecos({
      clinic,
      patient: turnoAMoverPrimera?.patient ?? pacienteDelTurno,
      agentResponse: primera,
      requestedService: turnoAMoverPrimera?.service ?? primera.servicio,
      requestedProfessionalId:
        matchRequestedProfessional(primera.profesional_solicitado, profesionalesActivos) ??
        turnoAMoverPrimera?.professionalId ??
        null,
      excludeAppointmentId: turnoAMoverPrimera?.id ?? null,
      campaignId,
      findSlots: deps.findSlots,
    });

    // El servicio no es algo que la clínica ofrece, o nadie lo realiza: no hay
    // horarios que ofrecer. Se deriva a una persona (fila + mail + WhatsApp) y
    // el modelo, que ve el motivo en el bloque de horarios, se lo explica al
    // paciente. Es lo mismo que `equipo_fuera_de_servicio`: ofrecer otro
    // horario no arregla nada.
    if (slots.blocker === "servicio_no_ofrecido" || slots.blocker === "servicio_sin_profesional") {
      servicioSinCubrir = true;
      await registrarEscalamiento({
        sandbox: deps.sandbox,
        clinic,
        patient: pacienteDelTurno,
        from,
        text,
        agentResponse: { ...primera, motivo_escalar: "otro" },
        detalle: detalleServicioSinCubrir(slots.blocker, primera.servicio),
        servicioSinCubrir: { servicio: primera.servicio, motivo: slots.blocker },
      });
    }

    try {
      const segunda = await deps.interpret({
        clinic,
        patientMessage: text,
        conversationHistory,
        horariosDisponibles: formatAvailableSlots(slots),
        turnosPaciente,
        historialPersonas,
        canceladasSinMotivo,
        campana,
        promociones,
        trace: { turnId, kind: "reinterpretacion", attempt: 1, patientId: patient.id },
        esPrimeraVez,
        servicios,
        workingHours,
        seguros,
        profesionales,
        serviciosPorProfesional,
        servicioPrimeraVez,
      });
      agentResponse = applyAvailabilityGuards(primera, segunda, slots);
    } catch (error) {
      // Se envía lo que había armado la primera interpretación. No es la
      // respuesta ideal, pero el silencio es peor.
      console.error(`Falló la segunda interpretación de la clínica ${clinic.id}:`, error);
    }
  }

  /**
   * Una QUEJA al cancelar (la atención, la espera, el trato, el precio, un profesional) es
   * información de calidad que la clínica tiene que ver: siempre llega a una persona, aunque
   * el modelo se haya olvidado de marcar `escalar_a_humano`. Es la red de seguridad del
   * código sobre una regla del prompt, que es probabilística.
   */
  const motivoDeQueja = cleanCancelReason(agentResponse.motivo_cancelacion);
  if (agentResponse.motivo_es_queja && !agentResponse.escalar_a_humano) {
    agentResponse = { ...agentResponse, escalar_a_humano: true, motivo_escalar: "otro" };
  }

  if (agentResponse.escalar_a_humano && !servicioSinCubrir) {
    await registrarEscalamiento({
      sandbox: deps.sandbox,
      clinic,
      patient,
      from,
      text,
      agentResponse,
      detalle: agentResponse.motivo_es_queja
        ? `Queja al cancelar una cita${motivoDeQueja ? `: "${motivoDeQueja}"` : ""}. Se registró para calidad.`
        : undefined,
    });
  }

  // También con intent "confirmar": el prompt lo define como "está respondiendo
  // que sí a una propuesta de horario que ya le hiciste", que es
  // exactamente el mensaje en el que hay que crear el turno. Mirando solo
  // "agendar" el turno se confirmaba de palabra y no se creaba nunca.
  const intentDeReserva =
    agentResponse.intent === "agendar" ||
    agentResponse.intent === "confirmar" ||
    agentResponse.intent === "reprogramar";

  /**
   * La ubicación se manda como un mensaje aparte, después de la respuesta,
   * en dos casos: cuando el paciente la pide, y cuando acaba de sacar su
   * primer turno (quien ya vino sabe dónde queda). `esPrimeraVez` se calculó
   * al principio del turno, antes de crear este, así que sigue diciendo lo
   * que hace falta.
   *
   * El texto y el link los arma el código y no el modelo: una URL
   * reescrita es una URL que puede salir mal.
   */
  let mensajeDeUbicacion: string | null = agentResponse.pidio_ubicacion
    ? buildLocationMessage(clinic)
    : null;

  if (agentResponse.confirmacion_explicita && intentDeReserva) {
    // Reprogramar: se vuelve a buscar la cita con el id FINAL del modelo (el de
    // la segunda respuesta puede diferir del de la primera). Nunca por id solo:
    // acotada a la clínica y a las personas de este número.
    const reprograma = esReprogramacion(agentResponse);
    const turnoAMover = reprograma
      ? await buscarTurnoVigente(
          clinic.id,
          agentResponse.turno_a_modificar,
          personasDelNumero.map((p) => p.id)
        )
      : null;

    /**
     * **No se agenda sin el nombre y el apellido de la persona del turno.** El asistente primero los confirma y recién después
     * dice que quedó agendada: con el modelo marcando la confirmación apenas la persona eligió el horario, la cita se creaba a
     * nombre de nadie y el mensaje que pedía el nombre llegaba DESPUÉS de haberla agendado (2026-11-18); y al darlo, el segundo
     * intento chocaba con la cita recién creada. Se impone por código, no solo por el prompt. Se lee la ficha de la base y no el
     * objeto del turno porque el nombre pudo llegar en este mismo mensaje (`setPatientName` más arriba). Al reprogramar no
     * aplica: esa persona ya tiene una cita.
     */
    let faltaElNombre = false;
    if (!reprograma) {
      const leerFicha = () =>
        prisma.patient.findUnique({ where: { id: pacienteDelTurno.id }, select: { name: true, firstName: true, lastName: true } });
      const completa = (f: Awaited<ReturnType<typeof leerFicha>>) => {
        const partes = f ? patientNameParts(f) : { firstName: "", lastName: "" };
        return Boolean(partes.firstName.trim() && partes.lastName.trim());
      };
      let ficha = await leerFicha();
      // Si la ficha de quien escribe está sin nombre o a medias ("Juana" y falta el apellido), se completa con lo que el
      // modelo entendió en este mensaje: el nombre solo se cargaba cuando la ficha estaba vacía, y entonces un apellido
      // dado en un mensaje posterior nunca llegaba y se le pedía una y otra vez.
      if (!completa(ficha) && pacienteDelTurno.id === patient.id) {
        const nombre = agentResponse.nombre_paciente ?? primera.nombre_paciente;
        if (nombre) {
          await setPatientName(
            patient.id,
            nombre,
            agentResponse.apellido_paciente ?? primera.apellido_paciente
          );
          ficha = await leerFicha();
        }
      }
      faltaElNombre = !completa(ficha);
    }

    /**
     * Agendar para OTRA persona nueva: lo que se acordó sobre su número (con cuál se la registra y quién más queda
     * autorizado) se guarda en su ficha ANTES de crear la cita, para que los avisos salgan al número correcto. Solo aplica
     * a una ficha nueva sin citas (`applyBookingPhones`), nunca a la de quien escribe ni al reprogramar.
     */
    let pacienteConTelefonos = pacienteDelTurno;
    if (!reprograma && pacienteDelTurno.id !== patient.id && !faltaElNombre) {
      const registro = agentResponse.telefono_registro ?? primera.telefono_registro ?? null;
      const autorizado = agentResponse.telefono_autorizado ?? primera.telefono_autorizado ?? null;
      if (registro || autorizado) {
        try {
          pacienteConTelefonos = await applyBookingPhones({
            patient: pacienteDelTurno,
            writerPhone: from,
            registro,
            autorizado,
            sandbox: Boolean(deps.sandbox),
          });
        } catch (error) {
          console.error(`No se pudieron guardar los teléfonos de la persona del turno (clínica ${clinic.id}):`, error);
        }
      }
    }

    // Un id que no es una cita vigente de este número (alucinado, ajeno, ya
    // cancelado) no reprograma nada — y tampoco se agenda una cita nueva a
    // cambio, que duplicaría el turno.
    const booking: Awaited<ReturnType<typeof deps.book>> = faltaElNombre
      ? { ok: false, reason: "falta_nombre_y_apellido" }
      : reprograma && !turnoAMover
        ? { ok: false, reason: "turno_a_reprogramar_no_encontrado" }
        : await deps.book({
            clinic,
            // La persona del turno, no el titular: de acá sale a nombre de quién
            // queda el turno Y a quién se le aplica la regla de primera vez
            // (`resolveProfessionalForBooking` la evalúa con este `patient`). Al
            // reprogramar es la persona de la cita que se mueve.
            patient: turnoAMover?.patient ?? pacienteConTelefonos,
            requestedDate: agentResponse.fecha_solicitada,
            requestedTime: agentResponse.hora_solicitada,
            // Reprogramar cambia día, hora o profesional, no el servicio: el de la
            // cita que se mueve manda sobre lo que el modelo diga.
            requestedService: turnoAMover?.service ?? agentResponse.servicio,
            // Si el paciente pidió a alguien, se agenda con esa persona (la valida
            // `checkAvailability` dentro de la transacción como a cualquier otro).
            // Un nombre que no encaja con nadie —o con dos— queda en null y rige
            // el criterio por default: el primero libre. Al reprogramar, el
            // default es el mismo profesional de la cita que se mueve.
            requestedProfessionalId:
              matchRequestedProfessional(agentResponse.profesional_solicitado, profesionalesActivos) ??
              turnoAMover?.professionalId ??
              null,
            isUrgent: agentResponse.motivo_escalar === "urgencia",
            campaignId,
            replaceAppointmentId: turnoAMover?.id ?? null,
          });

    if (booking.ok) {
      // Vino por una campaña y agendó: el contacto pasa a "convertido" (y deja el seguimiento).
      if (campaignCtx) {
        await markLeadConverted(campaignCtx.lead, booking.appointment.id).catch((error) =>
          console.error(`No se pudo marcar como convertido el contacto de la campaña (clínica ${clinic.id}):`, error)
        );
      }
      await updatePatientStage((turnoAMover?.patient ?? pacienteDelTurno).id, "turno_agendado", {
        origin: "whatsapp",
        motivo: "turno_agendado",
      });

      // `??=`: si ya lo pidió explícitamente, no se calcula de nuevo ni se
      // manda dos veces.
      if (esPrimeraVez) mensajeDeUbicacion ??= buildLocationMessage(clinic);

      if (booking.mirrorError) {
        // El turno existe y es válido; lo que falló es que aparezca en la
        // agenda del profesional.
        console.error(
          `Cita ${booking.appointment.id} sin espejo en Calendar: ${booking.mirrorError}`
        );
      }
    } else {
      if (booking.reason !== "falta_nombre_y_apellido") {
        console.warn(
          `No se pudo agendar la cita pedida por ${from} en la clínica ${clinic.id}: ${describeBookingFailure(booking.reason)}`
        );
      }

      /**
       * El equipo que ese servicio necesita está fuera de servicio.
       *
       * Es el único motivo de fallo que NO se arregla ofreciendo otro
       * horario: mientras el equipo esté roto, ese servicio no se puede dar
       * a ninguna hora. Así que en vez de dejar al paciente rebotando contra
       * horarios que nunca van a funcionar, se deriva a una persona — que es
       * quien puede decirle cuándo vuelve a estar, u ofrecerle otra cosa.
       */
      if (
        (booking.reason === "servicio_no_ofrecido" ||
          booking.reason === "servicio_sin_profesional") &&
        !servicioSinCubrir
      ) {
        await registrarEscalamiento({
          sandbox: deps.sandbox,
          clinic,
          patient: pacienteDelTurno,
          from,
          text,
          agentResponse: { ...agentResponse, motivo_escalar: "otro" },
          detalle: detalleServicioSinCubrir(
            booking.reason === "servicio_no_ofrecido" ? "servicio_no_ofrecido" : "servicio_sin_profesional",
            agentResponse.servicio
          ),
          servicioSinCubrir: {
            servicio: agentResponse.servicio,
            motivo:
              booking.reason === "servicio_no_ofrecido"
                ? "servicio_no_ofrecido"
                : "servicio_sin_profesional",
          },
        });
      }

      if (booking.reason === "equipo_fuera_de_servicio") {
        await registrarEscalamiento({
          sandbox: deps.sandbox,
          clinic,
          patient: pacienteDelTurno,
          from,
          text,
          agentResponse: {
            ...agentResponse,
            motivo_escalar: "otro",
            respuesta_al_paciente: agentResponse.respuesta_al_paciente,
          },
          detalle: await describirEquipoFueraDeServicio(clinic.id, agentResponse.servicio),
        });
      }

      /**
       * El paciente NO puede quedarse con la confirmación que el modelo ya
       * redactó: dice "quedó agendado" o "cambié tu cita" y no es verdad (pasó
       * el 2026-11-05 con una reprogramación). Se vuelve a llamar al modelo con
       * el motivo y, si sirve otro horario, con los huecos reales, para que lo
       * explique con el mismo tono y el mismo español que el resto de la
       * conversación. Lo que él devuelva ya no puede agendar, cancelar ni
       * derivar nada: es solo la redacción.
       */
      const derivado =
        booking.reason === "servicio_no_ofrecido" ||
        booking.reason === "servicio_sin_profesional" ||
        booking.reason === "equipo_fuera_de_servicio";

      // Falta el nombre y el apellido: no es un fallo de horario, no hay alternativas que ofrecer. Hay que pedir los datos.
      const pideElNombre = booking.reason === "falta_nombre_y_apellido";

      let alternativas = "";
      if (!derivado && !pideElNombre) {
        const huecos = await buscarHuecos({
          clinic,
          patient: turnoAMover?.patient ?? pacienteDelTurno,
          agentResponse,
          requestedService: turnoAMover?.service ?? agentResponse.servicio,
          requestedProfessionalId:
            matchRequestedProfessional(agentResponse.profesional_solicitado, profesionalesActivos) ??
            turnoAMover?.professionalId ??
            null,
          excludeAppointmentId: turnoAMover?.id ?? null,
          campaignId,
          findSlots: deps.findSlots,
        });
        alternativas = `\nHorarios que sí hay:\n${formatAvailableSlots(huecos)}`;
      }

      const queSeIntentaba = reprograma ? "cambiar la cita" : "agendar la cita";
      const elegido = [agentResponse.fecha_solicitada, agentResponse.hora_solicitada].filter(Boolean).join(" ");
      const aviso = pideElNombre
        ? `AVISO: la cita NO se agendó todavía: falta el nombre y el apellido de la persona del turno. ` +
          `NO digas que quedó agendada ni que la reservaste. Pide su nombre y apellido en UNA sola pregunta corta ` +
          `y dile que con eso la dejas agendada${elegido ? ` (horario elegido: ${elegido})` : ""}. Nada más: sin disculpas largas ni otros horarios.`
        : `AVISO: NO se pudo ${queSeIntentaba} que el/la paciente confirmó (${describeBookingFailure(booking.reason)}). ` +
          `Todavía no quedó nada hecho: NO digas que quedó agendada ni que se cambió. ` +
          `Pide disculpas brevemente y ` +
          (derivado
            ? "dile que ya quedó derivado a una persona de nuestro equipo, que lo/la va a contactar."
            : "ofrécele, si hay, otros horarios de la lista, o pregúntale qué otro día le queda bien.") +
          alternativas;

      try {
        const explicacion = await deps.interpret({
          clinic,
          patientMessage: text,
          conversationHistory,
          horariosDisponibles: aviso,
          turnosPaciente,
          historialPersonas,
          canceladasSinMotivo,
          campana,
          promociones,
          trace: { turnId, kind: "explicacion_fallo", attempt: 1, patientId: patient.id },
          esPrimeraVez,
          servicios,
          workingHours,
          seguros,
          profesionales,
          serviciosPorProfesional,
          servicioPrimeraVez,
        });
        agentResponse = {
          ...explicacion,
          // Solo redacción: nada de lo que dice puede disparar acciones.
          confirmacion_explicita: false,
          requiere_horarios_disponibles: false,
          escalar_a_humano: false,
          turno_a_modificar: null,
          pidio_ubicacion: false,
        };
        mensajeDeUbicacion = null;
      } catch (error) {
        console.error(`Falló la explicación del fallo de reserva (clínica ${clinic.id}):`, error);
        agentResponse = {
          ...agentResponse,
          confirmacion_explicita: false,
          turno_a_modificar: null,
          respuesta_al_paciente: pideElNombre
            ? "Para dejar su cita agendada necesito su nombre y apellido. ¿Me los indica?"
            : "Disculpe, no pude concretar ese horario. ¿Me indica qué otro día u hora le queda bien para intentarlo de nuevo?",
        };
        mensajeDeUbicacion = null;
      }
    }
  }

  if (agentResponse.intent === "cancelar" && agentResponse.turno_a_modificar) {
    /**
     * El id lo devuelve el modelo, así que se busca acotado a la clínica Y al
     * paciente de esta conversación, nunca por id solo. Un id alucinado o
     * dictado por el paciente no puede cancelarle el turno a otra persona: si
     * no es suyo, no se encuentra y no se cancela nada.
     */
    const appointment = await prisma.appointment.findFirst({
      where: {
        id: agentResponse.turno_a_modificar,
        clinicId: clinic.id,
        // Cualquiera de las personas de ESTE número: quien escribe puede
        // cancelar el turno de su papá, pero no el de un desconocido.
        patientId: { in: personasDelNumero.map((p) => p.id) },
        status: "confirmado",
      },
      // La cuenta del calendario viene incluida porque hace falta la
      // credencial para borrar el evento espejo.
      include: { professional: { include: PROFESSIONAL_CALENDAR_INCLUDE } },
    });
    if (!appointment) {
      console.warn(
        `El modelo pidió cancelar la cita ${agentResponse.turno_a_modificar}, que no es una cita vigente de este paciente (clínica ${clinic.id})`
      );
    } else {
      // El cambio y su evento, juntos: es lo que alimenta el reporte de cancelaciones
      // (quién canceló y cuándo). Cancela el paciente, por WhatsApp.
      // Si ya dio el motivo en este mismo mensaje, se guarda acá; si no, el asistente
      // cancela SIN demorar y lo pregunta después (el motivo llega en el mensaje
      // siguiente: `attachCancellationReason`).
      const motivo = cleanCancelReason(agentResponse.motivo_cancelacion);
      await prisma.$transaction(async (tx) => {
        await tx.appointment.update({
          where: { id: appointment.id },
          data: {
            status: "cancelado",
            cancelledAt: new Date(),
            cancelledByKind: "paciente",
            cancelReason: motivo,
          },
        });
        await recordAppointmentEvent(tx, {
          clinicId: clinic.id,
          appointmentId: appointment.id,
          type: "cancelada",
          actorKind: "paciente",
          reason: motivo,
          details: agentResponse.motivo_es_queja ? { queja: true } : undefined,
        });
      });
      const target = resolveCalendarTargetForProfessional(clinic, appointment.professional);
      if (appointment.googleEventId && target) {
        try {
          await removeMirroredEvent(target, appointment.googleEventId);
        } catch (error) {
          // El turno ya quedó cancelado en Postgres, que es la fuente de
          // verdad. Un fallo borrando el espejo no puede revertir eso.
          console.error(`No se pudo borrar el evento espejo de ${appointment.id}:`, error);
        }
      }
      await updatePatientStage(appointment.patientId, "cancelado", { origin: "whatsapp", motivo: "cancelacion" });
    }
  }

  // El paciente contó el motivo de una cancelación que ya ocurrió (en un mensaje
  // posterior): se le pone a ESA cita. El id lo escribe el modelo, así que se acota por
  // clínica, por las personas de este número y por la ventana de 48 horas. No cancela nada.
  if (agentResponse.turno_cancelado && agentResponse.motivo_cancelacion && agentResponse.intent !== "cancelar") {
    const resultado = await attachCancellationReason({
      clinicId: clinic.id,
      patientIds: personasDelNumero.map((p) => p.id),
      appointmentId: agentResponse.turno_cancelado,
      reason: agentResponse.motivo_cancelacion,
      isComplaint: agentResponse.motivo_es_queja,
    });
    if (!resultado.ok) {
      console.warn(
        `El modelo pidió ponerle motivo a la cancelación ${agentResponse.turno_cancelado}, que no es una cancelación reciente de este número (clínica ${clinic.id})`
      );
    }
  }

  // El historial se guarda antes de enviar: si el envío falla, la auditoría
  // tiene que mostrar igual qué se le contestó al paciente. Se guarda solo la
  // respuesta final — es la transcripción de WhatsApp, no un log del agente,
  // y la interpretación intermedia nunca le llegó a nadie.
  await appendConversationMessage({
    clinicId: clinic.id,
    patientPhone: from,
    role: "patient",
    content: text,
  });
  // Los avisos de una sola vez van DENTRO de la respuesta y no como mensajes aparte (2026-11-25: dos mensajes juntos
  // molestaban y cada uno cuenta como un mensaje de WhatsApp): al comienzo, quién lo atiende (primer mensaje); al final, el
  // link al aviso de privacidad (desde el segundo). Ver `services/privacy-notice.ts`.
  const presentacion = await reclamarPresentacion({ clinic, patient, deps });
  const avisoDePrivacidad = await reclamarAvisoDePrivacidad({ clinic, patient, from, deps });
  const textoAlPaciente = [presentacion, agentResponse.respuesta_al_paciente, avisoDePrivacidad]
    .filter((parte): parte is string => Boolean(parte))
    .join("\n\n");

  await appendConversationMessage({
    clinicId: clinic.id,
    patientPhone: from,
    role: "assistant",
    content: textoAlPaciente,
  });

  try {
    await deps.send(clinicWhatsAppCreds(clinic), from, textoAlPaciente);
  } catch (error) {
    // No salió: las marcas se liberan para que la próxima respuesta lleve lo que faltó.
    if (presentacion) await prisma.patient.updateMany({ where: { id: patient.id }, data: { assistantIntroSentAt: null } }).catch(() => undefined);
    if (avisoDePrivacidad) await prisma.patient.updateMany({ where: { id: patient.id }, data: { privacyNoticeSentAt: null } }).catch(() => undefined);
    throw error;
  }
  for (const [enviado, action] of [
    [presentacion, "patient.assistant_intro_sent"],
    [avisoDePrivacidad, "patient.privacy_notice_sent"],
  ] as const) {
    if (!enviado) continue;
    await recordSystemAudit({ origin: "whatsapp", clinicId: clinic.id, action, resourceType: "patient", resourceId: patient.id });
  }

  // Va después de la respuesta y no antes: la confirmación del turno es lo
  // que el paciente está esperando leer, la dirección es el complemento. Si
  // falla, el turno ya está creado y confirmado — se loguea y nada más.
  if (mensajeDeUbicacion) {
    try {
      await appendConversationMessage({
        clinicId: clinic.id,
        patientPhone: from,
        role: "assistant",
        content: mensajeDeUbicacion,
      });
      await deps.send(clinicWhatsAppCreds(clinic), from, mensajeDeUbicacion);
    } catch (error) {
      console.error(`No se pudo enviar la ubicación de la clínica ${clinic.id}:`, error);
    }
  }
}

/**
 * La presentación ("Le atiende el asistente virtual de …"), una sola vez por persona. Devuelve el texto que va al comienzo de la
 * primera respuesta, o null si no corresponde (ya se le dijo, o es el chat de pruebas, que la muestra como nota). Reclama la marca
 * ANTES de enviar (UPDATE condicionado a null: dos turnos a la vez no la duplican); quien envía la libera si el envío falla.
 * No se puede apagar: ver "Presentación del asistente y aviso de privacidad" en CLAUDE.md. Nunca tumba el turno.
 */
async function reclamarPresentacion(params: {
  clinic: ClinicWithCalendarAccount;
  patient: Patient;
  deps: AgentTurnDeps;
}): Promise<string | null> {
  const { clinic, patient, deps } = params;
  try {
    const mensaje = buildAssistantIntroMessage(clinic);
    const reclamo = await prisma.patient.updateMany({
      where: { id: patient.id, clinicId: clinic.id, assistantIntroSentAt: null },
      data: { assistantIntroSentAt: new Date() },
    });
    if (reclamo.count === 0) return null;
    if (deps.sandbox) {
      deps.sandbox.notas.push(`Al paciente real se le mandaría, al comienzo de la primera respuesta: «${mensaje}»`);
      return null;
    }
    return mensaje;
  } catch (error) {
    console.error(`No se pudo preparar la presentación del asistente (clínica ${clinic.id}):`, error);
    return null;
  }
}

/**
 * El aviso de privacidad: el link al aviso de la clínica (`services/privacy-notice.ts`), una sola vez por persona, **a partir de
 * su segundo mensaje** y solo si la clínica cargó el link. Devuelve el texto que va al final de la respuesta, o null si no
 * corresponde. Va en la MISMA respuesta (no es un mensaje aparte), igual que la presentación.
 *
 * **Una sola vez**: se RECLAMA la marca antes de mandar (UPDATE condicionado a null, así dos turnos a la vez no lo duplican) y
 * quien envía la libera si el envío falla. **Nunca puede tumbar el turno.** Se audita al salir (origen `whatsapp`), sin el link ni
 * ningún dato. **El Chat de pruebas no lo manda: lo muestra como nota** («Al paciente real se le mandaría…», y por qué no salió el
 * aviso si falta el link), para poder probar el recorrido completo.
 */
async function reclamarAvisoDePrivacidad(params: {
  clinic: ClinicWithCalendarAccount;
  patient: Patient;
  from: string;
  deps: AgentTurnDeps;
}): Promise<string | null> {
  const { clinic, patient, from, deps } = params;
  try {
    const mensaje = buildPrivacyNoticeMessage(clinic);
    // Solo desde su segundo mensaje: el actual ya está en el historial, así que hay que contar al menos dos.
    const mensajesDeLaPersona = await prisma.conversationMessage.count({
      where: { clinicId: clinic.id, patientPhone: from, role: "patient" },
    });
    if (mensajesDeLaPersona < 2) return null;
    if (!mensaje) {
      // Sin link no hay qué mostrar, y la marca no se pone: lo recibirá cuando se cargue. En el chat de pruebas se avisa
      // POR QUÉ no salió (es la causa más común de "no me mandó el aviso"), una sola vez.
      if (deps.sandbox && mensajesDeLaPersona === 2) {
        deps.sandbox.notas.push(
          "Al paciente real todavía no se le mandaría el aviso de privacidad: la clínica no cargó el link (detalle de la clínica → «Link del aviso de privacidad»)."
        );
      }
      return null;
    }

    const reclamo = await prisma.patient.updateMany({
      where: { id: patient.id, clinicId: clinic.id, privacyNoticeSentAt: null },
      data: { privacyNoticeSentAt: new Date() },
    });
    if (reclamo.count === 0) return null;

    if (deps.sandbox) {
      // Chat de pruebas: no sale nada por WhatsApp ni queda en el historial; se muestra como lo que SE LE MANDARÍA al paciente real.
      deps.sandbox.notas.push(`Al paciente real se le mandaría, al final de esta respuesta: «${mensaje}»`);
      return null;
    }
    return mensaje;
  } catch (error) {
    console.error(`No se pudo preparar el aviso de privacidad (clínica ${clinic.id}):`, error);
    return null;
  }
}

/**
 * Los huecos para la segunda llamada. Si el cálculo falla, el paciente recibe
 * igual una respuesta: se devuelve un resultado vacío con `blocker`, que el
 * formateador traduce a "no se pudo consultar" y el prompt sabe manejar.
 */
async function buscarHuecos(params: {
  clinic: ClinicWithCalendarAccount;
  patient: Patient;
  agentResponse: ClaudeAgentResponse;
  /** El profesional que pidió el paciente, ya resuelto; null = cualquiera. */
  requestedProfessionalId: string | null;
  /** Por default el `servicio` del modelo; al reprogramar, el de la cita que se mueve. */
  requestedService?: string | null;
  /** Reprogramar: la cita que se mueve y que no cuenta como ocupada. */
  excludeAppointmentId?: string | null;
  /** La campaña por la que llegó la persona (puede sumarle profesionales al servicio de su promoción). */
  campaignId?: string | null;
  findSlots: AgentTurnDeps["findSlots"];
}): Promise<AvailableSlotsResult> {
  try {
    const slots = await params.findSlots({
      clinic: params.clinic,
      patient: params.patient,
      requestedService:
        params.requestedService !== undefined
          ? params.requestedService
          : params.agentResponse.servicio,
      requestedProfessionalId: params.requestedProfessionalId,
      excludeAppointmentId: params.excludeAppointmentId ?? null,
      campaignId: params.campaignId ?? null,
      isUrgent: params.agentResponse.motivo_escalar === "urgencia",
      // Si el paciente pidió una fecha, las opciones arrancan por ahí.
      fromDateKey: params.agentResponse.fecha_solicitada ?? undefined,
    });

    console.info(
      JSON.stringify({
        evento: "huecos_consultados",
        clinicId: params.clinic.id,
        patientId: params.patient.id,
        intent: params.agentResponse.intent,
        servicio: params.agentResponse.servicio,
        totalSlots: slots.totalSlots,
        blocker: slots.blocker,
      })
    );

    return slots;
  } catch (error) {
    console.error(`No se pudieron calcular los huecos de la clínica ${params.clinic.id}:`, error);
    return {
      days: [],
      totalSlots: 0,
      durationMinutes: 0,
      blocker: "sin_horario_de_atencion",
      restrictedToProfessionalId: null,
    };
  }
}

/**
 * Deja registrado el caso y avisa a la clínica.
 *
 * El orden importa y no es intercambiable: **primero se guarda la fila, después
 * se intenta el mail**. El asistente ya le prometió al paciente que alguien lo
 * va a contactar; si el único rastro fuera un aviso que puede fallar, una
 * urgencia se perdería sin que nadie se entere. Con la fila guardada, un mail
 * caído se ve como un pendiente sin notificar en la pantalla de derivaciones.
 *
 * Nada de esto puede tumbar la respuesta al paciente: si falla, se loguea y el
 * mensaje sale igual.
 */
/**
 * Qué equipo falta y por qué, para que quien atienda la derivación no tenga
 * que ir a buscarlo. Si el motivo no se cargó al desactivarlo, se dice eso
 * mismo en vez de inventar una explicación.
 */
async function describirEquipoFueraDeServicio(
  clinicId: string,
  servicio: string | null
): Promise<string> {
  const catalogo = servicio
    ? await prisma.service.findFirst({
        where: { clinicId, name: { equals: servicio, mode: "insensitive" }, active: true },
        select: { requiredResourceType: true },
      })
    : null;

  const tipo = catalogo?.requiredResourceType;
  if (!tipo) return "El servicio pedido requiere un equipo que no está disponible.";

  const unidades = await prisma.resource.findMany({
    where: { clinicId, type: tipo },
    select: { name: true, inactiveReason: true },
  });

  const motivos = unidades
    .map((u) => `${u.name}: ${u.inactiveReason ?? "sin motivo cargado"}`)
    .join("; ");

  return `El servicio requiere el equipo "${tipo}", que está fuera de servicio (${
    motivos || "no hay ninguna unidad cargada"
  }).`;
}

/**
 * El modelo falló dos veces: se le avisa al paciente y se deriva.
 *
 * Mismo orden que en un escalamiento normal: primero la fila (y el mail), que
 * es el rastro que no puede perderse, y recién después el mensaje. Nada de
 * esto puede lanzar: si falla algo, se loguea — ya estamos en el camino de
 * error y no hay a quién avisarle de otro más.
 */
async function atenderFallaDelModelo(params: {
  clinic: ClinicWithCalendarAccount;
  patient: Patient;
  from: string;
  text: string;
  deps: AgentTurnDeps;
  error: unknown;
}): Promise<void> {
  const { clinic, patient, from, text, deps, error } = params;

  const respuesta: ClaudeAgentResponse = {
    intent: "otro",
    servicio: null,
    fecha_solicitada: null,
    hora_solicitada: null,
    nombre_paciente: null,
    paciente_del_turno: null,
    turno_a_modificar: null,
    profesional_solicitado: null,
    requiere_horarios_disponibles: false,
    confirmacion_explicita: false,
    pidio_ubicacion: false,
    escalar_a_humano: true,
    motivo_escalar: "otro",
    motivo_cancelacion: null,
    motivo_es_queja: false,
    turno_cancelado: null,
    respuesta_al_paciente: DISCULPA_POR_FALLA,
  };

  try {
    await registrarEscalamiento({
      sandbox: deps.sandbox,
      clinic,
      patient,
      from,
      text,
      agentResponse: respuesta,
      detalle:
        "El asistente no pudo procesar este mensaje (falló la llamada al modelo " +
        "dos veces) y el paciente recibió una disculpa. Hay que contestarle " +
        `a mano. Error: ${error instanceof Error ? error.message : String(error)}`,
    });
  } catch (e) {
    console.error(`No se pudo registrar la derivación por falla (clínica ${clinic.id}):`, e);
  }

  try {
    await appendConversationMessage({ clinicId: clinic.id, patientPhone: from, role: "patient", content: text });
    await appendConversationMessage({ clinicId: clinic.id, patientPhone: from, role: "assistant", content: DISCULPA_POR_FALLA });
    await deps.send(clinicWhatsAppCreds(clinic), from, DISCULPA_POR_FALLA);
  } catch (e) {
    console.error(`No se pudo enviar la disculpa (clínica ${clinic.id}):`, e);
  }
}

async function registrarEscalamiento(params: {
  /** Chat de pruebas: no se guarda ni se avisa nada, solo se anota para mostrarlo. */
  sandbox?: SandboxCollector;
  clinic: ClinicWithCalendarAccount;
  patient: Patient;
  from: string;
  text: string;
  agentResponse: ClaudeAgentResponse;
  /** Contexto extra para quien atiende la derivación. */
  detalle?: string;
  /**
   * La derivación es porque piden un servicio que la clínica no ofrece o que
   * nadie realiza. Suma al mail la instrucción de qué hacer, y avisa también
   * por WhatsApp.
   */
  servicioSinCubrir?: {
    servicio: string | null;
    motivo: "servicio_no_ofrecido" | "servicio_sin_profesional";
  };
}): Promise<void> {
  const { clinic, patient, from, text, agentResponse } = params;

  if (params.sandbox) {
    const motivo = MOTIVO_LABEL[toEscalationReason(agentResponse.motivo_escalar)];
    params.sandbox.notas.push(
      `El asistente derivó la conversación a una persona (motivo: ${motivo}).` +
        (params.servicioSinCubrir ? " Fue porque pidieron un servicio que la clínica no ofrece o que nadie realiza." : "") +
        " En producción esto queda en \"Por atender\" y se avisa por mail; en el chat de pruebas no se guarda ni se avisa a nadie."
    );
    return;
  }

  // Qué texto devolvió el modelo cuando no matcheó el catálogo: es lo que
  // permite ver, con uso real, cuántas de estas derivaciones son falsas y qué
  // nombres coloquiales hay que enseñarle al prompt. Es un nombre de servicio,
  // no el mensaje del paciente.
  if (params.servicioSinCubrir?.motivo === "servicio_no_ofrecido") {
    await recordSystemEvent({
      kind: SYSTEM_EVENT_KINDS.SERVICIO_SIN_MATCH,
      severity: "warning",
      clinicId: clinic.id,
      message: `El modelo devolvió "${(params.servicioSinCubrir.servicio ?? "(vacío)").slice(0, 80)}", que no figura en el catálogo.`,
    });
  }

  const summary = [
    buildEscalationSummary({
      clinic,
      patient,
      patientPhone: from,
      agentResponse,
      lastPatientMessage: text,
    }),
    params.detalle,
  ]
    .filter(Boolean)
    .join("\n\n");

  const reason = toEscalationReason(agentResponse.motivo_escalar);

  try {
    const escalation = await createEscalation({
      clinicId: clinic.id,
      patientId: patient.id,
      patientPhone: from,
      patientName: patient.name ?? agentResponse.nombre_paciente ?? null,
      reason,
      patientMessage: text,
      summary,
    });

    // El destinatario de urgencias es aparte del mail general de la clínica:
    // un diente roto tiene que llegarle a quien está de guardia, no a quien
    // administra el sistema. Si no lo configuraron, se cae al mail de siempre.
    const destinatario = clinic.urgencyNotifyEmail ?? clinic.email;

    try {
      await sendEscalationAlert({
        clinicName: clinic.name,
        to: destinatario,
        motivo: MOTIVO_LABEL[reason],
        esUrgencia: reason === "urgencia",
        patientName: escalation.patientName,
        patientPhone: from,
        patientMessage: text,
        escalationsUrl: `${env.frontendUrl}/app/escalations`,
        nota: params.servicioSinCubrir ? NOTA_SERVICIO_SIN_CUBRIR : undefined,
      });
      await markEscalationNotified(escalation.id);
    } catch (error) {
      // Queda como pendiente sin notificar, que es justamente lo que la
      // pantalla resalta.
      console.error(
        `No se pudo avisar por mail del escalamiento ${escalation.id} (clínica ${clinic.id}):`,
        error
      );
    }

    // WhatsApp al número interno, por la plantilla de avisos de configuración
    // ("Hola {{1}}: {{2}} Puedes resolverlo desde {{3}}"). Va aparte del mail y
    // sus errores no se propagan: `avisarPorWhatsApp` los captura.
    if (params.servicioSinCubrir) {
      await avisarPorWhatsApp(clinic, [
        clinic.name,
        `Una persona pidió "${params.servicioSinCubrir.servicio ?? "un servicio"}" y ${
          params.servicioSinCubrir.motivo === "servicio_no_ofrecido"
            ? "no figura en tu catálogo."
            : "ningún profesional lo tiene asignado."
        } Si lo prestan, cárgalo en Servicios y asígnalo a quienes lo realizan.`,
        `${env.frontendUrl}/app/services`,
      ]);
    }
  } catch (error) {
    // Último recurso: si ni siquiera se pudo guardar, que quede en el log.
    console.error(`No se pudo registrar el escalamiento de la clínica ${clinic.id}:`, error);
    console.warn(summary);
  }
}

/**
 * ¿El modelo quiere MOVER una cita que ya existe? `reprogramar`, o un
 * `confirmar` que trae el id de la cita a modificar (el paciente elige el nuevo
 * horario y el modelo lo marca como confirmación). Sin id no hay nada que mover.
 */
function esReprogramacion(r: { intent: string; turno_a_modificar: string | null }): boolean {
  if (!r.turno_a_modificar) return false;
  return r.intent === "reprogramar" || r.intent === "confirmar";
}

/**
 * La cita vigente que el modelo quiere mover. El id lo escribe el modelo, así
 * que nunca se busca por id solo: va acotado a la clínica y a las personas de
 * este número, y solo si sigue `confirmado`.
 */
function buscarTurnoVigente(clinicId: string, id: string | null, patientIds: string[]) {
  if (!id) return Promise.resolve(null);
  return prisma.appointment.findFirst({
    where: { id, clinicId, patientId: { in: patientIds }, status: "confirmado" },
    include: { patient: true },
  });
}

const NOTA_SERVICIO_SIN_CUBRIR =
  'Si es un servicio o tratamiento que la clínica sí presta, inclúyelo en el módulo "Servicios" y asígnalo al profesional o a los profesionales que lo realizan. Mientras tanto, contacta a esta persona directamente.';

function detalleServicioSinCubrir(
  motivo: "servicio_no_ofrecido" | "servicio_sin_profesional",
  servicio: string | null
): string {
  const pedido = servicio ? `"${servicio}"` : "un servicio sin nombre claro";
  return motivo === "servicio_no_ofrecido"
    ? `Pidió ${pedido}, que no figura entre los servicios que ofrece la clínica.`
    : `Pidió ${pedido}, que está en el catálogo pero no tiene ningún profesional activo asignado.`;
}

const MOTIVO_LABEL: Record<string, string> = {
  urgencia: "Urgencia",
  consulta_clinica: "Consulta que necesita criterio profesional",
  otro: "Otro / no clasificado",
};
