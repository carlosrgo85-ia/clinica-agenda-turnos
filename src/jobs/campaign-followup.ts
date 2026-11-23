import { PLAN_FEATURES, planIncludes } from "../config/plan-features";
import { prisma } from "../db/client";
import { appendConversationMessage, listActiveClinics } from "../repositories/clinics.repository";
import { recordSystemAudit } from "../services/audit";
import { closeLead } from "../services/campaigns";
import { sanitizeTemplateParam } from "../services/next-visit";
import { patientNameParts } from "../services/patient-admin";
import { SANDBOX_PHONE_PREFIX } from "../services/sandbox-phone";
import { describeError, recordSystemEvent, SYSTEM_EVENT_KINDS } from "../services/system-events";
import { clinicMinutesFromMidnight } from "../services/time";
import { clinicWhatsAppCreds, sendTemplateMessage } from "../services/whatsapp";
import { renderTemplateBody } from "../services/whatsapp-templates";
import { reportJobError, trackedCron } from "./tracked-cron";

/**
 * Seguimiento de quienes llegaron por una campaña, preguntaron y NO agendaron: un mensaje por la
 * plantilla `seguimiento_campana` para que se conviertan en pacientes.
 *
 * **Con tope, para no insistir por siempre**: cada campaña define cuántos intentos (0 a 5; 0 = sin
 * seguimiento), cuánto después de su último mensaje se le escribe por primera vez y cada cuánto el
 * siguiente. Cuando se agotan los intentos y no contesta, el contacto se cierra como `sin_respuesta` y no
 * se le escribe más. Un tope de 5 lo impone un CHECK de la base: ninguna configuración puede saltarlo.
 *
 * **Apagado por defecto** (`Clinic.campaignFollowUpEnabled`): va por una plantilla que Meta tiene que
 * aprobar en cada WABA, y escribirle primero a alguien es la forma más rápida de que la clínica apague el
 * bot. Lo prende el super-admin. Con el interruptor apagado el seguimiento cuenta como 0 intentos y los
 * contactos igual se cierran: no quedan "abiertos" para siempre.
 *
 * - **No se le escribe a quien ya agendó** (se mira la agenda, no solo el contacto: una asistente pudo
 *   cargarle la cita a mano) ni a quien pidió que no lo contacten (`Patient.outreachOptOut`).
 * - **Cada envío se reclama antes de mandarlo** (un UPDATE condicionado al contador), así dos corridas
 *   no le escriben dos veces; si el envío falla se libera y **se corta la tanda de esa clínica** con UN
 *   solo evento (con la plantilla sin aprobar fallaría para todos).
 * - Solo en el horario de la clínica y como máximo `MAX_FOLLOWUPS_PER_RUN` por clínica por corrida.
 * - Lo mandado queda en el historial de la conversación y en la auditoría (origen `sistema`), sin el
 *   teléfono.
 */

export const FOLLOWUP_TEMPLATE_NAME = "seguimiento_campana";
export const FOLLOWUP_FROM_HOUR = 9;
export const FOLLOWUP_TO_HOUR = 18;
export const MAX_FOLLOWUPS_PER_RUN = 20;
const HORA_MS = 3_600_000;

export function scheduleCampaignFollowUp(): void {
  trackedCron("campaign-followup", "50 * * * *", async () => {
    await runCampaignFollowUp();
  });
}

export interface CampaignFollowUpDeps {
  send: typeof sendTemplateMessage;
}
const defaultDeps: CampaignFollowUpDeps = { send: sendTemplateMessage };

/** Cuándo le toca el próximo seguimiento a un contacto. */
export function nextFollowUpAt(lead: {
  followUpCount: number;
  lastInboundAt: Date;
  lastFollowUpAt: Date | null;
}, campaign: { followUpAfterHours: number; followUpIntervalHours: number }): Date {
  if (lead.followUpCount === 0 || !lead.lastFollowUpAt) {
    return new Date(lead.lastInboundAt.getTime() + campaign.followUpAfterHours * HORA_MS);
  }
  // Si contestó después del último seguimiento, la espera arranca de su mensaje.
  const base = Math.max(lead.lastFollowUpAt.getTime(), lead.lastInboundAt.getTime());
  return new Date(base + campaign.followUpIntervalHours * HORA_MS);
}

/** Devuelve cuántos seguimientos se mandaron. */
export async function runCampaignFollowUp(
  now = new Date(),
  deps: CampaignFollowUpDeps = defaultDeps,
  options?: { clinicIds?: string[] }
): Promise<number> {
  const clinics = await listActiveClinics();
  let enviados = 0;

  for (const clinic of clinics) {
    if (options?.clinicIds && !options.clinicIds.includes(clinic.id)) continue;
    // Un problema de una clínica no puede dejar sin seguimiento a las que faltan.
    try {
      // Dos llaves: el plan lo incluye (Plus) Y el super-admin lo prendió en esta clínica (después de aprobar la plantilla).
      // Sin alguna de las dos cuenta como apagado: los contactos igual se cierran, no quedan abiertos para siempre.
      const habilitado = clinic.campaignFollowUpEnabled && planIncludes(clinic, PLAN_FEATURES.CAMPAIGN_FOLLOWUP);
      await closeStaleLeads(clinic.id, habilitado, now);

      if (!habilitado) continue;
      const hora = Math.floor(clinicMinutesFromMidnight(now, clinic.timezone) / 60);
      if (hora < FOLLOWUP_FROM_HOUR || hora > FOLLOWUP_TO_HOUR) continue;

      enviados += await sendFollowUpsForClinic(clinic, now, deps);
    } catch (error) {
      await reportJobError("campaign-followup", `Error en el seguimiento de campañas de la clínica ${clinic.id}`, error, clinic.id);
    }
  }
  return enviados;
}

/**
 * Cierra los contactos que ya no hay nada más que hacer con ellos:
 * - su campaña se desactivó (`campana_inactiva`), o
 * - se agotaron los intentos (los de la campaña; 0 si el seguimiento está apagado en la clínica) y pasó la
 *   espera sin que contestara (`sin_respuesta`).
 */
export async function closeStaleLeads(clinicId: string, followUpEnabled: boolean, now: Date): Promise<number> {
  const abiertos = await prisma.campaignLead.findMany({
    where: { clinicId, status: "abierto" },
    include: { campaign: { select: { active: true, followUpMaxAttempts: true, followUpIntervalHours: true } } },
  });
  let cerrados = 0;
  for (const lead of abiertos) {
    let motivo: "campana_inactiva" | "sin_respuesta" | null = null;
    if (!lead.campaign.active) {
      motivo = "campana_inactiva";
    } else {
      const maximo = followUpEnabled ? lead.campaign.followUpMaxAttempts : 0;
      if (lead.followUpCount >= maximo) {
        const ultimaActividad = Math.max(lead.lastInboundAt.getTime(), lead.lastFollowUpAt?.getTime() ?? 0);
        if (now.getTime() >= ultimaActividad + lead.campaign.followUpIntervalHours * HORA_MS) motivo = "sin_respuesta";
      }
    }
    if (motivo && (await closeLead({ clinicId, leadId: lead.id, reason: motivo, now }))) cerrados += 1;
  }
  return cerrados;
}

async function sendFollowUpsForClinic(
  clinic: Awaited<ReturnType<typeof listActiveClinics>>[number],
  now: Date,
  deps: CampaignFollowUpDeps
): Promise<number> {
  const candidatos = await prisma.campaignLead.findMany({
    where: {
      clinicId: clinic.id,
      status: "abierto",
      // Chat de pruebas: a un contacto de prueba no se le escribe.
      NOT: { patientPhone: { startsWith: SANDBOX_PHONE_PREFIX } },
      campaign: { active: true, followUpMaxAttempts: { gt: 0 } },
    },
    orderBy: { lastInboundAt: "asc" },
    take: 200,
    include: { campaign: true },
  });
  const debidos = candidatos.filter(
    (l) => l.followUpCount < l.campaign.followUpMaxAttempts && nextFollowUpAt(l, l.campaign).getTime() <= now.getTime()
  );

  let enviados = 0;
  for (const lead of debidos) {
    if (enviados >= MAX_FOLLOWUPS_PER_RUN) break;

    const personas = await prisma.patient.findMany({
      where: { clinicId: clinic.id, phone: lead.patientPhone },
      orderBy: { createdAt: "asc" },
    });
    // Pidió que no lo contacten: se cierra, no se le escribe.
    if (personas.some((p) => p.outreachOptOut)) {
      await closeLead({ clinicId: clinic.id, leadId: lead.id, reason: "solicitud_del_paciente", now });
      continue;
    }
    // Ya agendó (aunque se lo haya cargado la clínica a mano): pasa a convertido y no se le insiste.
    const yaAgendo = await prisma.appointment.count({
      where: {
        clinicId: clinic.id,
        patientId: { in: personas.map((p) => p.id) },
        status: { not: "cancelado" },
        createdAt: { gte: lead.firstMessageAt },
      },
    });
    if (yaAgendo > 0) {
      const { count } = await prisma.campaignLead.updateMany({
        where: { id: lead.id, status: "abierto" },
        data: { status: "convertido", convertedAt: now },
      });
      if (count > 0) {
        await recordSystemAudit({
          origin: "sistema",
          clinicId: clinic.id,
          action: "campaign.lead_converted",
          resourceType: "campaign_leads",
          resourceId: lead.id,
          details: { campaignId: lead.campaignId, detectadoPorElSeguimiento: true },
        });
      }
      continue;
    }

    // Se reclama antes de enviar: sin esto, dos corridas superpuestas le escribirían dos veces.
    const { count } = await prisma.campaignLead.updateMany({
      where: { id: lead.id, status: "abierto", followUpCount: lead.followUpCount },
      data: { followUpCount: { increment: 1 }, lastFollowUpAt: now },
    });
    if (count === 0) continue;

    const titular = personas[0];
    const params = [
      sanitizeTemplateParam(titular?.firstName ?? patientNameParts({ name: titular?.name ?? null, firstName: null, lastName: null }).firstName, "paciente"),
      sanitizeTemplateParam(clinic.name, "la clínica", 80),
      sanitizeTemplateParam(lead.campaign.name, "nuestra promoción", 80),
    ];

    try {
      await deps.send(clinicWhatsAppCreds(clinic), lead.patientPhone, FOLLOWUP_TEMPLATE_NAME, "es", params);
    } catch (error) {
      // Se libera para reintentar, y se corta la tanda: con la plantilla sin aprobar fallaría para todos.
      await prisma.campaignLead.update({
        where: { id: lead.id },
        data: { followUpCount: lead.followUpCount, lastFollowUpAt: lead.lastFollowUpAt },
      });
      await recordSystemEvent({
        kind: SYSTEM_EVENT_KINDS.WHATSAPP_ENVIO,
        clinicId: clinic.id,
        message: `Seguimiento de campaña (plantilla ${FOLLOWUP_TEMPLATE_NAME}): ${describeError(error)}`,
      });
      break;
    }

    enviados += 1;
    await recordSystemAudit({
      origin: "sistema",
      clinicId: clinic.id,
      action: "campaign.followup_sent",
      resourceType: "campaign_leads",
      resourceId: lead.id,
      // Sin teléfono ni nombre: solo qué campaña y qué intento.
      details: { campaignId: lead.campaignId, intento: lead.followUpCount + 1, plantilla: FOLLOWUP_TEMPLATE_NAME },
    });
    const texto = renderTemplateBody(FOLLOWUP_TEMPLATE_NAME, params);
    if (texto) {
      await appendConversationMessage({ clinicId: clinic.id, patientPhone: lead.patientPhone, role: "assistant", content: texto }).catch(
        (error) => console.error("No se pudo guardar el seguimiento en el historial:", error)
      );
    }
  }
  return enviados;
}
