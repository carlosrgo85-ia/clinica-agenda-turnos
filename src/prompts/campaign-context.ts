/**
 * Qué se le cuenta al asistente de la campaña por la que llegó esta persona
 * (`services/campaigns.ts` → `getCampaignContextForPhone`).
 *
 * Va en el mensaje de cada turno, no en el system prompt (que se cachea y no puede cambiar de un
 * mensaje a otro). **Solo lo que está cargado**: el asistente no inventa precios, descuentos ni
 * condiciones, así que si no hay descripción se lo dice explícitamente.
 */

export const SIN_CAMPANA = "Ninguna: esta persona no llegó por una campaña ni por una promoción.";

export interface CampaignPromptInput {
  name: string;
  channel: string | null;
  description: string | null;
  /** Estado a hoy: la promoción solo se ofrece si está vigente. */
  status: "vigente" | "vencida" | "programada" | "inactiva";
  /** YYYY-MM-DD, para decir hasta cuándo rige. */
  endsOn: string | null;
  startsOn: string | null;
  serviceName: string | null;
  /** Los profesionales que atienden el servicio de la promoción, ya con su título ("Dra. Gómez"). */
  professionals: string[];
}

export function describeCampaignContext(input: CampaignPromptInput | null): string {
  if (!input) return SIN_CAMPANA;

  const origen = input.channel ? ` (canal: ${input.channel})` : "";
  const lineas: string[] = [`Llegó por la campaña "${input.name}"${origen}.`];

  if (input.status === "vigente") {
    lineas.push(`La promoción está VIGENTE${input.endsOn ? ` (hasta el ${input.endsOn})` : ""}.`);
    lineas.push(
      input.description
        ? `Qué es la promoción (lo ÚNICO que se puede contar de ella): ${input.description}`
        : "No hay detalle cargado de la promoción: no cuentes condiciones, precios ni descuentos."
    );
    if (input.serviceName) {
      lineas.push(`Servicio de la promoción: ${input.serviceName}.`);
      lineas.push(
        input.professionals.length > 0
          ? `Lo atienden: ${input.professionals.join(", ")}.`
          : "Todavía no hay un profesional que lo atienda: no ofrezcas horarios de ese servicio."
      );
    }
  } else if (input.status === "programada") {
    lineas.push(`La promoción TODAVÍA NO EMPEZÓ${input.startsOn ? ` (empieza el ${input.startsOn})` : ""}: no la ofrezcas ni la prometas.`);
  } else {
    lineas.push(
      `La promoción YA NO ESTÁ VIGENTE${input.endsOn ? ` (terminó el ${input.endsOn})` : ""}: no la ofrezcas ni la prometas. Si pregunta por ella, explícale con amabilidad que terminó y ofrécele el servicio en las condiciones normales.`
    );
  }
  return lineas.join("\n");
}

// --- Las promociones vigentes de la clínica ---

export const SIN_PROMOCIONES = "Ninguna: la clínica no tiene ninguna promoción vigente.";
/** Cuántas se le muestran como máximo: la lista va en cada mensaje y cuesta tokens. */
export const MAX_PROMOCIONES_EN_EL_PROMPT = 10;
const MAX_DETALLE = 500;

export interface PromotionPromptInput {
  name: string;
  description: string | null;
  serviceName: string | null;
  professionals: string[];
}

/**
 * Las promociones que hoy rigen, para que el asistente reconozca a cuál se refiere una persona que no escribió la frase exacta
 * de ningún formato, y conteste con lo que dice cada una. **Solo las vigentes** (activas y dentro de sus fechas): nunca se
 * le muestra una vencida, que terminaría ofreciendo. Sin detalle cargado se le dice que no cuente condiciones.
 */
export function describeActivePromotions(promotions: PromotionPromptInput[]): string {
  if (promotions.length === 0) return SIN_PROMOCIONES;
  return promotions
    .slice(0, MAX_PROMOCIONES_EN_EL_PROMPT)
    .map((p, i) => {
      const detalle = p.description?.trim()
        ? p.description.trim().replace(/\s+/g, " ").slice(0, MAX_DETALLE)
        : "no hay detalle cargado: no cuentes condiciones, precios ni descuentos";
      const servicio = p.serviceName ? ` Servicio: ${p.serviceName}.` : "";
      const atienden = p.serviceName && p.professionals.length > 0 ? ` Lo atienden: ${p.professionals.join(", ")}.` : "";
      return `${i + 1}. "${p.name}" —${servicio}${atienden} Detalle: ${detalle}`;
    })
    .join("\n");
}
