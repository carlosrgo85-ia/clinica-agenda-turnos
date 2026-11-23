import type { MicrosoftAccount } from "@prisma/client";
import {
  GraphError,
  graphFetch,
  isMicrosoftRevokedError,
  markMicrosoftAccountRevoked,
} from "../microsoft-auth";
import type {
  AvailableCalendar,
  CalendarBlockInput,
  CalendarProvider,
  CalendarTarget,
  MicrosoftCalendarTarget,
  MirrorEventInput,
} from "./types";

/**
 * Proveedor de Microsoft 365 / Outlook, vía Microsoft Graph (ver `types.ts`
 * para el contrato y `microsoft-auth.ts` para las credenciales).
 *
 * Mismas reglas que el de Google: el calendario es un espejo, no decide
 * disponibilidad, y la única lectura es la de los bloqueos que copia
 * `jobs/calendar-sync.ts` a Postgres.
 */

function asMicrosoft(target: CalendarTarget): MicrosoftCalendarTarget {
  if (target.provider !== "microsoft") {
    throw new Error(`El proveedor de Microsoft recibió un calendario de ${target.provider}.`);
  }
  return target;
}

/**
 * Los eventos propios se marcan con propiedades extendidas, el equivalente a
 * `extendedProperties.private` de Google: no se ven en Outlook y no las
 * edita quien usa el calendario. El GUID es el espacio de nombres propio de
 * la plataforma (cualquiera que no sea uno de los reservados de Exchange).
 */
const PROPERTY_SET_GUID = "b3a1d5e8-6f2c-4c7a-9d14-2e8f0a7c5b61";
const propertyId = (name: string) => `String {${PROPERTY_SET_GUID}} Name ${name}`;
const APPOINTMENT_ID_PROPERTY = propertyId("appointmentId");

const calendarPath = (calendarId: string) => `/me/calendars/${encodeURIComponent(calendarId)}`;

/** Graph pide fecha y hora sin offset más la zona aparte; mandamos siempre UTC. */
function toGraphDateTime(iso: string): { dateTime: string; timeZone: "UTC" } {
  return { dateTime: new Date(iso).toISOString().replace(/Z$/, ""), timeZone: "UTC" };
}

async function createEvent(rawTarget: CalendarTarget, params: MirrorEventInput): Promise<string> {
  const target = asMicrosoft(rawTarget);

  const detalle = [
    `Cita: ${params.appointmentId}`,
    `${params.patientName} — ${params.service}`,
    `Profesional: ${params.professionalName}`,
    params.roomName ? `Espacio: ${params.roomName}` : null,
    params.resourceName ? `Equipo: ${params.resourceName}` : null,
    "",
    "Busca el detalle completo por el id de la cita en el dashboard.",
  ]
    .filter(Boolean)
    .join("\n");

  const event = await graphFetch<{ id?: string }>(target.account, `${calendarPath(target.calendarId)}/events`, {
    method: "POST",
    body: {
      subject: `${params.patientName} — ${params.service} (${params.professionalName})`,
      body: { contentType: "text", content: detalle },
      start: toGraphDateTime(params.startTime),
      end: toGraphDateTime(params.endTime),
      // "busy" = ocupa tiempo, igual que `transparency: opaque` en Google.
      showAs: "busy",
      // Sin invitados y sin aviso: es un espejo, no una reunión.
      isReminderOn: false,
      singleValueExtendedProperties: [
        { id: APPOINTMENT_ID_PROPERTY, value: params.appointmentId },
        { id: propertyId("clinicId"), value: params.clinicId },
      ],
    },
  });

  if (!event.id) throw new Error("Microsoft Graph no devolvió el id del evento creado.");
  return event.id;
}

async function deleteEvent(rawTarget: CalendarTarget, externalEventId: string): Promise<void> {
  const target = asMicrosoft(rawTarget);
  try {
    await graphFetch<void>(
      target.account,
      `${calendarPath(target.calendarId)}/events/${encodeURIComponent(externalEventId)}`,
      { method: "DELETE" }
    );
  } catch (error) {
    // Ya no estaba (alguien lo borró a mano): el resultado que se quería.
    if (error instanceof GraphError && error.status === 404) return;
    throw error;
  }
}

interface GraphEvent {
  id?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  responseStatus?: { response?: string };
  singleValueExtendedProperties?: Array<{ id?: string; value?: string }>;
}

interface GraphEventPage {
  value?: GraphEvent[];
  "@odata.nextLink"?: string;
}

/** Graph devuelve la hora sin sufijo; con `Prefer: outlook.timezone="UTC"` es UTC. */
const parseUtc = (dateTime: string) => new Date(dateTime.endsWith("Z") ? dateTime : `${dateTime}Z`);

/**
 * `calendarView` y no `events`: expande las series repetidas en una
 * instancia por ocurrencia, el equivalente a `singleEvents: true` de Google.
 * Se descartan los mismos casos que allá: los turnos que espejamos nosotros,
 * los marcados "Libre", los cancelados y las invitaciones rechazadas.
 */
async function listBlocks(
  rawTarget: CalendarTarget,
  from: Date,
  to: Date
): Promise<CalendarBlockInput[]> {
  const target = asMicrosoft(rawTarget);
  const blocks: CalendarBlockInput[] = [];

  const query = [
    `startDateTime=${encodeURIComponent(from.toISOString())}`,
    `endDateTime=${encodeURIComponent(to.toISOString())}`,
    "$top=100",
    `$select=${encodeURIComponent("id,start,end,isAllDay,isCancelled,showAs,responseStatus")}`,
    `$expand=${encodeURIComponent(`singleValueExtendedProperties($filter=id eq '${APPOINTMENT_ID_PROPERTY}')`)}`,
  ].join("&");

  let next: string | undefined = `${calendarPath(target.calendarId)}/calendarView?${query}`;
  while (next) {
    const page: GraphEventPage = await graphFetch<GraphEventPage>(target.account, next, {
      headers: { Prefer: 'outlook.timezone="UTC"' },
    });

    for (const event of page.value ?? []) {
      if (!event.id) continue;
      if (event.isCancelled) continue;
      if (event.showAs === "free") continue;
      if (event.responseStatus?.response === "declined") continue;
      if (event.singleValueExtendedProperties?.some((p) => p.id === APPOINTMENT_ID_PROPERTY && p.value)) continue;
      if (!event.start?.dateTime || !event.end?.dateTime) continue;

      blocks.push({
        externalEventId: event.id,
        startTime: parseUtc(event.start.dateTime),
        endTime: parseUtc(event.end.dateTime),
        isAllDay: Boolean(event.isAllDay),
      });
    }

    next = page["@odata.nextLink"];
  }

  return blocks;
}

/**
 * Los calendarios de la cuenta conectada, para que la clínica elija de una
 * lista. Se filtran los que no se pueden editar (calendarios de feriados,
 * compartidos de solo lectura): si no podemos escribir ahí, no sirve para
 * espejar turnos.
 */
export async function listAvailableMicrosoftCalendars(account: MicrosoftAccount): Promise<AvailableCalendar[]> {
  const result: AvailableCalendar[] = [];
  let next: string | undefined = `/me/calendars?$top=100&$select=${encodeURIComponent("id,name,isDefaultCalendar,canEdit")}`;

  while (next) {
    const page: {
      value?: Array<{ id?: string; name?: string; isDefaultCalendar?: boolean; canEdit?: boolean }>;
      "@odata.nextLink"?: string;
    } = await graphFetch(account, next);

    for (const item of page.value ?? []) {
      if (!item.id || !item.canEdit) continue;
      result.push({
        id: item.id,
        summary: item.name ?? item.id,
        primary: item.isDefaultCalendar ?? false,
        // Graph no informa la zona del calendario: los horarios se mandan en UTC.
        timeZone: null,
      });
    }
    next = page["@odata.nextLink"];
  }

  return result;
}

async function handleAccessError(
  rawTarget: CalendarTarget,
  error: unknown
): Promise<{ email: string } | null> {
  const { account } = asMicrosoft(rawTarget);
  if (!isMicrosoftRevokedError(error)) return null;
  await markMicrosoftAccountRevoked(account.id);
  return { email: account.email };
}

export const microsoftCalendarProvider: CalendarProvider = {
  id: "microsoft",
  createEvent,
  deleteEvent,
  listBlocks,
  handleAccessError,
};
