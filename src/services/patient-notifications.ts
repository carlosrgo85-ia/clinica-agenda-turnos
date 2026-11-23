import type { Clinic, Patient } from "@prisma/client";
import { clinicWhatsAppCreds, sendTemplateMessage } from "./whatsapp";
import { clinicDateKey, formatWallTime } from "./time";
import { describeError, recordSystemEvent, SYSTEM_EVENT_KINDS } from "./system-events";

/**
 * Avisos al PACIENTE cuando una persona de la clínica cambia o cancela su cita
 * desde la Agenda.
 *
 * Es un mensaje iniciado por la clínica, así que va SIEMPRE por plantilla
 * aprobada por Meta (`cita_modificada`, `cita_cancelada`; se crean solas en el
 * WABA al dar de alta la clínica, pero hay que esperar la aprobación). Nunca por
 * `sendTextMessage`.
 *
 * **Es opcional en cada cambio** (decisión del 2026-11-07): la asistente elige
 * si avisar. Nunca puede tumbar el cambio: la cita ya se modificó en Postgres,
 * y que Meta rechace la plantilla o el número no sea válido se loguea y se
 * devuelve en el resultado para mostrarlo en pantalla.
 */

export type PatientNoticeResult = { enviado: true } | { enviado: false; motivo: string };

/** "18/09/2026": la forma en que la clínica escribe las fechas en los avisos. */
function fechaCorta(instant: Date, timezone: string): string {
  const [anio, mes, dia] = clinicDateKey(instant, timezone).split("-");
  return `${dia}/${mes}/${anio}`;
}

export async function notifyPatientOfChange(params: {
  clinic: Pick<Clinic, "id" | "name" | "country" | "timezone" | "whatsappTokenEncrypted" | "whatsappPhoneNumberId">;
  patient: Pick<Patient, "name" | "phone">;
  kind: "modificada" | "cancelada";
  service: string;
  /** La hora VIGENTE: la nueva si se movió, la original si se canceló. */
  startTime: Date;
  professionalName: string;
}): Promise<PatientNoticeResult> {
  const { clinic, patient } = params;
  const nombre = patient.name ?? "";
  const fecha = fechaCorta(params.startTime, clinic.timezone);
  const hora = formatWallTime(params.startTime, clinic.timezone);

  try {
    await sendTemplateMessage(
      clinicWhatsAppCreds(clinic),
      patient.phone,
      params.kind === "modificada" ? "cita_modificada" : "cita_cancelada",
      "es",
      params.kind === "modificada"
        ? [nombre, params.service, fecha, hora, params.professionalName]
        : [nombre, params.service, fecha, hora, clinic.name]
    );
    return { enviado: true };
  } catch (error) {
    console.error(
      `No se pudo avisar al paciente del cambio de su cita (clínica ${clinic.id}):`,
      error
    );
    await recordSystemEvent({
      kind: SYSTEM_EVENT_KINDS.WHATSAPP_ENVIO,
      clinicId: clinic.id,
      message: `Aviso al paciente (${params.kind}): ${describeError(error)}`,
    });
    return {
      enviado: false,
      motivo: error instanceof Error ? error.message : "No se pudo enviar el WhatsApp",
    };
  }
}
