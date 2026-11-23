/**
 * Genera el iCalendar (.ics) que va adjunto al aviso de turno.
 *
 * Con esto el mail no es solo un texto: Gmail, Outlook y Apple Mail lo
 * muestran como una **invitación** y ofrecen agregarlo al calendario
 * personal del profesional con un click (o lo agregan solos, según la
 * configuración de cada uno).
 *
 * Se arma a mano y no con una librería: son treinta líneas de texto con un
 * formato estable desde 1998 (RFC 5545), y sumar una dependencia para esto
 * es más superficie de la que ahorra.
 *
 * No reemplaza al espejo en Google Calendar: ese pone el turno en la agenda
 * *de la clínica* y lo mantiene sincronizado (si se cancela, se borra). Esto
 * es una copia en la agenda personal de quien lo quiera.
 */

export interface AppointmentIcsParams {
  /** El id del turno. Es el UID del evento: estable, para poder actualizarlo. */
  appointmentId: string;
  start: Date;
  end: Date;
  summary: string;
  description: string;
  location: string | null;
  organizerName: string;
  organizerEmail: string;
  attendeeName: string;
  attendeeEmail: string;
  /** Inyectable para poder testear sin depender del reloj. */
  now?: Date;
}

/** "2026-09-18T11:00:00Z" → "20260918T110000Z", que es lo que pide el RFC. */
function formatUtc(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

/**
 * Escapa un valor de texto.
 *
 * Sin esto, una coma en el nombre del servicio ("limpieza, control") corta
 * el campo en dos y el evento llega roto o directamente no se importa.
 */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * Corta las líneas a 75 octetos, como exige el RFC.
 *
 * Las continuaciones arrancan con un espacio. Se cuenta en BYTES y no en
 * caracteres: una descripción con acentos o emojis se pasa del límite antes
 * de lo que sugiere su largo, y algunos clientes rechazan el archivo entero.
 */
function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;

  const partes: string[] = [];
  let desde = 0;
  while (desde < bytes.length) {
    // La primera línea usa 75; las siguientes 74, porque arrancan con el
    // espacio de continuación.
    let largo = partes.length === 0 ? 75 : 74;
    // No cortar en medio de un carácter multibyte.
    while (largo > 1 && (bytes[desde + largo] & 0xc0) === 0x80) largo -= 1;
    partes.push(bytes.subarray(desde, desde + largo).toString("utf8"));
    desde += largo;
  }

  return partes.map((p, i) => (i === 0 ? p : ` ${p}`)).join("\r\n");
}

export function buildAppointmentIcs(params: AppointmentIcsParams): string {
  const ahora = params.now ?? new Date();

  const lineas = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Pontic//Agenda de citas//ES",
    "CALSCALE:GREGORIAN",
    // REQUEST es lo que hace que se vea como invitación y no como un archivo
    // suelto. Con PUBLISH, Gmail lo muestra pero no ofrece agregarlo.
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${params.appointmentId}@pontic`,
    `DTSTAMP:${formatUtc(ahora)}`,
    `DTSTART:${formatUtc(params.start)}`,
    `DTEND:${formatUtc(params.end)}`,
    // SEQUENCE 0 = primera versión del evento. Si alguna vez se manda una
    // actualización del mismo turno, tiene que subir para que el cliente la
    // acepte en lugar de ignorarla.
    "SEQUENCE:0",
    "STATUS:CONFIRMED",
    `SUMMARY:${escapeText(params.summary)}`,
    `DESCRIPTION:${escapeText(params.description)}`,
    ...(params.location ? [`LOCATION:${escapeText(params.location)}`] : []),
    `ORGANIZER;CN=${escapeText(params.organizerName)}:mailto:${params.organizerEmail}`,
    `ATTENDEE;CN=${escapeText(params.attendeeName)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${params.attendeeEmail}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  // CRLF y no \n: el RFC lo exige y algunos clientes lo hacen valer.
  return lineas.map(foldLine).join("\r\n");
}
