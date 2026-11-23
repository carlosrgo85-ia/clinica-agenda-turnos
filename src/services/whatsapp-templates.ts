import { GRAPH_API_BASE } from "./whatsapp";

/**
 * Alta de las plantillas de WhatsApp en el WABA de una clínica.
 *
 * **Las plantillas son por WABA, no por plataforma.** En el modelo
 * multi-clínica cada clínica es dueña de su propio WhatsApp Business Account,
 * así que una plantilla aprobada en la clínica A no existe para la clínica B:
 * hay que crearla y hacerla aprobar en cada una. Hacerlo a mano en el
 * WhatsApp Manager de cada cliente no escala más allá de las primeras
 * clínicas — de ahí este archivo.
 *
 * Lo que se automatiza es la CREACIÓN; la aprobación la hace Meta y tarda
 * (de minutos a un día). Una plantilla recién creada queda en `PENDING` y no
 * se puede usar para enviar todavía: por eso el alta no espera la
 * aprobación, y `templateStatuses()` permite consultar después cómo
 * quedaron.
 *
 * El texto y la cantidad de parámetros de cada plantilla tienen que
 * coincidir EXACTAMENTE con lo que manda el código: Meta valida que la
 * cantidad de parámetros del envío sea igual a la de la plantilla aprobada,
 * y si no coinciden el mensaje se rechaza en tiempo de envío.
 */

/** Categoría de Meta. Ninguna de estas es marketing: todas son transaccionales. */
const UTILITY = "UTILITY";

export interface TemplateDefinition {
  /** Nombre en Meta. Es el que se guarda en `Clinic.*TemplateName`. */
  name: string;
  /** Qué manda el código con esta plantilla, para el log y la pantalla. */
  descripcion: string;
  /** El cuerpo, con `{{1}}`, `{{2}}`… en el orden en que se mandan. */
  body: string;
  /** Ejemplos de cada parámetro. Meta los exige para poder revisarla. */
  ejemplos: string[];
}

/**
 * Las tres plantillas que el código realmente envía hoy. La de urgencias
 * (`Clinic.urgencyNotifyPhone`) no está porque todavía no hay código que la
 * mande — ver la deuda técnica en CLAUDE.md; cuando exista, va acá.
 */
export const CLINIC_TEMPLATES: TemplateDefinition[] = [
  {
    name: "recordatorio_turno",
    descripcion: "Recordatorio de cita al paciente (24hs antes, y 2hs en el plan Plus)",
    // jobs/daily-reminders.ts → [nombre, fecha, hora, servicio]
    body:
      "Hola {{1}}, te recordamos tu cita del {{2}} a las {{3}} para {{4}}. " +
      "Si no puedes asistir, responde este mensaje y lo reprogramamos.",
    ejemplos: ["María", "18/09/2026", "09:30", "consulta"],
  },
  {
    name: "seguimiento_post_consulta",
    descripcion: "Seguimiento al día siguiente de la visita (plan Plus)",
    // jobs/post-visit-followup.ts → [nombre, nombre de la clínica]
    body:
      "Hola {{1}}, ¿cómo te sentís después de tu visita a {{2}}? " +
      "Si necesitas algo, responde este mensaje y te contactamos.",
    ejemplos: ["María", "Clínica Demo"],
  },
  {
    name: "cita_asignada_profesional",
    descripcion: "Aviso al profesional cuando se le asigna una cita nueva",
    // services/professional-notifications.ts → [nombre del profesional,
    // fecha, hora, servicio, nombre del paciente]
    // Meta rechaza (subcódigo 2388293) una plantilla con demasiadas variables en
    // relación con su longitud: con 5 variables hacen falta bastantes palabras
    // alrededor. Se alargó el texto, no se tocaron los parámetros.
    body:
      "Hola {{1}}, te informamos que se agendó una cita nueva en tu agenda. " +
      "El día {{2}} a las {{3}} atenderás el servicio de {{4}} al paciente {{5}}. " +
      "Puedes revisar los detalles en tu calendario o en el panel de la clínica.",
    ejemplos: ["Dra. Gómez", "18/09/2026", "09:30", "consulta", "María López"],
  },
  {
    name: "cita_modificada",
    descripcion: "Aviso al paciente cuando la clínica cambia el día, la hora o el profesional de su cita",
    // services/patient-notifications.ts → [nombre del paciente, servicio,
    // fecha, hora, nombre del profesional]
    body:
      "Hola {{1}}, tu cita de {{2}} cambió: ahora es el {{3}} a las {{4}} con {{5}}. " +
      "Si no te sirve, responde este mensaje y buscamos otro horario.",
    ejemplos: ["María", "limpieza", "18/09/2026", "09:30", "Dra. Gómez"],
  },
  {
    name: "cita_cancelada",
    descripcion: "Aviso al paciente cuando la clínica cancela su cita",
    // services/patient-notifications.ts → [nombre del paciente, servicio,
    // fecha, hora, nombre de la clínica]
    body:
      "Hola {{1}}, tu cita de {{2}} del {{3}} a las {{4}} en {{5}} fue cancelada. " +
      "Responde este mensaje y te ayudamos a agendar otra.",
    ejemplos: ["María", "limpieza", "18/09/2026", "09:30", "Clínica Demo"],
  },
  {
    name: "proximo_control",
    descripcion: "Aviso al paciente de que se acerca su próxima cita sugerida (apagado por defecto en cada clínica)",
    // jobs/next-visit-outreach.ts → [nombre del paciente, nombre de la clínica,
    // de qué es la próxima cita ("control", "limpieza")]
    // Ojo con la categoría: un mensaje que invita a sacar una cita puede ser
    // reclasificado como MARKETING (pasó con `aviso_configuracion`). Por eso el
    // texto habla de lo que le corresponde al paciente según su última visita, no
    // de una oferta, y no lleva cortesías de más. Si Meta igual la marca como
    // marketing, se pide la revisión de categoría en el WhatsApp Manager.
    body:
      "Hola {{1}}, te escribimos de {{2}}. Según tu última visita, ya corresponde que agendes tu próximo {{3}}. " +
      "Si quieres, responde este mensaje y te proponemos horarios para tu cita.",
    ejemplos: ["María", "Clínica Demo", "control"],
  },
  {
    name: "seguimiento_campana",
    descripcion: "Seguimiento a quien llegó por una campaña, preguntó y no agendó (apagado por defecto en cada clínica)",
    // jobs/campaign-followup.ts → [nombre del paciente, nombre de la clínica, nombre de la campaña]
    // Es lo más cercano a una promoción de todo el catálogo: Meta puede reclasificarla como MARKETING. Por
    // eso el texto habla de lo que la persona consultó y de ayudarla a elegir día y horario, sin ofertas
    // ni urgencias. Si igual la marca, se pide la revisión de categoría en el WhatsApp Manager.
    body:
      "Hola {{1}}, te escribimos de {{2}}. Hace unos días consultaste por {{3}} y todavía no agendaste tu cita. " +
      "Si sigues interesado, responde este mensaje y te ayudamos a elegir día y horario.",
    ejemplos: ["María", "Clínica Demo", "la limpieza de verano"],
  },
  {
    name: "aviso_configuracion",
    descripcion: "Aviso al número interno de la clínica cuando falta configuración",
    // jobs/config-alerts.ts → [nombre de la clínica, qué falta, link]
    // Con 3 variables y una frase corta Meta la rechazaba (2388293), y no puede
    // terminar en una variable. Pero una versión con cierre de cortesía
    // ("Gracias por mantener tu configuración al día") fue reclasificada por
    // Meta como MARKETING (2026-11-06). Se alargó con texto neutro y
    // operativo, sin tono comercial.
    body:
      "Hola, este es un aviso del asistente virtual de {{1}}. Detectamos un problema de configuración: {{2}} " +
      "Para resolverlo, ingresa al panel de la clínica en esta dirección: {{3}} " +
      "Si ya lo resolviste, ignora este aviso.",
    ejemplos: [
      "Clínica Demo",
      "Falta cargar el horario de atención.",
      "https://panel.ejemplo.com/working-hours",
    ],
  },
];

export type TemplateOutcome = "creada" | "ya_existia" | "error";

export interface TemplateResult {
  name: string;
  outcome: TemplateOutcome;
  /** El id que devolvió Meta, si se creó. */
  id?: string;
  /** Estado de revisión (`PENDING`, `APPROVED`, `REJECTED`), si Meta lo informó. */
  status?: string;
  error?: string;
}

interface WabaCreds {
  wabaId: string;
  /** Token descifrado — usar `clinicWhatsAppCreds()` para obtenerlo. */
  token: string;
}

/**
 * Crea en el WABA de la clínica las plantillas que le falten.
 *
 * Idempotente: una plantilla que ya existe devuelve `ya_existia` en vez de
 * fallar, así que se puede volver a correr sobre una clínica ya dada de alta
 * (por ejemplo si una quedó rechazada y se corrigió el texto, o si se sumó
 * una plantilla nueva al catálogo).
 *
 * Nunca lanza: devuelve el resultado de cada una. El alta de la clínica no
 * puede fallar porque Meta esté caído — la clínica ya está creada y sirve
 * para todo lo demás.
 */
export async function ensureClinicTemplates(
  creds: WabaCreds,
  languageCode = "es"
): Promise<TemplateResult[]> {
  const results: TemplateResult[] = [];

  for (const template of CLINIC_TEMPLATES) {
    results.push(await createTemplate(creds, template, languageCode));
  }

  return results;
}

async function createTemplate(
  creds: WabaCreds,
  template: TemplateDefinition,
  languageCode: string
): Promise<TemplateResult> {
  try {
    const response = await fetch(`${GRAPH_API_BASE}/${creds.wabaId}/message_templates`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: template.name,
        category: UTILITY,
        language: languageCode,
        components: [
          {
            type: "BODY",
            text: template.body,
            example: { body_text: [template.ejemplos] },
          },
        ],
      }),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      id?: string;
      status?: string;
      error?: {
        message?: string;
        error_subcode?: number;
        code?: number;
        /**
         * El motivo de verdad. `message` suele ser el genérico "Invalid
         * parameter" y estos dos campos dicen qué falló ("las variables no
         * pueden ir al final del texto", "ya existe en este idioma"...).
         */
        error_user_title?: string;
        error_user_msg?: string;
      };
    };

    if (response.ok) {
      return { name: template.name, outcome: "creada", id: payload.id, status: payload.status };
    }

    const detalle = [payload.error?.error_user_title, payload.error?.error_user_msg]
      .filter(Boolean)
      .join(": ");

    // Ya existe en ese idioma: no es un error para nosotros, la clínica ya la
    // tiene, que es justo lo que queremos. Meta lo contesta como
    // "Invalid parameter" genérico (code 100), así que se reconoce por el
    // subcódigo o por el texto del motivo, no por `message`.
    if (
      payload.error?.error_subcode === 2388024 ||
      /already exist|ya existe/i.test(`${payload.error?.message ?? ""} ${detalle}`)
    ) {
      return { name: template.name, outcome: "ya_existia" };
    }

    return {
      name: template.name,
      outcome: "error",
      error:
        [payload.error?.message, detalle, payload.error?.error_subcode && `(subcódigo ${payload.error.error_subcode})`]
          .filter(Boolean)
          .join(" — ") || `Meta devolvió ${response.status}`,
    };
  } catch (error) {
    return {
      name: template.name,
      outcome: "error",
      error: error instanceof Error ? error.message : "Error desconocido",
    };
  }
}

/**
 * Estado de revisión de las plantillas en el WABA de la clínica.
 *
 * Sirve para la pantalla de alta: crear una plantilla no alcanza, hay que
 * ver que Meta la haya aprobado antes de prometerle a la clínica que los
 * recordatorios funcionan. Una en `REJECTED` es la causa típica de "el
 * recordatorio no le llegó a nadie".
 */
export async function templateStatuses(
  creds: WabaCreds
): Promise<Array<{ name: string; status: string; category?: string }>> {
  const response = await fetch(
    `${GRAPH_API_BASE}/${creds.wabaId}/message_templates?fields=name,status,category&limit=100`,
    { headers: { Authorization: `Bearer ${creds.token}` } }
  );

  if (!response.ok) {
    throw new Error(`No se pudieron leer las plantillas: ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ name: string; status: string; category?: string }>;
  };
  return payload.data ?? [];
}

/**
 * El texto de una plantilla con sus parámetros puestos. Sirve para dejar en el
 * historial de la conversación lo que se le mandó al paciente: cuando responde,
 * el asistente tiene que saber a qué está contestando.
 */
export function renderTemplateBody(name: string, params: string[]): string | null {
  const plantilla = CLINIC_TEMPLATES.find((t) => t.name === name);
  if (!plantilla) return null;
  return plantilla.body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => params[Number(n) - 1] ?? "");
}
