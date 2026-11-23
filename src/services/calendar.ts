import type { GoogleAccount, MicrosoftAccount } from "@prisma/client";
import { recordUsageEvent } from "./costs";
import { googleCalendarProvider, listAvailableCalendars as listGoogleCalendars } from "./calendar-providers/google";
import {
  listAvailableMicrosoftCalendars,
  microsoftCalendarProvider,
} from "./calendar-providers/microsoft";
import type {
  AvailableCalendar,
  CalendarBlockInput,
  CalendarProvider,
  CalendarProviderId,
  CalendarTarget,
  MirrorEventInput,
} from "./calendar-providers/types";

export type { AvailableCalendar, CalendarBlockInput, CalendarProviderId, CalendarTarget, MirrorEventInput };

/**
 * Punto de entrada único a los calendarios externos.
 *
 * `booking.ts`, `agent-turn.ts` y `jobs/calendar-sync.ts` hablan con este
 * módulo y no saben qué proveedor hay detrás: se despacha por
 * `target.provider`. El contrato está en `calendar-providers/types.ts`.
 *
 * Para sumar un proveedor (Microsoft 365, un sistema de gestión como
 * Dentalink): implementar `CalendarProvider`, registrarlo en `PROVIDERS` y
 * ampliar `CalendarProviderId`. TypeScript marca el registro incompleto.
 *
 * Postgres sigue siendo la fuente de verdad: nada de acá decide si un
 * horario está libre.
 */
const PROVIDERS: Record<CalendarProviderId, CalendarProvider> = {
  google: googleCalendarProvider,
  microsoft: microsoftCalendarProvider,
};

export function getCalendarProvider(id: CalendarProviderId): CalendarProvider {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw new Error(`Proveedor de calendario desconocido: ${id}`);
  }
  return provider;
}

/**
 * Las relaciones que hay que incluir al traer una clínica o un profesional
 * para espejar o borrar un evento. Sin ellas, `resolveCalendarTargetForProfessional()`
 * no tiene credencial y devuelve null (o cae a la cuenta de servicio) en
 * silencio. Usar estas constantes en vez de escribir el `include` a mano: así
 * un proveedor nuevo se suma acá y no en cada consulta.
 */
export const CLINIC_CALENDAR_INCLUDE = {
  sharedCalendarAccount: true,
  sharedCalendarMicrosoftAccount: true,
} as const;

export const PROFESSIONAL_CALENDAR_INCLUDE = {
  googleAccount: true,
  microsoftAccount: true,
} as const;

/** Lo que hace falta de la clínica para saber a qué calendario espejar. */
export interface ClinicCalendarConfig {
  sharedCalendarId: string | null;
  sharedCalendarProvider?: CalendarProviderId;
  sharedCalendarAccount?: GoogleAccount | null;
  sharedCalendarMicrosoftAccount?: MicrosoftAccount | null;
}

/** Lo que hace falta del profesional. */
export interface ProfessionalCalendarConfig {
  /** El nombre es de cuando solo existía Google: guarda el id en cualquier proveedor. */
  googleCalendarId: string | null;
  calendarProvider?: CalendarProviderId;
  googleAccount?: GoogleAccount | null;
  microsoftAccount?: MicrosoftAccount | null;
}

/**
 * En qué calendario va el turno de un profesional, y con qué credencial.
 *
 * Si la clínica definió un `sharedCalendarId`, todo el equipo se espeja ahí
 * (una sola agenda compartida); si no, cada profesional usa el suyo.
 * Devuelve null si no hay ninguno enlazado todavía — en ese caso
 * simplemente no hay espejo, y el turno en Postgres sigue siendo válido.
 *
 * La credencial viaja junto al calendario a propósito: son inseparables.
 * El calendario compartido se accede con la cuenta que lo conectó, y el
 * personal de cada profesional con la suya.
 *
 * Es el ÚNICO lugar donde se decide el proveedor. Un calendario de Microsoft
 * sin cuenta conectada devuelve null: a diferencia de Google no hay cuenta de
 * servicio de respaldo, así que no hay con qué acceder. Si la query que trajo
 * al profesional o a la clínica no incluyó la relación de la cuenta
 * (`microsoftAccount` / `sharedCalendarMicrosoftAccount`), el resultado es
 * ese null y el turno se crea sin espejo, en silencio.
 */
export function resolveCalendarTargetForProfessional(
  clinic: ClinicCalendarConfig,
  professional: ProfessionalCalendarConfig
): CalendarTarget | null {
  if (clinic.sharedCalendarId) {
    return buildTarget(
      clinic.sharedCalendarProvider ?? "google",
      clinic.sharedCalendarId,
      clinic.sharedCalendarAccount ?? null,
      clinic.sharedCalendarMicrosoftAccount ?? null
    );
  }
  if (professional.googleCalendarId) {
    return buildTarget(
      professional.calendarProvider ?? "google",
      professional.googleCalendarId,
      professional.googleAccount ?? null,
      professional.microsoftAccount ?? null
    );
  }
  return null;
}

function buildTarget(
  provider: CalendarProviderId,
  calendarId: string,
  googleAccount: GoogleAccount | null,
  microsoftAccount: MicrosoftAccount | null
): CalendarTarget | null {
  if (provider === "microsoft") {
    return microsoftAccount ? { provider, calendarId, account: microsoftAccount } : null;
  }
  return { provider: "google", calendarId, account: googleAccount };
}

/** Crea el evento espejo de un turno. Devuelve su id en el proveedor. */
export async function mirrorAppointmentToCalendar(
  params: MirrorEventInput & { target: CalendarTarget }
): Promise<string> {
  const { target, ...event } = params;
  const id = await getCalendarProvider(target.provider).createEvent(target, event);
  await recordUsageEvent({ provider: usageProviderOf(target), kind: "crear_evento" });
  return id;
}

export async function removeMirroredEvent(target: CalendarTarget, externalEventId: string): Promise<void> {
  await getCalendarProvider(target.provider).deleteEvent(target, externalEventId);
  await recordUsageEvent({ provider: usageProviderOf(target), kind: "borrar_evento" });
}

/** A qué integración se le cuenta la llamada (inventario de Costos). Gratis, pero se mide el volumen. */
function usageProviderOf(target: CalendarTarget): string {
  return target.provider === "microsoft" ? "microsoft_graph" : "google_calendar";
}

/** Tiempo ocupado ajeno a la plataforma en el rango, ver `CalendarProvider.listBlocks`. */
export async function listCalendarBlocks(
  target: CalendarTarget,
  from: Date,
  to: Date
): Promise<CalendarBlockInput[]> {
  return getCalendarProvider(target.provider).listBlocks(target, from, to);
}

/** Todos los eventos del rango, o null si el proveedor no sabe exportarlos (ver `CalendarProvider.exportEvents`). */
export async function exportCalendarEvents(target: CalendarTarget, from: Date, to: Date) {
  const provider = getCalendarProvider(target.provider);
  return provider.exportEvents ? provider.exportEvents(target, from, to) : null;
}

/**
 * Si el error significa que la cuenta del calendario perdió el acceso, la
 * marca como revocada (ver `CalendarProvider.handleAccessError`). Devuelve la
 * cuenta afectada, o null si era otro tipo de error.
 */
export async function handleCalendarAccessError(
  target: CalendarTarget,
  error: unknown
): Promise<{ email: string } | null> {
  return getCalendarProvider(target.provider).handleAccessError(target, error);
}

/**
 * Los calendarios a elegir de una cuenta conectada por OAuth: el selector de
 * la pantalla. Cada proveedor tiene su propia cuenta, así que se pide por
 * separado.
 */
export async function listAvailableCalendars(account: GoogleAccount): Promise<AvailableCalendar[]> {
  return listGoogleCalendars(account);
}

export async function listAvailableCalendarsForMicrosoft(
  account: MicrosoftAccount
): Promise<AvailableCalendar[]> {
  return listAvailableMicrosoftCalendars(account);
}
