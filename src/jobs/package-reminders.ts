import { prisma } from "../db/client";
import { env } from "../config/env";
import { PERMISSIONS } from "../config/permissions";
import { listActiveClinics } from "../repositories/clinics.repository";
import { sendPackageReminder, type PackageReminderRow } from "../services/email";
import { listPendingPackageAppointments, type PendingPackageAppointment } from "../services/packages";
import {
  clinicDateKey,
  clinicMinutesFromMidnight,
  dateKeyToUtcMidnight,
  formatWallTime,
} from "../services/time";
import { reportJobError, trackedCron } from "./tracked-cron";

/**
 * Recordatorio por mail de las citas por paquete que nadie marcó como atendidas.
 *
 * La sesión de un paquete se descuenta SOLO cuando una persona marca la cita
 * (ver `services/packages.ts`), así que el olvido es el modo de falla: la cita
 * pasa, nadie la marca, y el paciente queda con más sesiones de las que tiene. El
 * panel de "Citas" lo muestra, pero hay que entrar a mirarlo; esto llega solo.
 *
 * **Una vez por día por clínica**, en el horario de la clínica y no en el del
 * servidor: el job corre cada hora y manda cuando allá son entre las 8 y las 18
 * y todavía no se mandó hoy (`Clinic.packageReminderSentOn`). Así un SMTP caído a
 * las 8 se reintenta a las 9 en vez de perderse hasta mañana. Mismo patrón que
 * `jobs/secret-expiry-alerts.ts`.
 *
 * **Solo se marca como enviado si el mail salió.** Y no manda nada si no hay
 * ninguna cita pendiente: un recordatorio vacío enseña a ignorarlos.
 *
 * Las atrasadas se repiten cada día hasta que se marquen: que no desaparezcan al
 * día siguiente es justo el punto.
 */

/** Desde y hasta qué hora de la clínica (inclusive) se manda. */
export const REMINDER_FROM_HOUR = 8;
export const REMINDER_TO_HOUR = 18;

export function schedulePackageReminders(): void {
  trackedCron("package-reminders", "20 * * * *", async () => {
    await remindPendingPackageAppointments();
  });
}

export interface PackageReminderDeps {
  send: typeof sendPackageReminder;
}

const defaultDeps: PackageReminderDeps = { send: sendPackageReminder };

/**
 * A quién se le manda: los usuarios activos de la clínica con `paquetes.gestionar`
 * (quienes pueden marcar la cita, que es lo que el aviso pide). Si no hay ninguno,
 * el mail de la clínica: es mejor que se lo lea alguien que no pueda marcarla a
 * que no se lo lea nadie.
 */
export async function packageReminderRecipients(clinic: { id: string; email: string }): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: {
      clinicId: clinic.id,
      active: true,
      roles: {
        some: { role: { permissions: { some: { permissionId: PERMISSIONS.PAQUETES_GESTIONAR } } } },
      },
    },
    select: { email: true },
    orderBy: { email: "asc" },
  });
  const emails = users.map((u) => u.email);
  return emails.length > 0 ? emails : [clinic.email];
}

/** Devuelve a cuántas clínicas se les avisó. */
export async function remindPendingPackageAppointments(
  now = new Date(),
  deps: PackageReminderDeps = defaultDeps,
  options?: { clinicIds?: string[] }
): Promise<number> {
  const clinics = await listActiveClinics();
  let avisadas = 0;

  for (const clinic of clinics) {
    if (options?.clinicIds && !options.clinicIds.includes(clinic.id)) continue;

    // Un error de una clínica no puede dejar sin aviso a las que faltan.
    try {
      const hora = Math.floor(clinicMinutesFromMidnight(now, clinic.timezone) / 60);
      if (hora < REMINDER_FROM_HOUR || hora > REMINDER_TO_HOUR) continue;

      const hoyKey = clinicDateKey(now, clinic.timezone);
      const hoyDate = dateKeyToUtcMidnight(hoyKey);
      if (!hoyDate) continue;

      const yaAvisada = await prisma.clinic.findFirst({
        where: { id: clinic.id, packageReminderSentOn: hoyDate },
        select: { id: true },
      });
      if (yaAvisada) continue;

      const { hoy, atrasadas } = await listPendingPackageAppointments({
        clinicId: clinic.id,
        timezone: clinic.timezone,
        now,
      });
      if (hoy.length + atrasadas.length === 0) continue;

      const to = await packageReminderRecipients(clinic);
      await deps.send({
        clinicName: clinic.name,
        to,
        hoy: hoy.map((c) => aFila(c, clinic.timezone, false)),
        atrasadas: atrasadas.map((c) => aFila(c, clinic.timezone, true)),
        panelUrl: `${env.frontendUrl}/app/appointments`,
      });

      // Solo si el mail salió.
      await prisma.clinic.update({
        where: { id: clinic.id },
        data: { packageReminderSentOn: hoyDate },
      });
      avisadas += 1;
    } catch (error) {
      await reportJobError(
        "package-reminders",
        `Error mandando el recordatorio de citas por paquete de la clínica ${clinic.id}`,
        error,
        clinic.id
      );
    }
  }

  return avisadas;
}

function aFila(cita: PendingPackageAppointment, timezone: string, conDia: boolean): PackageReminderRow {
  const hora = formatWallTime(cita.startTime, timezone);
  const dia = clinicDateKey(cita.startTime, timezone).split("-").reverse().slice(0, 2).join("/");
  return {
    cuando: conDia ? `${dia} ${hora}` : hora,
    paciente: cita.patient.name ?? cita.patient.phone,
    servicio: cita.service,
    profesional: cita.professional.name,
    // Las que le quedan sin contar esta, que todavía no se descontó.
    quedan: cita.package.totalSessions - cita.package.usedSessions,
    total: cita.package.totalSessions,
  };
}
