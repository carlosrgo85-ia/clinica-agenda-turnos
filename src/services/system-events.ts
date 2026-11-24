import { prisma } from "../db/client";

/**
 * Registro de lo que salió mal, para que la pantalla "Monitoreo" lo muestre.
 *
 * Antes cada falla terminaba en un `console.error` y nada más: un paciente
 * sin respuesta, un cron caído o un WhatsApp rechazado eran invisibles salvo
 * para quien estuviera mirando el log justo ahí.
 */

/** Los tipos que se registran. Una clave más acá es un tipo más, sin migrar. */
export const SYSTEM_EVENT_KINDS = {
  /** La llamada a Claude falló (y se reintentó o se derivó). */
  MODELO_FALLO: "modelo_fallo",
  /** El procesamiento de un mensaje entrante murió antes de contestarlo. */
  MENSAJE_SIN_PROCESAR: "mensaje_sin_procesar",
  /** Una tarea programada tiró una excepción. */
  CRON_ERROR: "cron_error",
  /** Un envío de WhatsApp fue rechazado o falló. */
  WHATSAPP_ENVIO: "whatsapp_envio",
  /**
   * El servicio que devolvió el modelo no está en el catálogo de una clínica que
   * sí lo tiene cargado, y por eso se derivó. Sirve para medir cuántos son
   * falsos (el paciente dijo algo coloquial que el prompt no tradujo).
   */
  SERVICIO_SIN_MATCH: "servicio_sin_match",
  /** No se pudo escribir un registro de auditoría: un hueco en la historia. */
  AUDITORIA_FALLO: "auditoria_fallo",
  /** Google rechazó la app de OAuth de la plataforma (`jobs/google-oauth-health.ts`). */
  GOOGLE_OAUTH_INVALIDO: "google_oauth_invalido",
  /** No salió un correo de la plataforma (invitación, recuperar contraseña): casi siempre el SMTP. */
  CORREO_ENVIO: "correo_envio",
} as const;

export type SystemEventKind = (typeof SYSTEM_EVENT_KINDS)[keyof typeof SYSTEM_EVENT_KINDS];

/** Cómo se rotula cada tipo en la pantalla. */
export const SYSTEM_EVENT_LABELS: Record<SystemEventKind, string> = {
  modelo_fallo: "Falló el modelo de IA",
  mensaje_sin_procesar: "Mensaje sin contestar",
  cron_error: "Error en una tarea programada",
  whatsapp_envio: "Falló un envío de WhatsApp",
  servicio_sin_match: "Servicio pedido sin match en el catálogo",
  auditoria_fallo: "No se pudo escribir un registro de auditoría",
  google_oauth_invalido: "Google rechaza la app de OAuth de la plataforma",
  correo_envio: "No salió un correo de la plataforma",
};

const MAX_MESSAGE_LENGTH = 500;

/** Cuántos días se conservan los eventos (`jobs/system-events-cleanup.ts`). */
export const SYSTEM_EVENT_RETENTION_DAYS = 30;

export function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text;
}

/**
 * Registra un evento. **Nunca lanza**: se llama desde el camino de error de
 * algo que ya falló, y que además falle el registro no puede sumar un
 * segundo problema encima ni tumbar la respuesta al paciente.
 *
 * No recibe el mensaje del paciente ni su teléfono, a propósito: ver
 * `SystemEvent` en el schema.
 */
export async function recordSystemEvent(event: {
  kind: SystemEventKind;
  message: string;
  clinicId?: string | null;
  severity?: "error" | "warning";
}): Promise<void> {
  try {
    await prisma.systemEvent.create({
      data: {
        kind: event.kind,
        severity: event.severity ?? "error",
        clinicId: event.clinicId ?? null,
        message:
          event.message.length > MAX_MESSAGE_LENGTH
            ? `${event.message.slice(0, MAX_MESSAGE_LENGTH)}…`
            : event.message,
      },
    });
  } catch (error) {
    console.error("No se pudo registrar el evento del sistema:", error);
  }
}

/** Borra los eventos más viejos que la retención. Devuelve cuántos. */
export async function pruneSystemEvents(now = new Date()): Promise<number> {
  const corte = new Date(now.getTime() - SYSTEM_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.systemEvent.deleteMany({ where: { createdAt: { lt: corte } } });
  return count;
}
