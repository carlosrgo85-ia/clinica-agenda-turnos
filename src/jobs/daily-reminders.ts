import { reportJobError, trackedCron } from "./tracked-cron";
import { prisma } from "../db/client";
import {
  clinicWhatsAppCreds,
  sendTemplateMessage,
  type ClinicWhatsAppCreds,
} from "../services/whatsapp";
import { listActiveClinics } from "../repositories/clinics.repository";
import { SANDBOX_PATIENT_FILTER } from "../services/sandbox-phone";
import { clinicDateKey, formatWallTime } from "../services/time";

const HORA_MS = 3_600_000;

/**
 * Recordatorio de 24hs antes. Incluido para todas las clínicas activas.
 *
 * **Corre cada hora**, igual que el de 2hs: cada pasada avisa a quienes tienen su cita entre 23 y
 * 24 horas más adelante. Antes corría una sola vez por día (a las 18:00 del servidor) con esa misma
 * ventana de una hora, así que solo recordaba las citas de las 17:00 a las 18:00 del día siguiente
 * y el resto de los pacientes no recibía nada. Cada hora, cada cita cae en exactamente una pasada,
 * sin importar la zona horaria de la clínica.
 *
 * Cada clínica va en su propio try/catch: si una falla (una query, un
 * token vencido, lo que sea), no puede tirar abajo el resto del cron ni,
 * si la excepción escapa del callback async de node-cron, matar el
 * proceso entero (Node >=15 aborta en una promesa rechazada sin manejar).
 */
export function scheduleDailyReminders(): void {
  trackedCron("daily-reminders", "0 * * * *", async () => {
    await runReminderRound({ job: "daily-reminders", hoursAhead: 24 });
  });
}

/**
 * Una pasada de recordatorios sobre las clínicas activas (las que cumplan `appliesTo`, si se
 * pasa). Es la misma para el de 24hs y el de 2hs: solo cambia la anticipación y a quién aplica.
 * Exportada y con la hora inyectable para poder probarla sin cron.
 */
export async function runReminderRound(params: {
  /** Nombre del cron, para el latido y los errores de Monitoreo. */
  job: string;
  hoursAhead: number;
  /** Filtro por clínica (el plan, por ejemplo). Por defecto, todas. */
  appliesTo?: (clinic: Awaited<ReturnType<typeof listActiveClinics>>[number]) => boolean;
  now?: Date;
}): Promise<void> {
  try {
    const clinics = (await listActiveClinics()).filter((c) => params.appliesTo?.(c) ?? true);
    for (const clinic of clinics) {
      try {
        await sendRemindersForWindow(
          clinic.id,
          clinicWhatsAppCreds(clinic),
          clinic.reminderTemplateName,
          params.hoursAhead,
          clinic.timezone,
          params.now
        );
      } catch (error) {
        await reportJobError(
          params.job,
          `Error mandando recordatorios de ${params.hoursAhead}hs de la clínica ${clinic.id}`,
          error,
          clinic.id
        );
      }
    }
  } catch (error) {
    await reportJobError(params.job, `Error en el cron de recordatorios de ${params.hoursAhead}hs`, error);
  }
}

/** "18/09/2026": el formato que usan las plantillas, en la fecha local de la clínica. */
export function reminderDate(instant: Date, timezone: string): string {
  const [y, m, d] = clinicDateKey(instant, timezone).split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Manda el recordatorio a quienes tienen una cita confirmada que empieza entre `hoursAhead - 1` y
 * `hoursAhead` horas después del comienzo de la hora en curso.
 *
 * **La ventana parte de la hora en punto, no del instante exacto**: con `new Date()` cada pasada
 * calculaba su ventana desde unos milisegundos distintos, y entre una pasada y la siguiente podía
 * quedar un hueco (o un solape) justo donde cae una cita que empieza en punto. Desde la hora en
 * punto, las ventanas de dos pasadas seguidas empalman exacto: cada cita cae en una sola.
 *
 * **La fecha y la hora que ve el paciente son las de la clínica** (`timezone`), no las del
 * servidor: con `toLocaleTimeString()` a secas, un servidor en UTC le decía a un paciente de México
 * una hora corrida 6 horas. Devuelve cuántos mandó y cuántos fallaron.
 */
/** Anticipación del recordatorio → columna de `Appointment` donde queda anotado que ya se mandó. */
const REMINDER_MARK: Record<number, "reminder24SentAt" | "reminder2hSentAt"> = {
  24: "reminder24SentAt",
  2: "reminder2hSentAt",
};

export async function sendRemindersForWindow(
  clinicId: string,
  creds: ClinicWhatsAppCreds,
  templateName: string,
  hoursAhead: number,
  timezone: string,
  now: Date = new Date()
): Promise<{ sent: number; failed: number }> {
  const horaEnPunto = Math.floor(now.getTime() / HORA_MS) * HORA_MS;
  const from = new Date(horaEnPunto + (hoursAhead - 1) * HORA_MS);
  const to = new Date(horaEnPunto + hoursAhead * HORA_MS);

  const appointments = await prisma.appointment.findMany({
    where: {
      clinicId,
      status: "confirmado",
      startTime: { gte: from, lt: to },
      // Chat de pruebas: a un paciente de prueba no se le escribe.
      NOT: { patient: SANDBOX_PATIENT_FILTER },
    },
    include: { patient: true },
  });

  // Qué marca guarda que este recordatorio ya salió (el de 24 h y el de 2 h son independientes).
  const marca = REMINDER_MARK[hoursAhead];
  if (!marca) throw new Error(`No hay marca de "ya enviado" para un recordatorio de ${hoursAhead} h.`);

  let sent = 0;
  let failed = 0;
  for (const appt of appointments) {
    if (!appt.patient.phone) continue;
    // Ya salió (una pasada anterior, o la otra instancia): no se repite.
    if (appt[marca] !== null) continue;

    // Se RECLAMA antes de mandar, con un UPDATE condicionado a que siga sin marca: si dos pasadas
    // (un reinicio justo en la hora, o dos instancias del worker) llegan a la vez, solo una gana y
    // la otra recibe 0. Mismo patrón que el contacto por próxima cita y el seguimiento de campañas.
    const reclamo = await prisma.appointment.updateMany({
      where: { id: appt.id, [marca]: null },
      data: { [marca]: new Date() },
    });
    if (reclamo.count === 0) continue;

    try {
      await sendTemplateMessage(
        creds,
        appt.patient.phone,
        templateName,
        "es",
        [
          appt.patient.name ?? "paciente",
          reminderDate(appt.startTime, timezone),
          formatWallTime(appt.startTime, timezone),
          appt.service,
        ]
      );
      sent += 1;
    } catch (error) {
      failed += 1;
      // El aviso no salió: se libera la marca para que un reintento (o la próxima corrida de esa misma
      // ventana) pueda mandarlo. Solo si falló: lo que Meta aceptó no se repite.
      await prisma.appointment.updateMany({ where: { id: appt.id }, data: { [marca]: null } }).catch(() => undefined);
      console.error(`Error enviando recordatorio de ${appt.id}:`, error);
    }
  }
  return { sent, failed };
}
