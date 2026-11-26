import { google } from "googleapis";
import type { calendar_v3 } from "googleapis";
import type { GoogleAccount } from "@prisma/client";
import { env } from "../../config/env";
import { getClientForAccount, isInvalidGrantError, markAccountRevoked } from "../google-auth";
import type {
  AvailableCalendar,
  CalendarBlockInput,
  CalendarProvider,
  CalendarSnapshotEvent,
  CalendarTarget,
  GoogleCalendarTarget,
  MirrorEventInput,
} from "./types";

/** El despacho ya eligió este proveedor; esto le da al compilador el tipo del target. */
function asGoogle(target: CalendarTarget): GoogleCalendarTarget {
  if (target.provider !== "google") {
    throw new Error(`El proveedor de Google recibió un calendario de ${target.provider}.`);
  }
  return target;
}

/**
 * Proveedor de Google Calendar (ver `types.ts` para el contrato).
 *
 * Google Calendar ya NO decide disponibilidad (eso lo hace
 * services/availability.ts contra nuestra base). Este módulo hace dos
 * cosas, y la dirección de cada una importa:
 *
 * 1. ESCRITURA (Postgres → Calendar): el espejo. Cada turno creado en la
 *    base se refleja como evento en el calendario correspondiente, para
 *    que el profesional lo vea desde su Google Calendar de siempre y no
 *    tenga que migrar de herramienta.
 *
 * 2. LECTURA (Calendar → Postgres): los bloqueos. Los eventos que NO
 *    creamos nosotros son tiempo ocupado del profesional (algo personal,
 *    una reunión). jobs/calendar-sync.ts los copia a la tabla
 *    CalendarBlock para que el bot no agende encima.
 *
 * Lo que sigue prohibido es preguntarle a Google "¿este horario está
 * libre?" en el momento de decidir un turno: ninguna API de calendario
 * modela el cuello de botella de espacios y equipos compartidos.
 */

/** Marca que identifica a los eventos creados por esta plataforma. */
const APP_SOURCE = "clinica-agenda-turnos";

/**
 * Cliente de Calendar con la credencial que corresponda.
 *
 * Hay dos modos y conviven a propósito, para que las clínicas ya cargadas
 * no se rompan cuando se migra a OAuth:
 *
 * - `account` presente → OAuth. La clínica autorizó su propia cuenta.
 * - `account` en null → la cuenta de servicio compartida de la plataforma,
 *   que requiere que la clínica le haya compartido el calendario a mano.
 */
async function getCalendarClient(account?: GoogleAccount | null) {
  if (account) {
    if (account.revokedAt) {
      throw new Error(
        `La cuenta de Google ${account.email} tiene el acceso revocado. La clínica tiene que volver a conectar su calendario.`
      );
    }
    return google.calendar({ version: "v3", auth: await getClientForAccount(account) });
  }

  if (!env.google.clientEmail || !env.google.privateKey) {
    throw new Error(
      "Este calendario usa la cuenta de servicio, pero falta configurar GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY. Alternativa: conectar la cuenta de la clínica por OAuth."
    );
  }

  const auth = new google.auth.JWT({
    email: env.google.clientEmail,
    key: env.google.privateKey,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return google.calendar({ version: "v3", auth });
}

/**
 * Los calendarios a los que la cuenta conectada tiene acceso, para que la
 * clínica elija de una lista en vez de copiar y pegar un id.
 *
 * Se filtran los que son de solo lectura: si no podemos escribir eventos
 * ahí, no sirve para espejar turnos y ofrecerlo sería confundir.
 */
export async function listAvailableCalendars(account: GoogleAccount): Promise<AvailableCalendar[]> {
  const calendar = await getCalendarClient(account);
  const result: AvailableCalendar[] = [];
  let pageToken: string | undefined;

  do {
    const { data } = await calendar.calendarList.list({ pageToken, maxResults: 250 });
    for (const item of data.items ?? []) {
      if (!item.id) continue;
      if (item.accessRole !== "owner" && item.accessRole !== "writer") continue;
      result.push({
        id: item.id,
        summary: item.summary ?? item.id,
        primary: item.primary ?? false,
        timeZone: item.timeZone ?? null,
      });
    }
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);

  return result;
}

/**
 * Crea el evento espejo de un turno.
 *
 * El evento lleva el id del turno en `extendedProperties.private` para que
 * después se pueda distinguir de un evento personal del profesional (ver
 * `listCalendarBlocks`) y para que el id sea buscable desde el dashboard.
 * El título incluye el nombre del profesional porque en un calendario
 * compartido, si no, no se sabe de quién es cada turno.
 */
async function createEvent(rawTarget: CalendarTarget, params: MirrorEventInput): Promise<string> {
  const target = asGoogle(rawTarget);
  const calendar = await getCalendarClient(target.account);

  const detalle = [
    `Cita: ${params.appointmentId}`,
    `${params.patientName} — ${params.service}`,
    `Profesional: ${params.professionalName}`,
    params.roomName ? `Espacio: ${params.roomName}` : null,
    params.resourceName ? `Equipo: ${params.resourceName}` : null,
    "",
    `Busca el detalle completo por el id de la cita en el dashboard.`,
  ]
    .filter(Boolean)
    .join("\n");

  const { data } = await calendar.events.insert({
    calendarId: target.calendarId,
    requestBody: {
      summary: `${params.patientName} — ${params.service} (${params.professionalName})`,
      description: detalle,
      start: { dateTime: params.startTime, timeZone: params.timezone },
      end: { dateTime: params.endTime, timeZone: params.timezone },
      // "opaque" = ocupa tiempo. Que nuestros propios turnos aparezcan como
      // ocupados es lo correcto, y además hace que el sync de bloqueos los
      // reconozca como tiempo tomado incluso si algo falla en el marcado.
      transparency: "opaque",
      extendedProperties: {
        private: {
          source: APP_SOURCE,
          appointmentId: params.appointmentId,
          clinicId: params.clinicId,
        },
      },
    },
  });

  return data.id ?? "";
}

async function deleteEvent(rawTarget: CalendarTarget, externalEventId: string): Promise<void> {
  const target = asGoogle(rawTarget);
  const calendar = await getCalendarClient(target.account);
  await calendar.events.delete({
    calendarId: target.calendarId,
    eventId: externalEventId,
  });
}

/** ¿Este evento lo creamos nosotros como espejo de un turno? */
function isOwnAppointmentEvent(event: calendar_v3.Schema$Event): boolean {
  const priv = event.extendedProperties?.private;
  return Boolean(priv?.appointmentId) || priv?.source === APP_SOURCE;
}

/**
 * Lee los eventos de un calendario en un rango y devuelve solo los que
 * cuentan como tiempo ocupado ajeno a la plataforma. Se descartan:
 *
 * - los turnos que espejamos nosotros (ya están en `Appointment`, contarlos
 *   dos veces no aporta nada);
 * - los eventos marcados como "Libre" (`transparency: transparent`), porque
 *   el profesional dijo explícitamente que no le ocupan la agenda;
 * - los cancelados;
 * - las invitaciones que el profesional rechazó.
 *
 * `singleEvents: true` expande las series repetidas, así un bloqueo
 * semanal fijo se importa como una instancia por semana en vez de como
 * una sola regla que después habría que interpretar.
 */
async function listBlocks(
  rawTarget: CalendarTarget,
  from: Date,
  to: Date
): Promise<CalendarBlockInput[]> {
  const target = asGoogle(rawTarget);
  const calendar = await getCalendarClient(target.account);
  const blocks: CalendarBlockInput[] = [];
  let pageToken: string | undefined;

  do {
    const { data } = await calendar.events.list({
      calendarId: target.calendarId,
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
      pageToken,
    });

    for (const event of data.items ?? []) {
      if (!event.id) continue;
      if (event.status === "cancelled") continue;
      if (event.transparency === "transparent") continue;
      if (isOwnAppointmentEvent(event)) continue;
      if (event.attendees?.some((a) => a.self && a.responseStatus === "declined")) continue;

      const parsed = parseEventWindow(event);
      if (!parsed) continue;

      blocks.push({
        externalEventId: event.id,
        ...parsed,
        // Solo para atribuir el bloqueo a un profesional en un calendario compartido; no se guarda.
        hints: {
          title: event.summary ?? null,
          colorId: event.colorId ?? null,
          attendeeEmails: (event.attendees ?? [])
            .filter((a) => a.email && !a.resource)
            .map((a) => a.email as string),
        },
      });
    }

    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);

  return blocks;
}

/** Todos los eventos del rango, sin filtrar nada: ver `CalendarProvider.exportEvents`. */
async function exportEvents(rawTarget: CalendarTarget, from: Date, to: Date): Promise<CalendarSnapshotEvent[]> {
  const target = asGoogle(rawTarget);
  const calendar = await getCalendarClient(target.account);
  const out: CalendarSnapshotEvent[] = [];
  let pageToken: string | undefined;
  do {
    const { data } = await calendar.events.list({
      calendarId: target.calendarId,
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: true,
      showDeleted: false,
      orderBy: "startTime",
      maxResults: 250,
      pageToken,
    });
    for (const event of data.items ?? []) {
      if (!event.id) continue;
      out.push({
        id: event.id,
        summary: event.summary ?? null,
        start: event.start?.dateTime ?? event.start?.date ?? null,
        end: event.end?.dateTime ?? event.end?.date ?? null,
        allDay: Boolean(event.start?.date && !event.start?.dateTime),
        status: event.status ?? null,
        transparency: event.transparency ?? null,
        isOurs: isOwnAppointmentEvent(event),
      });
    }
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/**
 * Convierte el start/end de un evento en un rango de fechas concreto.
 *
 * Un evento de día completo viene como `start.date` (YYYY-MM-DD) en vez de
 * `start.dateTime`, y su `end.date` es exclusivo. Lo tratamos como ocupado
 * de punta a punta: si un profesional se pone "Vacaciones" todo el día, no
 * hay que ofrecerle turnos ese día.
 */
function parseEventWindow(
  event: calendar_v3.Schema$Event
): { startTime: Date; endTime: Date; isAllDay: boolean } | null {
  if (event.start?.dateTime && event.end?.dateTime) {
    return {
      startTime: new Date(event.start.dateTime),
      endTime: new Date(event.end.dateTime),
      isAllDay: false,
    };
  }

  if (event.start?.date && event.end?.date) {
    return {
      startTime: new Date(`${event.start.date}T00:00:00`),
      // end.date es exclusivo en la API de Google, así que ya apunta al
      // arranque del día siguiente — sirve tal cual como fin del bloqueo.
      endTime: new Date(`${event.end.date}T00:00:00`),
      isAllDay: true,
    };
  }

  // Un evento sin start/end usable no se puede convertir en un bloqueo.
  return null;
}

async function handleAccessError(
  rawTarget: CalendarTarget,
  error: unknown
): Promise<{ email: string } | null> {
  const { account } = asGoogle(rawTarget);
  // Sin cuenta es la cuenta de servicio: no hay nada que marcar.
  if (!account || !isInvalidGrantError(error)) return null;
  await markAccountRevoked(account.id);
  return { email: account.email };
}

export const googleCalendarProvider: CalendarProvider = {
  exportEvents,
  id: "google",
  createEvent,
  deleteEvent,
  listBlocks,
  handleAccessError,
};
