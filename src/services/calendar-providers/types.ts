import type { GoogleAccount, MicrosoftAccount } from "@prisma/client";

/**
 * Contrato que cumple cada sistema de agenda al que la plataforma puede
 * espejar turnos y del que puede leer bloqueos.
 *
 * Postgres sigue siendo la fuente de verdad de la disponibilidad
 * (services/availability.ts). Un proveedor hace solo dos cosas, y la
 * dirección de cada una importa:
 *
 * - ESCRITURA (Postgres → proveedor): `createEvent` / `deleteEvent`, el
 *   espejo. Si falla, el turno ya está creado y es válido.
 * - LECTURA (proveedor → Postgres): `listBlocks`, los rectángulos de tiempo
 *   ocupado que no son turnos nuestros. Los copia jobs/calendar-sync.ts.
 *
 * Ningún proveedor responde "¿este horario está libre?" durante la decisión
 * de un turno: eso no está en el contrato a propósito.
 *
 * Quien llama (booking.ts, agent-turn.ts, calendar-sync.ts) no sabe qué
 * proveedor hay detrás: habla con `services/calendar.ts`, que despacha por
 * `target.provider`. Sumar uno es escribir una implementación de esta
 * interfaz y registrarla ahí.
 */
export type CalendarProviderId = "google" | "microsoft";

/**
 * Un calendario concreto más la credencial con la que se accede. Son
 * inseparables: quien consulta un calendario tiene que hacerlo con la cuenta
 * que lo conectó. Es una unión por proveedor porque cada uno tiene su propia
 * credencial.
 */
export type CalendarTarget = GoogleCalendarTarget | MicrosoftCalendarTarget;

export interface GoogleCalendarTarget {
  provider: "google";
  calendarId: string;
  /** null = usar la cuenta de servicio de la plataforma (el modo viejo). */
  account: GoogleAccount | null;
}

export interface MicrosoftCalendarTarget {
  provider: "microsoft";
  calendarId: string;
  /** Obligatoria: Microsoft no tiene cuenta de servicio de respaldo. */
  account: MicrosoftAccount;
}

/** Lo que se necesita para crear el evento espejo de un turno. */
export interface MirrorEventInput {
  appointmentId: string;
  clinicId: string;
  patientName: string;
  professionalName: string;
  service: string;
  startTime: string;
  endTime: string;
  roomName?: string | null;
  resourceName?: string | null;
  timezone?: string;
}

/** Un rato ocupado en el calendario de un profesional, que no es un turno nuestro. */
export interface CalendarBlockInput {
  /** Id del evento en el proveedor (no solo de Google). */
  externalEventId: string;
  startTime: Date;
  endTime: Date;
  isAllDay: boolean;
}

/**
 * Un evento tal como está en el calendario, para la instantánea previa a la instalación
 * (`scripts/calendar-snapshot.ts`). Lleva el título porque su fin es poder comprobar que
 * NADA ajeno cambió: es un archivo local sensible, que no se sube a ningún repositorio.
 */
export interface CalendarSnapshotEvent {
  id: string;
  summary: string | null;
  start: string | null;
  end: string | null;
  allDay: boolean;
  status: string | null;
  transparency: string | null;
  /** Lo creó esta plataforma como espejo de un turno. */
  isOurs: boolean;
}

/** Un calendario que el usuario puede elegir de una lista al conectarlo. */
export interface AvailableCalendar {
  id: string;
  summary: string;
  primary: boolean;
  timeZone: string | null;
}

export interface CalendarProvider {
  readonly id: CalendarProviderId;
  /** Crea el evento espejo y devuelve su id en el proveedor. */
  createEvent(target: CalendarTarget, event: MirrorEventInput): Promise<string>;
  deleteEvent(target: CalendarTarget, externalEventId: string): Promise<void>;
  /**
   * Eventos del rango que cuentan como tiempo ocupado ajeno a la plataforma:
   * sin los turnos que espejamos nosotros, los marcados "libre", los
   * cancelados ni las invitaciones rechazadas.
   */
  listBlocks(target: CalendarTarget, from: Date, to: Date): Promise<CalendarBlockInput[]>;
  /**
   * TODOS los eventos del rango (también los nuestros y los de "libre"), para la instantánea y
   * para deshacer los espejos. Opcional: un proveedor que no lo implementa no se puede
   * respaldar con el script, y este lo avisa.
   */
  exportEvents?(target: CalendarTarget, from: Date, to: Date): Promise<CalendarSnapshotEvent[]>;
  /**
   * Si el error significa que la cuenta perdió el acceso (la clínica revocó
   * el permiso, cambió la contraseña), la marca como revocada para que la
   * interfaz pida reconectar en vez de reintentar cada 15 minutos para
   * siempre. Devuelve la cuenta afectada, o null si el error era otra cosa.
   */
  handleAccessError(target: CalendarTarget, error: unknown): Promise<{ email: string } | null>;
}
