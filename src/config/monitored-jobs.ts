/**
 * Las tareas programadas del worker, tal como las ve la pantalla "Monitoreo".
 *
 * `maxGapMs` es **el hueco más largo que es normal entre dos corridas**, no
 * la frecuencia: una tarea de "cada hora de 8 a 18" corre sola de día y
 * descansa 14 horas de noche, y eso no es una falla. Una tarea se considera
 * atrasada cuando pasa bastante más que ese hueco sin correr
 * (`isJobStale()`).
 *
 * El nombre es el que cada job le pasa a `trackedCron()`: si no coincide, la
 * pantalla lo muestra como "nunca corrió".
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface MonitoredJob {
  name: string;
  label: string;
  /** Cuándo corre, en palabras. */
  schedule: string;
  maxGapMs: number;
}

export const MONITORED_JOBS: MonitoredJob[] = [
  { name: "inbound-sweeper", label: "Rescate de mensajes colgados", schedule: "cada minuto", maxGapMs: MINUTE },
  { name: "calendar-sync", label: "Sync de bloqueos de calendario", schedule: "cada 15 minutos", maxGapMs: 15 * MINUTE },
  { name: "two-hour-reminders", label: "Recordatorios de 2 horas", schedule: "cada hora", maxGapMs: HOUR },
  { name: "post-visit-followup", label: "Seguimiento post-visita", schedule: "cada hora", maxGapMs: HOUR },
  { name: "calendar-access-alerts", label: "Avisos de calendario revocado", schedule: "cada hora de 8 a 20", maxGapMs: 12 * HOUR },
  { name: "secret-expiry-alerts", label: "Avisos de vencimiento de secretos", schedule: "cada hora de 8 a 18", maxGapMs: 14 * HOUR },
  { name: "google-oauth-health", label: "Verificación de la app de OAuth de Google", schedule: "08:10", maxGapMs: 24 * HOUR },
  { name: "daily-report", label: "Reporte diario", schedule: "07:00", maxGapMs: 24 * HOUR },
  { name: "config-alerts", label: "Avisos de configuración incompleta", schedule: "08:00", maxGapMs: 24 * HOUR },
  { name: "daily-reminders", label: "Recordatorios de 24 horas", schedule: "cada hora", maxGapMs: HOUR },
  { name: "package-reminders", label: "Recordatorio de citas por paquete sin marcar", schedule: "cada hora (1 mail por día)", maxGapMs: HOUR },
  { name: "sandbox-cleanup", label: "Limpieza de conversaciones del chat de pruebas", schedule: "cada hora", maxGapMs: HOUR },
  { name: "campaign-followup", label: "Seguimiento de contactos de campañas", schedule: "cada hora (solo clínicas que lo prendieron)", maxGapMs: HOUR },
  { name: "next-visit-outreach", label: "Contacto por próxima cita sugerida", schedule: "cada hora (solo clínicas que lo prendieron)", maxGapMs: HOUR },
  { name: "system-events-cleanup", label: "Limpieza de eventos del sistema", schedule: "04:00", maxGapMs: 24 * HOUR },
];

/**
 * La tarea que, por correr cada minuto, delata si el worker está vivo: si
 * ella está atrasada, no hay worker.
 */
export const WORKER_PULSE_JOB = "inbound-sweeper";
