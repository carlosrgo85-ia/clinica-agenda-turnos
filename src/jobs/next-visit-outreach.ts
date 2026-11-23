import { PLAN_FEATURES, planIncludes } from "../config/plan-features";
import { prisma } from "../db/client";
import { listActiveClinics, appendConversationMessage } from "../repositories/clinics.repository";
import { recordSystemAudit } from "../services/audit";
import { recordSystemEvent, describeError, SYSTEM_EVENT_KINDS } from "../services/system-events";
import { findPatientsDueForOutreach, sanitizeTemplateParam } from "../services/next-visit";
import { patientNameParts } from "../services/patient-admin";
import { clinicMinutesFromMidnight } from "../services/time";
import { clinicWhatsAppCreds, sendTemplateMessage } from "../services/whatsapp";
import { renderTemplateBody } from "../services/whatsapp-templates";
import { reportJobError, trackedCron } from "./tracked-cron";

/**
 * Le escribe a los pacientes cuya próxima cita sugerida se acerca y todavía no
 * tienen turno, por la plantilla `proximo_control`.
 *
 * **Apagado por defecto** (`Clinic.nextVisitOutreachEnabled`): escribirle primero
 * a alguien que no lo pidió es la forma más rápida de que la clínica apague el bot,
 * y la plantilla tiene que estar aprobada por Meta en cada WABA. Lo prende el
 * super-admin cuando la clínica está lista.
 *
 * - **Un solo mensaje por sugerencia** (`Patient.nextVisitOutreachSentAt`); cambiar
 *   la fecha sugerida lo rearma. Se reclama ANTES de enviar (con un UPDATE
 *   condicionado), así que dos corridas no le escriben dos veces; si el envío
 *   falla, se libera y se reintenta.
 * - **Lo mandado queda en el historial** de la conversación como mensaje del
 *   asistente: cuando el paciente responde, el asistente sabe a qué está
 *   contestando (y por eso puede seguir con el tono de la invitación).
 * - **Si el envío falla, se corta la tanda de esa clínica** y se deja UN evento: con
 *   la plantilla sin aprobar, fallaría para todos los pacientes y llenaría
 *   Monitoreo de errores iguales.
 * - Solo en el horario de la clínica, y como máximo `MAX_OUTREACH_PER_RUN` por
 *   corrida.
 */

export const OUTREACH_FROM_HOUR = 9;
export const OUTREACH_TO_HOUR = 18;

export function scheduleNextVisitOutreach(): void {
  trackedCron("next-visit-outreach", "40 * * * *", async () => {
    await runNextVisitOutreach();
  });
}

export interface OutreachDeps {
  send: typeof sendTemplateMessage;
}

const defaultDeps: OutreachDeps = { send: sendTemplateMessage };

/** Devuelve cuántos mensajes se mandaron. */
export async function runNextVisitOutreach(
  now = new Date(),
  deps: OutreachDeps = defaultDeps,
  options?: { clinicIds?: string[] }
): Promise<number> {
  const clinics = await listActiveClinics();
  let enviados = 0;

  for (const clinic of clinics) {
    // Dos llaves: el plan lo incluye (Plus) Y el super-admin lo prendió en esta clínica (después de aprobar la plantilla).
    if (!clinic.nextVisitOutreachEnabled || !planIncludes(clinic, PLAN_FEATURES.NEXT_VISIT_OUTREACH)) continue;
    if (options?.clinicIds && !options.clinicIds.includes(clinic.id)) continue;

    // Un problema de una clínica no puede dejar sin aviso a las que faltan.
    try {
      const hora = Math.floor(clinicMinutesFromMidnight(now, clinic.timezone) / 60);
      if (hora < OUTREACH_FROM_HOUR || hora > OUTREACH_TO_HOUR) continue;

      const pacientes = await findPatientsDueForOutreach({
        clinicId: clinic.id,
        timezone: clinic.timezone,
        leadDays: clinic.nextVisitOutreachLeadDays,
        now,
      });

      for (const p of pacientes) {
        // Se reclama antes de enviar: sin esto, dos corridas superpuestas le
        // escribirían dos veces al mismo paciente.
        const { count } = await prisma.patient.updateMany({
          where: { id: p.id, nextVisitOutreachSentAt: null },
          data: { nextVisitOutreachSentAt: now },
        });
        if (count === 0) continue;

        const nombre = sanitizeTemplateParam(
          p.firstName ?? patientNameParts({ name: p.name, firstName: null, lastName: null }).firstName,
          "paciente"
        );
        const params = [
          nombre,
          sanitizeTemplateParam(clinic.name, "la clínica", 80),
          sanitizeTemplateParam(p.suggestedNextVisitNote ?? "", "control"),
        ];

        try {
          await deps.send(clinicWhatsAppCreds(clinic), p.phone, clinic.nextVisitTemplateName, "es", params);
        } catch (error) {
          // Se libera para reintentar, y se corta la tanda: con la plantilla sin
          // aprobar fallaría para todos y llenaría Monitoreo de lo mismo.
          await prisma.patient.update({ where: { id: p.id }, data: { nextVisitOutreachSentAt: null } });
          await recordSystemEvent({
            kind: SYSTEM_EVENT_KINDS.WHATSAPP_ENVIO,
            clinicId: clinic.id,
            message: `Próxima cita sugerida (plantilla ${clinic.nextVisitTemplateName}): ${describeError(error)}`,
          });
          break;
        }

        enviados += 1;
        // Se le escribió a un paciente por iniciativa de la clínica: queda registrado.
        await recordSystemAudit({
          origin: "sistema",
          clinicId: clinic.id,
          action: "patient.outreach_sent",
          resourceType: "patients",
          resourceId: p.id,
          details: { plantilla: clinic.nextVisitTemplateName },
        });
        // Lo que se le mandó, en el historial: cuando responda, el asistente
        // tiene que saber a qué está contestando.
        const texto = renderTemplateBody(clinic.nextVisitTemplateName, params);
        if (texto) {
          await appendConversationMessage({
            clinicId: clinic.id,
            patientPhone: p.phone,
            role: "assistant",
            content: texto,
          }).catch((error) => console.error("No se pudo guardar el mensaje de contacto en el historial:", error));
        }
      }
    } catch (error) {
      await reportJobError(
        "next-visit-outreach",
        `Error contactando por la próxima cita sugerida a la clínica ${clinic.id}`,
        error,
        clinic.id
      );
    }
  }

  return enviados;
}
