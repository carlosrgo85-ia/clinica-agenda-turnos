import { reportJobError, trackedCron } from "./tracked-cron";
import { recordAppointmentEvent } from "../services/appointment-events";
import { prisma } from "../db/client";
import { clinicWhatsAppCreds, sendTemplateMessage } from "../services/whatsapp";
import { PLAN_FEATURES } from "../config/plan-features";
import { listActiveClinics } from "../repositories/clinics.repository";
import { updatePatientStage } from "../repositories/patients.repository";
import { rememberTemplateSent } from "../services/template-history";
import { SANDBOX_PATIENT_FILTER } from "../services/sandbox-phone";

const FOLLOW_UP_TEMPLATE_NAME = "seguimiento_post_consulta"; // debe existir y estar aprobada en Meta

/**
 * Feature del plan de la clínica (`PLAN_FEATURES.POST_VISIT_FOLLOWUP`, ver
 * `Plan.features`). Corre cada hora, busca turnos que terminaron hace
 * ~24hs y no fueron marcados como "atendido" todavía: los marca en TODOS
 * los casos (eso es CRM, no depende del plan), y si el plan de la clínica
 * incluye el seguimiento, manda un mensaje preguntando cómo se sintió el
 * paciente. No da indicaciones clínicas — eso sigue prohibido por el
 * system prompt.
 */
/**
 * Cada clínica va en su propio try/catch: si una falla (la query, el
 * update, lo que sea), no puede tirar abajo el resto ni, si la excepción
 * escapa del callback async de node-cron, matar el proceso entero (Node
 * >=15 aborta en una promesa rechazada sin manejar).
 */
export function schedulePostVisitFollowUp(): void {
  trackedCron("post-visit-followup", "30 * * * *", async () => {
    await runPostVisitFollowUp();
  });
}

/**
 * Da por atendidas las citas que terminaron hace 24 horas y que nadie marcó, y (plan Plus)
 * manda el seguimiento. Es una función aparte, con la hora y las clínicas inyectables, para
 * poder probarla: antes vivía anónima dentro del cron.
 */
export async function runPostVisitFollowUp(
  now = new Date(),
  options?: { clinicIds?: string[] }
): Promise<void> {
  try {
    const clinics = (await listActiveClinics()).filter(
      (c) => !options?.clinicIds || options.clinicIds.includes(c.id)
    );

    const windowEnd = new Date(now);
    windowEnd.setHours(windowEnd.getHours() - 24);
    const windowStart = new Date(windowEnd);
    windowStart.setHours(windowStart.getHours() - 1);

    for (const clinic of clinics) {
      try {
        const appointments = await prisma.appointment.findMany({
          where: {
            clinicId: clinic.id,
            status: "confirmado",
            endTime: { gte: windowStart, lt: windowEnd },
            // Chat de pruebas: a un paciente de prueba no se le escribe.
            NOT: { patient: SANDBOX_PATIENT_FILTER },
          },
          include: { patient: true },
        });

        for (const appt of appointments) {
          // Lo da por atendido el SISTEMA a las 24 horas, sin que nadie lo confirme:
          // queda registrado como tal para que los reportes distingan lo
          // confirmado por una persona de esto.
          await prisma.$transaction(async (tx) => {
            await tx.appointment.update({ where: { id: appt.id }, data: { status: "atendido" } });
            await recordAppointmentEvent(tx, {
              clinicId: clinic.id,
              appointmentId: appt.id,
              type: "atendida",
              actorKind: "sistema",
              details: { automatica: true },
            });
          });
          await updatePatientStage(appt.patientId, "atendido", { origin: "sistema", motivo: "seguimiento_automatico" });

          if (clinic.plan?.features.includes(PLAN_FEATURES.POST_VISIT_FOLLOWUP)) {
            try {
              const parametros = [appt.patient.name ?? "paciente", clinic.name];
              await sendTemplateMessage(clinicWhatsAppCreds(clinic), appt.patient.phone, FOLLOW_UP_TEMPLATE_NAME, "es", parametros);
              await rememberTemplateSent({
                clinicId: clinic.id,
                patientPhone: appt.patient.phone,
                templateName: FOLLOW_UP_TEMPLATE_NAME,
                parameters: parametros,
              });
            } catch (error) {
              await reportJobError(
                "post-visit-followup",
                `Error enviando seguimiento post-consulta de ${appt.id}`,
                error,
                clinic.id
              );
            }
          }
        }
      } catch (error) {
        await reportJobError(
          "post-visit-followup",
          `Error en el seguimiento post-consulta de la clínica ${clinic.id}`,
          error,
          clinic.id
        );
      }
    }
  } catch (error) {
    await reportJobError("post-visit-followup", "Error en el cron de seguimiento post-consulta", error);
  }

}
