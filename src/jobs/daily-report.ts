import { reportJobError, trackedCron } from "./tracked-cron";
import { prisma } from "../db/client";
import { SANDBOX_PATIENT_FILTER } from "../services/sandbox-phone";
import { sendDailyReport } from "../services/email";
import { listActiveClinics } from "../repositories/clinics.repository";
import type { DailyReportAppointment, DailyReportBlock } from "../types";

/**
 * Corre una vez al día y recorre TODAS las clínicas activas, mandándole a
 * cada una su propio reporte con sus propios turnos.
 *
 * Los turnos salen de `Appointment` en Postgres, que es la fuente de verdad
 * — no de Google Calendar. Consultar el calendario acá traía dos problemas:
 * mezclaba los eventos personales del profesional con los turnos reales, y
 * un evento de Calendar no tiene status, seña, espacio ni equipo.
 *
 * El tiempo personal sí aparece, pero en su propia sección y solo como un
 * rango horario (ver CalendarBlock en el schema).
 *
 * TODO (Claude Code): la hora "07:00" es fija para todas las clínicas.
 * En algún momento probablemente convenga que cada Clinic tenga su propio
 * horario de envío, en vez de un cron único para todas.
 */
export function scheduleDailyReport(): void {
  trackedCron("daily-report", "0 7 * * *", async () => {
    let clinics: Awaited<ReturnType<typeof listActiveClinics>>;
    try {
      clinics = await listActiveClinics();
    } catch (error) {
      // Sin este catch la excepción escapa del callback async y node-cron
      // no la agarra: Node >=15 mata el proceso, y con los crons en su
      // propio proceso eso deja sin correr a los otros cinco.
      await reportJobError("daily-report", "Error en el cron del reporte diario", error);
      return;
    }

    for (const clinic of clinics) {
      try {
        const { start, end } = todayRange();

        const appointments = await prisma.appointment.findMany({
          where: {
            clinicId: clinic.id,
            status: "confirmado",
            startTime: { gte: start, lte: end },
            // Chat de pruebas: las citas de prueba no van al reporte del día.
            NOT: { patient: SANDBOX_PATIENT_FILTER },
          },
          orderBy: { startTime: "asc" },
          include: { patient: true, professional: true, room: true },
        });

        const blocks = await prisma.calendarBlock.findMany({
          where: {
            clinicId: clinic.id,
            startTime: { lte: end },
            endTime: { gte: start },
          },
          orderBy: { startTime: "asc" },
          include: { professional: true },
        });

        const reportAppointments: DailyReportAppointment[] = appointments.map((a) => ({
          appointmentId: a.id,
          startTime: a.startTime,
          endTime: a.endTime,
          patientName: a.patient.name ?? a.patient.phone,
          service: a.service,
          professionalName: a.professional.name,
          roomName: a.room?.name ?? null,
        }));

        const reportBlocks: DailyReportBlock[] = blocks.map((b) => ({
          startTime: b.startTime,
          endTime: b.endTime,
          isAllDay: b.isAllDay,
          professionalName: b.professional.name,
        }));

        await sendDailyReport({
          clinicName: clinic.name,
          clinicEmail: clinic.email,
          timezone: clinic.timezone,
          appointments: reportAppointments,
          blocks: reportBlocks,
        });
      } catch (error) {
        await reportJobError(
          "daily-report",
          `Error enviando el reporte de la clínica ${clinic.id}`,
          error,
          clinic.id
        );
      }
    }
  });
}

/**
 * Rango del día de hoy.
 *
 * TODO (Claude Code): esto usa la zona horaria del servidor, no la de cada
 * Clinic. Con clínicas en husos distintos el "día de hoy" puede quedar
 * corrido — hay que calcular el rango en `clinic.timezone`. Es el mismo
 * problema que la hora fija del cron.
 */
function todayRange(): { start: Date; end: Date } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
}
