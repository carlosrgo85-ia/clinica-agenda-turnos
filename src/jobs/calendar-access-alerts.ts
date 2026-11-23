import { trackedCron } from "./tracked-cron";
import { prisma } from "../db/client";
import { env } from "../config/env";
import { sendCalendarAccessRevokedAlert } from "../services/email";
import { avisarPorWhatsApp } from "./config-alerts";

/**
 * Avisa a cada clínica que el acceso a su calendario fue revocado.
 *
 * `calendar-sync` ya DETECTA la revocación (cada 15 minutos marca la cuenta
 * con `revokedAt` cuando el proveedor rechaza el refresh token), pero hasta
 * ahora nadie la comunicaba: la clínica se enteraba cuando el asistente
 * ofrecía un horario ocupado. Este job es el que cierra esa brecha.
 *
 * - **Solo cuentas en uso**: una cuenta revocada que ningún calendario ni
 *   profesional activo usa no rompe nada, y avisar sería ruido.
 * - **Un aviso por clínica**, con todas sus cuentas juntas, y **una vez por
 *   día** hasta que se reconecte (`revokedAlertSentAt`). El chequeo va contra
 *   la base y no contra el cron, así un reinicio no duplica el aviso.
 * - **Solo se marca como avisada si el mail salió**: si rebota, se reintenta
 *   en la próxima corrida.
 * - Corre de 8 a 20: el WhatsApp no tiene que sonar de madrugada, y una
 *   revocación nocturna se avisa a primera hora.
 */
const HORAS_ENTRE_AVISOS = 24;

/** Una cuenta "en uso" es la de un calendario compartido o de un profesional activo. */
const EN_USO = {
  OR: [{ sharedForClinics: { some: {} } }, { professionals: { some: { active: true } } }],
};

export function scheduleCalendarAccessAlerts(): void {
  trackedCron("calendar-access-alerts", "5 8-20 * * *", async () => {
    await alertClinicsWithRevokedCalendars();
  });
}

/**
 * Devuelve a cuántas clínicas se les avisó. `options.clinicIds` limita el
 * chequeo (para tests y para re-chequear una clínica puntual).
 */
export async function alertClinicsWithRevokedCalendars(
  now = new Date(),
  options?: { clinicIds?: string[] }
): Promise<number> {
  const corte = new Date(now.getTime() - HORAS_ENTRE_AVISOS * 60 * 60 * 1000);

  // Revocada, en uso, y todavía sin avisar (o avisada hace más de un día).
  // Va con AND porque las dos condiciones usan OR: con un spread, la segunda
  // pisaría a la primera y se reavisaría todo el tiempo.
  const pendiente = {
    revokedAt: { not: null },
    AND: [
      { OR: [{ revokedAlertSentAt: null }, { revokedAlertSentAt: { lt: corte } }] },
      EN_USO,
    ],
  };

  const clinics = await prisma.clinic.findMany({
    where: {
      active: true,
      ...(options?.clinicIds ? { id: { in: options.clinicIds } } : {}),
      OR: [
        { googleAccounts: { some: pendiente } },
        { microsoftAccounts: { some: pendiente } },
      ],
    },
    select: {
      id: true,
      name: true,
      email: true,
      adminPhone: true,
      country: true,
      whatsappTokenEncrypted: true,
      whatsappPhoneNumberId: true,
      configAlertTemplateName: true,
      googleAccounts: { where: pendiente, select: { id: true, email: true } },
      microsoftAccounts: { where: pendiente, select: { id: true, email: true } },
    },
  });

  let avisadas = 0;

  for (const clinic of clinics) {
    // Una clínica con un problema no puede dejar sin aviso a las demás.
    try {
      const cuentas = [
        ...clinic.googleAccounts.map((a) => `${a.email} (Google)`),
        ...clinic.microsoftAccounts.map((a) => `${a.email} (Microsoft)`),
      ];
      const calendarsUrl = `${env.frontendUrl}/app/calendars`;

      try {
        await sendCalendarAccessRevokedAlert({
          clinicName: clinic.name,
          clinicEmail: clinic.email,
          cuentas,
          calendarsUrl,
        });
      } catch (error) {
        console.error(`No se pudo avisar por email a la clínica ${clinic.id}:`, error);
        continue;
      }

      await avisarPorWhatsApp(clinic, [
        clinic.name,
        `Hay que reconectar el calendario (${cuentas.join(", ")}). Hasta entonces el asistente no ve los horarios ocupados.`,
        calendarsUrl,
      ]);

      await prisma.googleAccount.updateMany({
        where: { id: { in: clinic.googleAccounts.map((a) => a.id) } },
        data: { revokedAlertSentAt: now },
      });
      await prisma.microsoftAccount.updateMany({
        where: { id: { in: clinic.microsoftAccounts.map((a) => a.id) } },
        data: { revokedAlertSentAt: now },
      });
      avisadas++;
    } catch (error) {
      console.error(`Error avisando el calendario revocado de la clínica ${clinic.id}:`, error);
    }
  }

  if (avisadas > 0) {
    console.warn(`Aviso de calendario revocado enviado a ${avisadas} clínica(s).`);
  }

  return avisadas;
}
