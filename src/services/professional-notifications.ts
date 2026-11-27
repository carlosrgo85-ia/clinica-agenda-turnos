import type { Clinic, Professional } from "@prisma/client";
import { clinicDateKey, formatWallTime } from "./time";
import { sendProfessionalAppointmentEmail } from "./email";
import { clinicWhatsAppCreds, sendTemplateMessage } from "./whatsapp";
import { describeError, recordSystemEvent, SYSTEM_EVENT_KINDS } from "./system-events";

/**
 * Le avisa al profesional de lo que pasa con una cita suya: se la asignaron, cambió o se canceló.
 * Cada profesional elige por qué canal (mail, WhatsApp o ninguno) y de qué tipo de aviso (nuevas, cambios, cancelaciones).
 *
 * Es distinto del espejo en Google Calendar: ese es pasivo —hay que abrir la
 * agenda para enterarse— y esto le llega.
 *
 * **Los dos canales son opcionales y arrancan apagados**
 * (`notifyByEmail` / `notifyByWhatsapp`): mandarle mensajes a alguien que no
 * los pidió es la forma más rápida de que la clínica apague el bot entero.
 *
 * **Nada de esto puede tumbar la creación del turno.** Se llama después de
 * cerrar la transacción, por el mismo motivo que el espejo en Calendar —son
 * llamadas de red—, y cada canal falla por su cuenta: si el mail rebota, el
 * WhatsApp sale igual.
 */

/** Qué le pasó a la cita, desde el punto de vista del profesional. */
export type EventoDeTurno = "agendada" | "modificada" | "cancelada";

/** Las plantillas, en el WABA de cada clínica, de cada tipo de aviso. */
export const PLANTILLAS_PROFESIONAL: Record<EventoDeTurno, string> = {
  agendada: "cita_asignada_profesional",
  modificada: "cita_modificada_profesional",
  cancelada: "cita_cancelada_profesional",
};
/** Compatibilidad: la de citas nuevas. */
export const PLANTILLA_CITA_PROFESIONAL = PLANTILLAS_PROFESIONAL.agendada;

/** La preferencia de cada profesional que decide si se le avisa de ese tipo de evento. */
const PREFERENCIA: Record<EventoDeTurno, "notifyOnCreate" | "notifyOnChange" | "notifyOnCancel"> = {
  agendada: "notifyOnCreate",
  modificada: "notifyOnChange",
  cancelada: "notifyOnCancel",
};

/** Lo que hay que leer de un profesional para avisarle (para los `select` de quien llama). */
export const PROFESSIONAL_NOTIFY_SELECT = {
  name: true,
  contactEmail: true,
  whatsappPhone: true,
  notifyByEmail: true,
  notifyByWhatsapp: true,
  notifyOnCreate: true,
  notifyOnChange: true,
  notifyOnCancel: true,
} as const;

/** Lo que hay que saber de un profesional para avisarle. Las tres preferencias son opcionales: ausente = prendido. */
export type ProfessionalNotifyFields = Pick<
  Professional,
  "name" | "contactEmail" | "whatsappPhone" | "notifyByEmail" | "notifyByWhatsapp"
> &
  Partial<Pick<Professional, "notifyOnCreate" | "notifyOnChange" | "notifyOnCancel">>;

export interface NotificacionDeTurno {
  clinic: Clinic;
  appointmentId: string;
  professional: ProfessionalNotifyFields;
  /** Qué le pasó a la cita. Default: recién agendada. */
  evento?: EventoDeTurno;
  /** Solo en `cancelada`: la cita no se canceló, pasó a otro profesional. */
  reasignada?: boolean;
  startTime: Date;
  endTime: Date;
  service: string;
  patientName: string;
  roomName: string | null;
  preferredRoomUnavailable: boolean;
}

export async function notifyProfessionalOfAppointment(
  params: NotificacionDeTurno
): Promise<void> {
  const { clinic, professional } = params;
  const evento = params.evento ?? "agendada";

  // Sin canal elegido no sale nada, y si eligió canal pero no ese tipo de aviso tampoco. Un valor ausente cuenta como
  // prendido (es el default de la base): solo un `false` explícito lo apaga.
  if (professional[PREFERENCIA[evento]] === false) return;

  // La fecha y la hora, en hora de pared de la clínica. Nunca con métodos
  // locales de `Date`: eso usaría la zona del servidor.
  const fecha = clinicDateKey(params.startTime, clinic.timezone);
  const hora = formatWallTime(params.startTime, clinic.timezone);

  if (professional.notifyByEmail && professional.contactEmail) {
    try {
      await sendProfessionalAppointmentEmail({
        clinicName: clinic.name,
        // El organizador de la invitación es la clínica, no el servidor de
        // correo: es a quien le responde el profesional si acepta o rechaza.
        clinicEmail: clinic.email,
        to: professional.contactEmail,
        professionalName: professional.name,
        appointmentId: params.appointmentId,
        start: params.startTime,
        end: params.endTime,
        fecha,
        hora,
        service: params.service,
        patientName: params.patientName,
        roomName: params.roomName,
        preferredRoomUnavailable: params.preferredRoomUnavailable,
        evento,
        reasignada: params.reasignada,
      });
    } catch (error) {
      console.error(
        `No se pudo avisarle por mail a ${professional.name} de la clínica ${clinic.id}:`,
        error
      );
    }
  }

  if (professional.notifyByWhatsapp && professional.whatsappPhone) {
    try {
      /**
       * Va por PLANTILLA y no por texto libre: el profesional no le escribió
       * al bot, así que la ventana de 24hs está cerrada y Meta rechaza
       * cualquier mensaje que no sea una plantilla aprobada.
       *
       * Mientras la plantilla de ese aviso (`PLANTILLAS_PROFESIONAL`) siga pendiente de aprobación en
       * el WABA de la clínica, esto va a fallar y quedar logueado. El turno
       * se crea igual — mismo criterio que el espejo en Calendar.
       */
      await sendTemplateMessage(
        clinicWhatsAppCreds(clinic),
        professional.whatsappPhone,
        PLANTILLAS_PROFESIONAL[evento],
        "es",
        [professional.name, fecha, hora, params.service, params.patientName]
      );
    } catch (error) {
      console.error(
        `No se pudo avisarle por WhatsApp a ${professional.name} de la clínica ${clinic.id}:`,
        error
      );
      await recordSystemEvent({
        kind: SYSTEM_EVENT_KINDS.WHATSAPP_ENVIO,
        clinicId: clinic.id,
        message: `Aviso al profesional: ${describeError(error)}`,
      });
    }
  }
}
