import { reportJobError, trackedCron } from "./tracked-cron";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { sendMissingWorkingHoursAlert, sendPendingHolidaysAlert } from "../services/email";
import { clinicWhatsAppCreds, sendTemplateMessage } from "../services/whatsapp";
import { getConfigHealth } from "../services/config-health";
import { pendingHolidaysByYear } from "../services/holidays";
import { describeError, recordSystemEvent, SYSTEM_EVENT_KINDS } from "../services/system-events";

/**
 * Avisos de configuración incompleta a las clínicas.
 *
 * Dos avisos, con cadencias distintas porque tienen urgencias distintas:
 *
 * - **Horario de atención faltante**: diario. Es bloqueante — en ese estado
 *   `services/booking.ts` rechaza todo turno (`clinica_sin_horario`) y no se
 *   le ofrece ningún horario al paciente: la clínica no puede agendar.
 * - **Feriados sin cargar**: semanal. Es una advertencia; el sistema
 *   funciona, pero esos días va a ofrecer turnos.
 *
 * Cada aviso va por email a `Clinic.email` y, si la clínica cargó un
 * `adminPhone`, también por WhatsApp — que es bastante más visible que una
 * casilla que nadie mira. El WhatsApp va SIEMPRE por plantilla aprobada,
 * nunca por `sendTextMessage` (ver CLAUDE.md).
 */

const HORAS_ENTRE_AVISOS_HORARIO = 24;
const HORAS_ENTRE_AVISOS_FERIADOS = 24 * 7;

export function scheduleConfigAlerts(): void {
  // 8 de la mañana, después del reporte diario, para que no lleguen juntos.
  trackedCron("config-alerts", "0 8 * * *", async () => {
    try {
      await alertClinicsMissingWorkingHours();
    } catch (error) {
      await reportJobError("config-alerts", "Error mandando avisos de horario faltante", error);
    }

    try {
      await alertClinicsPendingHolidays();
    } catch (error) {
      await reportJobError("config-alerts", "Error mandando avisos de feriados sin cargar", error);
    }
  });
}

/** ¿Pasó suficiente tiempo desde el último aviso? */
function toca(ultimoAviso: Date | null, now: Date, horasMinimas: number): boolean {
  if (!ultimoAviso) return true;
  const horas = (now.getTime() - ultimoAviso.getTime()) / (1000 * 60 * 60);
  return horas >= horasMinimas;
}

/**
 * Manda el aviso por WhatsApp al número interno de la clínica, si tiene uno.
 *
 * Los errores no se propagan: el aviso por email ya salió, y que falle el
 * WhatsApp (plantilla no aprobada todavía, número mal cargado) no tiene que
 * hacer fracasar el ciclo ni impedir que se marque como avisado.
 */
export async function avisarPorWhatsApp(
  clinic: {
    id: string;
    name: string;
    country: string | null;
    adminPhone: string | null;
    whatsappTokenEncrypted: string;
    whatsappPhoneNumberId: string;
    configAlertTemplateName: string;
  },
  parametros: string[]
): Promise<void> {
  if (!clinic.adminPhone) return;

  try {
    await sendTemplateMessage(
      clinicWhatsAppCreds(clinic),
      clinic.adminPhone,
      clinic.configAlertTemplateName,
      "es",
      parametros
    );
  } catch (error) {
    console.error(`No se pudo avisar por WhatsApp a la clínica ${clinic.id}:`, error);
    await recordSystemEvent({
      kind: SYSTEM_EVENT_KINDS.WHATSAPP_ENVIO,
      clinicId: clinic.id,
      message: `Aviso de configuración: ${describeError(error)}`,
    });
  }
}

const CLINIC_ALERT_FIELDS = {
  id: true,
  name: true,
  email: true,
  createdAt: true,
  adminPhone: true,
  whatsappTokenEncrypted: true,
  whatsappPhoneNumberId: true,
  configAlertTemplateName: true,
  workingHoursAlertSentAt: true,
  holidayAlertSentAt: true,
  country: true,
} as const;

/**
 * Busca las clínicas activas sin horario de atención y les manda el aviso.
 * Devuelve a cuántas se les avisó, para poder testearlo y loguearlo.
 *
 * `options.clinicIds` limita el chequeo a esas clínicas. El cron no lo usa
 * (recorre todas), pero sirve para re-chequear una clínica puntual después
 * de darla de alta, y para que los tests no dependan de qué otras clínicas
 * haya en la base.
 */
export async function alertClinicsMissingWorkingHours(
  now = new Date(),
  options?: { clinicIds?: string[] }
): Promise<number> {
  // Una clínica "sin horario" es una que no tiene ningún tramo a nivel
  // clínica. Los tramos de un profesional no cuentan: sin el de la clínica
  // no hay con qué validar (ver services/working-hours.ts).
  const clinics = await prisma.clinic.findMany({
    where: {
      active: true,
      workingHours: { none: { professionalId: null } },
      ...(options?.clinicIds ? { id: { in: options.clinicIds } } : {}),
    },
    select: CLINIC_ALERT_FIELDS,
  });

  let avisadas = 0;

  for (const clinic of clinics) {
    // El chequeo va contra la base y no contra el cron para que un reinicio
    // del proceso, o una segunda instancia corriendo el mismo cron, no
    // dupliquen el aviso.
    if (!toca(clinic.workingHoursAlertSentAt, now, HORAS_ENTRE_AVISOS_HORARIO)) continue;

    const diasSinCargar = Math.max(
      0,
      Math.floor((now.getTime() - clinic.createdAt.getTime()) / (1000 * 60 * 60 * 24))
    );
    const configUrl = buildConfigUrl(clinic.id);

    try {
      await sendMissingWorkingHoursAlert({
        clinicName: clinic.name,
        clinicEmail: clinic.email,
        configUrl,
        diasSinCargar,
      });
    } catch (error) {
      // Un mail que rebota no puede frenar el aviso a las demás clínicas.
      // No se marca como enviado, así que se reintenta al día siguiente.
      console.error(`No se pudo avisar por email a la clínica ${clinic.id}:`, error);
      continue;
    }

    await avisarPorWhatsApp(clinic, [
      clinic.name,
      "Falta cargar el horario de atención. Hasta que se cargue, el asistente no puede agendar citas.",
      configUrl,
    ]);

    await prisma.clinic.update({
      where: { id: clinic.id },
      data: { workingHoursAlertSentAt: now },
    });
    avisadas++;
  }

  if (avisadas > 0) {
    console.warn(`Aviso de horario de atención faltante enviado a ${avisadas} clínica(s).`);
  }

  return avisadas;
}

/**
 * Les avisa a las clínicas que tienen feriados nacionales del año sin
 * cargar. Semanal, porque no es urgente pero se olvida fácil.
 */
export async function alertClinicsPendingHolidays(
  now = new Date(),
  options?: { clinicIds?: string[] }
): Promise<number> {
  const clinics = await prisma.clinic.findMany({
    where: {
      active: true,
      // Sin país no hay catálogo con el que comparar.
      country: { not: null },
      ...(options?.clinicIds ? { id: { in: options.clinicIds } } : {}),
    },
    select: CLINIC_ALERT_FIELDS,
  });

  let avisadas = 0;

  for (const clinic of clinics) {
    if (!toca(clinic.holidayAlertSentAt, now, HORAS_ENTRE_AVISOS_FERIADOS)) continue;

    // Desde diciembre esto incluye el año siguiente, así el calendario
    // queda confirmado antes del 1 de enero.
    const porAnio = await pendingHolidaysByYear({ clinicId: clinic.id, now });
    if (porAnio.length === 0) continue;

    const pendientes = porAnio.reduce((suma, a) => suma + a.pendientes, 0);
    const configUrl = buildConfigUrl(clinic.id);

    try {
      await sendPendingHolidaysAlert({
        clinicName: clinic.name,
        clinicEmail: clinic.email,
        configUrl,
        pendientes,
        porAnio,
      });
    } catch (error) {
      console.error(`No se pudo avisar por email a la clínica ${clinic.id}:`, error);
      continue;
    }

    await avisarPorWhatsApp(clinic, [
      clinic.name,
      `Hay ${pendientes} feriado(s) de este año sin cargar. Esos días el asistente va a ofrecer citas.`,
      configUrl,
    ]);

    await prisma.clinic.update({
      where: { id: clinic.id },
      data: { holidayAlertSentAt: now },
    });
    avisadas++;
  }

  if (avisadas > 0) {
    console.warn(`Aviso de feriados sin cargar enviado a ${avisadas} clínica(s).`);
  }

  return avisadas;
}

/**
 * Link que se manda por email/WhatsApp para que la clínica revise su
 * configuración. Apunta al banner (`/ui`), que es la única pantalla que
 * existe para esto — pasando primero por el login de la SPA, porque
 * `/dashboard/clinics/:id/config-health` (lo que consume el banner) ahora
 * exige sesión iniciada. `redirect` hace que, tras loguearse, el browser
 * vuelva al banner en una navegación completa (no es una ruta de la SPA).
 */
function buildConfigUrl(clinicId: string): string {
  const bannerUrl = `/ui/?clinicId=${clinicId}`;
  return `${env.frontendUrl}/app/login?redirect=${encodeURIComponent(bannerUrl)}`;
}

/**
 * Estado de configuración de todas las clínicas activas. Para revisar de
 * una qué falta en la plataforma, sin esperar el cron.
 */
export async function configHealthReport(now = new Date()) {
  const clinics = await prisma.clinic.findMany({
    where: { active: true },
    select: { id: true },
  });

  const resultados = [];
  for (const { id } of clinics) {
    const health = await getConfigHealth(id, now);
    if (health && !health.ok) resultados.push(health);
  }
  return resultados;
}
