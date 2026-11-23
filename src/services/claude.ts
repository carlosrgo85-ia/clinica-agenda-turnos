import { momentoDelDia } from "../prompts/time-of-day";
import { clinicMinutesFromMidnight } from "./time";
import Anthropic from "@anthropic-ai/sdk";
import type { Clinic, Service, WorkingHours } from "@prisma/client";
import { env } from "../config/env";
import { SIN_CONSULTAR } from "../prompts/availability-context";
import { normalizeWhatsAppNumber } from "./phone";
import { buildSystemPrompt, recordatorioDeTratamiento } from "../prompts/system-prompt";
import type { ClaudeAgentResponse, Intent } from "../types";
import { recordAgentRequest, type AgentTrace } from "./agent-requests";

const INTENTS: Intent[] = [
  "agendar",
  "cancelar",
  "reprogramar",
  "consultar_horarios",
  "consultar_info",
  "confirmar",
  "otro",
];

/**
 * Parsea la respuesta del modelo sin confiar en que sea JSON válido.
 *
 * Se le pide que devuelva únicamente un JSON, pero eso es una instrucción, no
 * una garantía: puede venir cortado por `max_tokens`, con prosa alrededor, o
 * con un campo de otro tipo. Cualquiera de esas cosas reventaría el
 * `JSON.parse` crudo y el paciente se quedaría sin respuesta. Devolver `null`
 * deja que el llamador decida qué contestarle.
 */
/**
 * El objeto JSON que hay en el texto del modelo.
 *
 * El prompt pide "ÚNICAMENTE un JSON", pero el modelo a veces lo envuelve en un bloque de código (```json … ```) o le
 * antepone una frase. Antes eso se trataba como una respuesta ilegible: se reintentaba y, si volvía a pasar, el paciente
 * recibía una disculpa y una derivación a una persona POR UN PAR DE BACKTICKS (pasó el 2026-11-18, dos veces seguidas).
 * Acá se saca el cerco y se toma el primer objeto completo, contando las llaves sin dejarse engañar por las que van dentro de un
 * texto. Si no hay ningún objeto completo (un JSON cortado por `max_tokens`), devuelve null: eso SÍ es ilegible.
 */
export function extractJsonObject(text: string): string | null {
  const limpio = text.trim().replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();
  const inicio = limpio.indexOf("{");
  if (inicio === -1) return null;

  let profundidad = 0;
  let enTexto = false;
  let escapado = false;
  for (let i = inicio; i < limpio.length; i += 1) {
    const c = limpio[i];
    if (enTexto) {
      if (escapado) escapado = false;
      else if (c === "\\") escapado = true;
      else if (c === '"') enTexto = false;
    } else if (c === '"') {
      enTexto = true;
    } else if (c === "{") {
      profundidad += 1;
    } else if (c === "}") {
      profundidad -= 1;
      if (profundidad === 0) return limpio.slice(inicio, i + 1);
    }
  }
  return null;
}

export function parseAgentResponse(text: string): ClaudeAgentResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(text) ?? "");
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;

  if (!INTENTS.includes(candidate.intent as Intent)) return null;
  if (typeof candidate.respuesta_al_paciente !== "string") return null;
  if (candidate.respuesta_al_paciente.trim() === "") return null;

  for (const flag of [
    "requiere_horarios_disponibles",
    "confirmacion_explicita",
    "escalar_a_humano",
  ]) {
    if (typeof candidate[flag] !== "boolean") return null;
  }

  // `pidio_ubicacion` no se exige: que falte solo significa que no se adjunta
  // la dirección, y tirar la respuesta entera por eso sería mucho peor que
  // no mandar un link. Los tres de arriba sí cambian lo que se hace con el
  // turno, así que ahí una respuesta a medias no sirve.
  if (typeof candidate.pidio_ubicacion !== "boolean") candidate.pidio_ubicacion = false;

  // Tampoco se exige `paciente_del_turno`: que falte significa "es para
  // quien escribe", que es el caso normal.
  if (typeof candidate.paciente_del_turno !== "string" || !candidate.paciente_del_turno.trim()) {
    candidate.paciente_del_turno = null;
  }

  // Los apellidos son opcionales: que falten significa "no los dio por separado" y la ficha
  // queda con el nombre completo (se parte al leer).
  for (const campo of ["apellido_paciente", "apellido_paciente_del_turno"] as const) {
    const v = candidate[campo];
    candidate[campo] = typeof v === "string" && v.trim() ? v.trim() : null;
  }

  // `corrige_nombre` es opcional: que falte significa que no corrigió nada. Solo `true` cuenta.
  candidate.corrige_nombre = candidate.corrige_nombre === true;

  // Los teléfonos son opcionales: que falten significa "el mismo número, ninguno adicional". Se normalizan acá y un valor
  // que no parece un número se descarta (nunca se confía en lo que escribe el modelo).
  for (const campo of ["telefono_registro", "telefono_autorizado"] as const) {
    candidate[campo] = typeof candidate[campo] === "string" ? normalizeWhatsAppNumber(candidate[campo] as string) : null;
  }

  // `campana_mencionada` es opcional: que falte significa "no mencionó ninguna promoción".
  candidate.campana_mencionada =
    typeof candidate.campana_mencionada === "string" && candidate.campana_mencionada.trim() ? candidate.campana_mencionada.trim() : null;

  // Tampoco `profesional_solicitado`: que falte significa "no pidió ninguno".
  if (typeof candidate.profesional_solicitado !== "string" || !candidate.profesional_solicitado.trim()) {
    candidate.profesional_solicitado = null;
  }

  // Los tres campos del motivo de cancelación son opcionales por lo mismo: que falten
  // significa "no dio ningún motivo" y no es razón para tirar la respuesta entera.
  if (typeof candidate.motivo_cancelacion !== "string" || !candidate.motivo_cancelacion.trim()) {
    candidate.motivo_cancelacion = null;
  }
  if (typeof candidate.motivo_es_queja !== "boolean") candidate.motivo_es_queja = false;
  if (typeof candidate.turno_cancelado !== "string" || !candidate.turno_cancelado.trim()) {
    candidate.turno_cancelado = null;
  }

  return candidate as unknown as ClaudeAgentResponse;
}

const client = new Anthropic({ apiKey: env.anthropic.apiKey });

interface InterpretParams {
  clinic: Clinic;
  patientMessage: string;
  conversationHistory: string;
  horariosDisponibles?: string;
  /**
   * Las personas registradas en ese WhatsApp y sus turnos
   * (`prompts/appointments-context.ts` → `describePeople`). Obligatorio a
   * propósito: mientras fue opcional nadie lo pasó, el prompt decía "ninguno
   * informado" en todos los mensajes, y el modelo no podía cancelar un turno
   * ni saber que ya había uno.
   */
  turnosPaciente: string;
  /**
   * Qué se le hizo a cada persona del número, su próxima cita sugerida y las
   * notas internas (`prompts/patient-history-context.ts`). **Obligatorio** por lo
   * mismo que `turnosPaciente`: opcional, nadie lo pasaba y el asistente atendía a
   * quien ya vino como si fuera un desconocido.
   */
  historialPersonas: string;
  /**
   * Las citas que ESTE WhatsApp canceló hace poco y todavía no tienen motivo registrado
   * (`prompts/appointments-context.ts` → `describeRecentCancellations`). Es lo que permite
   * registrar el motivo cuando llega en un mensaje POSTERIOR a la cancelación (el
   * asistente cancela sin demorar y pregunta después). **Obligatorio** por lo mismo que
   * `turnosPaciente`.
   */
  canceladasSinMotivo: string;
  /**
   * La campaña o promoción por la que llegó esta persona (`prompts/campaign-context.ts`), o `SIN_CAMPANA`.
   * **Obligatorio** por lo mismo que `turnosPaciente`: opcional, nadie lo pasaba y el asistente atendía
   * a quien venía por una promoción como a un desconocido (o prometía una que ya no rige).
   */
  campana: string;
  /**
   * Las promociones VIGENTES de la clínica (`prompts/campaign-context.ts` → `describeActivePromotions`), o
   * `SIN_PROMOCIONES`. Es lo que le permite reconocer a qué promoción se refiere alguien que no escribió la frase exacta de
   * ningún formato ("vengo por la promo de implantes") y contestar con lo que dice cada una. **Obligatorio** por lo mismo que
   * `campana`: opcional, nadie lo pasaba y el asistente decía que no había ninguna promoción.
   */
  promociones: string;
  /**
   * De dónde sale esta llamada, para registrarla (`AgentRequest`). **Obligatorio**: no hay
   * forma de hablar con el modelo sin dejar el rastro de qué se le pidió, cuánto tardó y qué
   * decidió.
   */
  trace: AgentTrace;
  esPrimeraVez: boolean;
  /** Catálogo formal activo de la clínica. Vacío = el prompt usa el texto libre. */
  servicios?: Array<Pick<Service, "name" | "durationMinutes"> & { priceNote?: string | null }>;
  /**
   * Los tramos de atención de la clínica. Obligatorio, por el mismo motivo
   * que `turnosPaciente`: es la fuente de lo que el bot anuncia como
   * horario, y olvidarse de pasarlo lo dejaría diciendo que no hay ninguno.
   */
  workingHours: WorkingHours[];
  /**
   * Las obras sociales / prepagas activas de la clínica, solo por nombre.
   * Obligatorio por el mismo motivo que `workingHours`: olvidarse de pasarlo
   * deja al bot sin poder contestar con cuáles trabajan. Vacío es un estado
   * válido y distinto — el prompt no afirma ni niega ninguno.
   */
  seguros: string[];
  /**
   * Los profesionales activos de la clínica, tal como se nombran ante el
   * paciente ("Dra. Liliana Mungiga"). Es de donde el modelo copia
   * `profesional_solicitado`; sin la lista no tiene cómo escribirlo bien.
   */
  profesionales?: string[];
  /** "Dra. Gómez: Limpieza, Blanqueamiento" — qué realiza cada uno. */
  serviciosPorProfesional?: string[];
  /** Nombre del servicio de primera vez de la clínica, si marcó uno. */
  servicioPrimeraVez?: string | null;
}

/**
 * El locale con el que se le muestra la fecha al modelo.
 *
 * Sale del país de la clínica y no de una constante: estaba fijo en "es-AR" y
 * era una de las cosas que hacían que una clínica mexicana recibiera
 * respuestas en argentino.
 */
function localeDe(clinic: Pick<Clinic, "country">): string {
  return clinic.country ? `es-${clinic.country}` : "es";
}

/** El modelo con el que habla el asistente. */
const MODEL = "claude-sonnet-5";

/** Lo mínimo del cliente de Anthropic que se usa: permite probar con uno falso. */
type AnthropicLike = { messages: { create: Anthropic["messages"]["create"] } };

/**
 * Habla con el modelo con el cliente que se le pase, y **registra cada solicitud**
 * (`AgentRequest`): cuánto tardó, cuánto costó, cómo terminó y qué decidió, sin guardar el
 * texto. El registro no es opcional: ver `InterpretParams.trace`.
 */
export async function interpretWithClient(
  anthropic: AnthropicLike,
  params: InterpretParams
): Promise<ClaudeAgentResponse> {
  const ahora = new Date();
  const momento = momentoDelDia(clinicMinutesFromMidnight(ahora, params.clinic.timezone));
  const userMessage = `
Fecha y hora actual: ${ahora.toLocaleString(localeDe(params.clinic), { timeZone: params.clinic.timezone })}
Momento del día: ${momento}
${recordatorioDeTratamiento(params.clinic.country, params.clinic.serviceNoun)}
Paciente de primera vez: ${params.esPrimeraVez ? "sí" : "no"}

Historial reciente:
${params.conversationHistory}

Horarios disponibles:
${params.horariosDisponibles ?? SIN_CONSULTAR}

Personas de este WhatsApp:
${params.turnosPaciente}

Historial de las personas de este WhatsApp (qué se les hizo y notas del personal):
${params.historialPersonas}

Citas canceladas recientemente por este WhatsApp (sin motivo registrado):
${params.canceladasSinMotivo}

Campaña o promoción por la que llegó esta persona:
${params.campana}

Promociones vigentes de la clínica:
${params.promociones}

Mensaje del paciente:
${params.patientMessage}
`.trim();

  const systemPrompt = buildSystemPrompt(params.clinic, {
    esPrimeraVez: params.esPrimeraVez,
    servicios: params.servicios,
    workingHours: params.workingHours,
    seguros: params.seguros,
    profesionales: params.profesionales,
    serviciosPorProfesional: params.serviciosPorProfesional,
    servicioPrimeraVez: params.servicioPrimeraVez,
  });
  const promptChars = systemPrompt.length + userMessage.length;
  const inicio = Date.now();

  let response: Anthropic.Message;
  try {
    response = (await anthropic.messages.create(
      {
        model: MODEL,
        // La respuesta es el JSON entero, no solo el texto para el paciente: si
        // se corta por max_tokens el JSON queda inválido y el paciente no
        // recibe nada. Un mensaje normal usa ~200 tokens; enumerar horarios
        // disponibles usa bastante más, así que conviene el margen.
        max_tokens: 2048,
        // `cache_control` cachea el system prompt (~1.900 tokens, idéntico
        // entre las dos llamadas de un mismo mensaje y entre todos los
        // mensajes de la misma clínica). Sin esto se repaga texto idéntico
        // en cada llamada — es la mayor parte del costo en tokens de entrada.
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userMessage }],
      },
      // El default del SDK son 10 minutos: una eternidad para alguien esperando
      // una respuesta por WhatsApp, y encima hay dos llamadas por mensaje.
      { timeout: 20_000 }
    )) as Anthropic.Message;
  } catch (error) {
    // La llamada falló (red, timeout, límite de la API): también queda registrada.
    await recordAgentRequest({
      clinicId: params.clinic.id,
      trace: params.trace,
      model: MODEL,
      latencyMs: Date.now() - inicio,
      promptChars,
      outcome: "error",
      error,
    });
    throw error;
  }

  const base = {
    clinicId: params.clinic.id,
    trace: params.trace,
    model: MODEL,
    latencyMs: Date.now() - inicio,
    promptChars,
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
    cacheReadTokens: response.usage?.cache_read_input_tokens ?? null,
    cacheCreationTokens: response.usage?.cache_creation_input_tokens ?? null,
    stopReason: response.stop_reason ?? null,
  };

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    await recordAgentRequest({ ...base, outcome: "sin_texto" });
    // Sin el stop_reason este error es imposible de diagnosticar después:
    // no es lo mismo que la respuesta se haya cortado por max_tokens que
    // que el modelo se haya negado a contestar.
    throw new Error(
      `Claude no devolvió texto en la respuesta (stop_reason: ${response.stop_reason}, bloques: ${JSON.stringify(response.content.map((b) => b.type))})`
    );
  }

  const parsed = parseAgentResponse(textBlock.text);
  if (!parsed) {
    await recordAgentRequest({ ...base, outcome: "no_interpretable" });
    throw new Error(
      `Claude devolvió una respuesta que no se pudo interpretar (stop_reason: ${response.stop_reason})`
    );
  }

  await recordAgentRequest({ ...base, outcome: "ok", response: parsed });
  return parsed;
}

/** La llamada de siempre, con el cliente real. */
export const interpretPatientMessage = (params: InterpretParams): Promise<ClaudeAgentResponse> =>
  interpretWithClient(client, params);
