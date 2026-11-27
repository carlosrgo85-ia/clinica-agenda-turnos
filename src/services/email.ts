import nodemailer from "nodemailer";
import { env } from "../config/env";
import { buildAppointmentIcs } from "./ics";
import type { DailyReportAppointment, DailyReportBlock } from "../types";

const transporter = nodemailer.createTransport({
  host: env.smtp.host,
  port: env.smtp.port,
  secure: env.smtp.port === 465,
  auth: { user: env.smtp.user, pass: env.smtp.pass },
});

/**
 * Le avisa a la clínica que le falta cargar el horario de atención.
 *
 * Va por email y no por WhatsApp a propósito: es un aviso operativo para
 * quien administra el sistema del lado de la clínica, no un mensaje a un
 * paciente, y los mensajes iniciados por la clínica por WhatsApp tienen que
 * ir por plantilla aprobada (ver CLAUDE.md).
 */
export async function sendMissingWorkingHoursAlert(params: {
  clinicName: string;
  clinicEmail: string;
  configUrl: string;
  /** Hace cuántos días está la clínica activa sin horario cargado. */
  diasSinCargar: number;
}): Promise<void> {
  const html = `
    <h2>Falta cargar el horario de atención — ${escapeHtml(params.clinicName)}</h2>

    <p><strong>El asistente no puede agendar citas.</strong>
    Sin horario de atención cargado no hay forma de saber cuándo está abierta
    la clínica, así que el asistente no ofrece horarios y rechaza cualquier
    pedido de cita: los pacientes que escriban para sacar turno no van a
    poder.</p>

    <p>Hace ${params.diasSinCargar} día(s) que la clínica está activa sin
    horario cargado.</p>

    <p>Hay que cargar:</p>
    <ul>
      <li>El horario de la clínica, por día de la semana. Si se corta al
      mediodía, se cargan dos tramos (ej. de 9 a 13 y de 14 a 18).</li>
      <li>Opcional: el horario propio de cada profesional. Si no se carga,
      cada profesional usa el de la clínica.</li>
      <li>Opcional: los feriados y los días con actividades especiales en
      los que no se atiende.</li>
    </ul>

    <p><a href="${escapeHtml(params.configUrl)}">Cargar el horario de atención</a></p>

    <p style="color:#666">Este aviso se repite una vez por día hasta que el
    horario esté cargado.</p>
  `;

  await transporter.sendMail({
    from: env.smtp.user,
    to: params.clinicEmail,
    subject: `Acción requerida: falta el horario de atención — ${params.clinicName}`,
    html,
  });
}

/**
 * Le avisa a la clínica que el acceso a su calendario fue revocado y hay que
 * reconectarlo.
 *
 * Mientras no se reconecte, no se importan los bloqueos de la agenda
 * personal: el asistente no sabe qué horarios están ocupados y puede ofrecer
 * uno encima de otro compromiso. Y los turnos nuevos no se reflejan en el
 * calendario.
 */
export async function sendCalendarAccessRevokedAlert(params: {
  clinicName: string;
  clinicEmail: string;
  /** Las cuentas a reconectar, ya formateadas ("a@x.com (Google)"). */
  cuentas: string[];
  calendarsUrl: string;
}): Promise<void> {
  const lista = params.cuentas.map((c) => `<li>${escapeHtml(c)}</li>`).join("");

  const html = `
    <h2>Hay que reconectar el calendario — ${escapeHtml(params.clinicName)}</h2>

    <p><strong>El acceso a la agenda fue revocado.</strong> Hasta que se
    reconecte, el asistente no ve los horarios que los profesionales tienen
    ocupados en su calendario y puede ofrecer (y agendar) una cita encima de
    otro compromiso. Los turnos nuevos tampoco se reflejan en la agenda.</p>

    <p>Cuentas a reconectar:</p>
    <ul>${lista}</ul>

    <p><a href="${escapeHtml(params.calendarsUrl)}">Reconectar desde Calendarios</a></p>

    <p style="color:#666">Pasa cuando se cambia la contraseña de la cuenta, se
    revoca el permiso desde su configuración de seguridad o el acceso vence.
    Este aviso se repite una vez por día hasta que se reconecte.</p>
  `;

  await transporter.sendMail({
    from: env.smtp.user,
    to: params.clinicEmail,
    subject: `Acción requerida: reconectar el calendario — ${params.clinicName}`,
    html,
  });
}

/**
 * Le avisa a la clínica que tiene feriados nacionales del año sin cargar.
 *
 * Es una advertencia, no un bloqueante: el sistema funciona, pero esos días
 * el asistente va a ofrecer turnos.
 */
export async function sendPendingHolidaysAlert(params: {
  clinicName: string;
  clinicEmail: string;
  configUrl: string;
  pendientes: number;
  /** Cuántos faltan por año. Desde diciembre incluye el año siguiente. */
  porAnio: Array<{ year: number; pendientes: number }>;
}): Promise<void> {
  const detalle = params.porAnio
    .map((a) => `${a.pendientes} de ${a.year}`)
    .join(" y ");

  // Desde diciembre se pide también el año siguiente, para que el
  // calendario esté listo antes del 1 de enero.
  const anioSiguiente = params.porAnio.some((a) => a.year > new Date().getUTCFullYear());

  const html = `
    <h2>Feriados sin cargar — ${escapeHtml(params.clinicName)}</h2>

    <p>Quedan <strong>${params.pendientes} feriado(s) nacional(es)</strong>
    sin cargar (${escapeHtml(detalle)}). Mientras no estén, el asistente va a
    ofrecer y confirmar citas esos días.</p>

    ${
      anioSiguiente
        ? `<p><strong>Conviene cargar el año que viene ahora.</strong> Si se
           deja para enero, el asistente va a ofrecer citas el Año Nuevo y
           los primeros feriados del año.</p>`
        : ""
    }

    <p>La plataforma ya tiene el calendario de feriados del país: solo hay
    que revisar la lista y confirmar en cuáles no se atiende. Si la clínica
    sí atiende algún feriado, se deja sin cargar y listo.</p>

    <p>Para un feriado en el que se atiende con horario reducido, se puede
    cargar como día con horario especial en vez de cerrado.</p>

    <p><a href="${escapeHtml(params.configUrl)}">Revisar el calendario de feriados</a></p>

    <p style="color:#666">Este aviso se repite una vez por semana mientras
    queden feriados sin revisar.</p>
  `;

  const anios = params.porAnio.map((a) => a.year).join(" y ");
  await transporter.sendMail({
    from: env.smtp.user,
    to: params.clinicEmail,
    subject: `Feriados de ${anios} sin cargar — ${params.clinicName}`,
    html,
  });
}

/**
 * Le manda a un usuario recién invitado el link para elegir su contraseña.
 * Mismo mecanismo que "olvidé mi contraseña" (ver sendPasswordResetEmail) —
 * la única diferencia es el copy, para que quede claro que es la primera
 * vez y no un pedido que hizo el propio usuario.
 */
export async function sendAccountInvitationEmail(params: {
  toEmail: string;
  userName: string;
  setPasswordUrl: string;
}): Promise<void> {
  const html = `
    <h2>Te invitaron a la plataforma</h2>
    <p>Hola ${escapeHtml(params.userName)}, se creó una cuenta para ti.
    Elige tu contraseña para poder ingresar:</p>
    <p><a href="${escapeHtml(params.setPasswordUrl)}">Elegir mi contraseña</a></p>
    <p style="color:#666">Este link vence en 1 hora.</p>
  `;
  await transporter.sendMail({
    from: env.smtp.user,
    to: params.toEmail,
    subject: "Te invitaron a la plataforma — elige tu contraseña",
    html,
  });
}

/** Email de "olvidé mi contraseña". No confirma si el email existe o no. */
export async function sendPasswordResetEmail(params: {
  toEmail: string;
  userName: string;
  resetUrl: string;
}): Promise<void> {
  const html = `
    <h2>Recuperar contraseña</h2>
    <p>Hola ${escapeHtml(params.userName)}, pediste restablecer tu contraseña.
    Si no fuiste tú, puedes ignorar este email.</p>
    <p><a href="${escapeHtml(params.resetUrl)}">Elegir una contraseña nueva</a></p>
    <p style="color:#666">Este link vence en 1 hora.</p>
  `;
  await transporter.sendMail({
    from: env.smtp.user,
    to: params.toEmail,
    subject: "Recuperar contraseña",
    html,
  });
}

function hora(date: Date, timezone?: string): string {
  return date.toLocaleTimeString("es", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  });
}

/** Escapa los datos que vienen de la conversación antes de meterlos en el HTML. */
/**
 * Recordatorio de que vence (o ya venció) un secreto de la plataforma.
 *
 * Va a los administradores de la plataforma y se repite todos los días hasta
 * que registren la fecha del secreto nuevo, así que el mail tiene que
 * alcanzar para actuar sin buscar nada: qué se rompe y qué pasos seguir.
 */
export async function sendSecretExpiryReminder(params: {
  to: string[];
  label: string;
  /** "vence en 3 días", "vence HOY", "venció hace 2 días". */
  cuando: string;
  vencido: boolean;
  expiresOn: string;
  impact: string;
  renewal: readonly string[];
  note: string | null;
  screenUrl: string;
}): Promise<void> {
  const html = `
    <h2>${params.vencido ? "VENCIÓ" : "Vence"}: ${escapeHtml(params.label)}</h2>

    <p><strong>${escapeHtml(params.label)} ${escapeHtml(params.cuando)}</strong>
    (${escapeHtml(params.expiresOn)}).</p>

    <p><strong>Qué pasa si vence:</strong> ${escapeHtml(params.impact)}</p>

    <p>Para renovarlo:</p>
    <ol>
      ${params.renewal.map((paso) => `<li>${escapeHtml(paso)}</li>`).join("\n      ")}
    </ol>

    ${params.note ? `<p>Nota registrada: ${escapeHtml(params.note)}</p>` : ""}

    <p><a href="${escapeHtml(params.screenUrl)}">Registrar la fecha del secreto nuevo</a></p>

    <p style="color:#666">Este aviso se repite una vez por día hasta que se
    registre un vencimiento nuevo.</p>
  `;

  await transporter.sendMail({
    from: env.smtp.user,
    to: params.to.join(", "),
    subject: `${params.vencido ? "VENCIÓ" : "Vence"}: ${params.label} — ${params.cuando}`,
    html,
  });
}

/**
 * Aviso a los administradores de la plataforma de que Google rechaza la app de OAuth
 * (`jobs/google-oauth-health.ts`). Es la falla silenciosa típica: nadie se entera hasta
 * que una clínica no puede conectar su calendario o se le cae el espejo.
 */
export async function sendGoogleOAuthInvalidAlert(params: { to: string[]; screenUrl: string }): Promise<void> {
  const html = `
    <h2>Google rechaza la app de OAuth de la plataforma</h2>

    <p>La comprobación diaria contra Google dio <strong>credenciales inválidas</strong>
    (<code>invalid_client</code>): el ID de cliente o el secreto ya no sirven, por ejemplo porque
    se rotó o se borró en Google Cloud Console.</p>

    <p><strong>Qué pasa mientras tanto:</strong> ninguna clínica puede conectar su calendario de
    Google y las cuentas ya conectadas no se pueden refrescar, así que los turnos dejan de
    reflejarse y los bloqueos dejan de importarse.</p>

    <p>Para resolverlo, carga el secreto vigente en Catálogos → Secretos → "Google Calendar
    (OAuth)" (se verifica contra Google antes de guardar):</p>
    <p><a href="${escapeHtml(params.screenUrl)}">Abrir la pantalla de Secretos</a></p>

    <p style="color:#666">Este aviso se repite una vez por día hasta que Google acepte la app.</p>
  `;

  await transporter.sendMail({
    from: env.smtp.user,
    to: params.to.join(", "),
    subject: "Google rechaza la app de OAuth de la plataforma",
    html,
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * El destinatario y el nombre que aparecen en el reporte son de cada clínica.
 *
 * Los turnos salen de Postgres (ver jobs/daily-report.ts). Los bloqueos son
 * tiempo personal de cada profesional importado de su Google Calendar, y se
 * listan aparte y sin detalle a propósito: sirven para entender por qué un
 * hueco no estaba disponible, no para que la clínica vea la agenda privada
 * de nadie.
 */
export async function sendDailyReport(params: {
  clinicName: string;
  clinicEmail: string;
  timezone?: string;
  appointments: DailyReportAppointment[];
  blocks?: DailyReportBlock[];
}): Promise<void> {
  const rows = params.appointments
    .map(
      (a) =>
        `<tr><td>${hora(a.startTime, params.timezone)}</td><td>${escapeHtml(
          a.patientName
        )}</td><td>${escapeHtml(a.service)}</td><td>${escapeHtml(
          a.professionalName
        )}</td><td>${escapeHtml(a.roomName ?? "—")}</td></tr>`
    )
    .join("\n");

  const blocks = params.blocks ?? [];
  const blockRows = blocks
    .map((b) => {
      const cuando = b.isAllDay
        ? "Todo el día"
        : `${hora(b.startTime, params.timezone)} a ${hora(b.endTime, params.timezone)}`;
      return `<tr><td>${cuando}</td><td>${escapeHtml(b.professionalName)}</td></tr>`;
    })
    .join("\n");

  const blocksSection = blocks.length
    ? `
    <h3>Tiempo bloqueado</h3>
    <p style="color:#666">Ratos que los profesionales tienen ocupados en su
    propia agenda. No son citas de la clínica.</p>
    <table border="1" cellpadding="6" cellspacing="0">
      <tr><th>Cuándo</th><th>Profesional</th></tr>
      ${blockRows}
    </table>`
    : "";

  const html = `
    <h2>Citas de hoy — ${escapeHtml(params.clinicName)}</h2>
    <table border="1" cellpadding="6" cellspacing="0">
      <tr><th>Hora</th><th>Paciente</th><th>Servicio</th><th>Profesional</th><th>Espacio</th></tr>
      ${rows || '<tr><td colspan="5">Sin citas agendadas para hoy</td></tr>'}
    </table>
    ${blocksSection}
  `;

  await transporter.sendMail({
    from: env.smtp.user,
    to: params.clinicEmail,
    subject: `Citas de hoy — ${new Date().toLocaleDateString()}`,
    html,
  });
}

/**
 * Aviso de que el asistente derivó un caso a una persona.
 *
 * Va aparte de `sendDailyReport` (que espera una lista de turnos) porque es
 * otra cosa: alguien está esperando que lo contacten, y el bot ya se lo
 * prometió. El asunto lleva el motivo adelante para que se distinga de un
 * resumen diario en una bandeja llena.
 */
export async function sendEscalationAlert(params: {
  clinicName: string;
  to: string;
  motivo: string;
  esUrgencia: boolean;
  patientName: string | null;
  patientPhone: string;
  patientMessage: string;
  escalationsUrl: string;
  /** Texto extra con qué hacer (p. ej. cargar un servicio faltante). */
  nota?: string;
}): Promise<void> {
  const html = `
    <h2>${params.esUrgencia ? "Urgencia" : "Consulta derivada"} — ${escapeHtml(
      params.clinicName
    )}</h2>

    <p><strong>El asistente le dijo a esta persona que alguien de la clínica la
    va a contactar.</strong> Está esperando esa respuesta.</p>

    <table>
      <tr><td><strong>Motivo</strong></td><td>${escapeHtml(params.motivo)}</td></tr>
      <tr><td><strong>Nombre</strong></td><td>${escapeHtml(
        params.patientName ?? "sin nombre registrado"
      )}</td></tr>
      <tr><td><strong>WhatsApp</strong></td><td>${escapeHtml(params.patientPhone)}</td></tr>
    </table>

    <p><strong>Lo que escribió:</strong></p>
    <blockquote>${escapeHtml(params.patientMessage)}</blockquote>

    <p>Respondele directamente por WhatsApp a ese número.</p>
    ${params.nota ? `<p><strong>${escapeHtml(params.nota)}</strong></p>` : ""}

    <p>Queda registrado en <a href="${escapeHtml(
      params.escalationsUrl
    )}">la pantalla "Por atender"</a>, donde se marca como resuelto.</p>
  `;

  await transporter.sendMail({
    from: env.smtp.user,
    to: params.to,
    subject: `${params.esUrgencia ? "[URGENTE]" : "[Por atender]"} ${
      params.patientName ?? params.patientPhone
    } — ${params.clinicName}`,
    html,
  });
}

/**
 * Aviso al profesional de que le asignaron un turno nuevo.
 *
 * Va como **invitación de calendario**, no como un mail suelto: lleva
 * adjunto un `.ics` con `METHOD:REQUEST`, así el gestor de correo lo muestra
 * como invitación y le ofrece agregarlo a su calendario personal con un
 * click. Sin eso, el profesional tendría que copiar la fecha a mano.
 */
export async function sendProfessionalAppointmentEmail(params: {
  clinicName: string;
  clinicEmail: string;
  to: string;
  professionalName: string;
  appointmentId: string;
  start: Date;
  end: Date;
  fecha: string;
  hora: string;
  service: string;
  patientName: string;
  roomName: string | null;
  /** Le tocó un espacio que no es el suyo porque el habitual estaba ocupado. */
  preferredRoomUnavailable: boolean;
  /** Qué le pasó a la cita. Default: recién agendada. */
  evento?: "agendada" | "modificada" | "cancelada";
  /** Solo en `cancelada`: la cita pasó a otro profesional (no se canceló, ya no es suya). */
  reasignada?: boolean;
}): Promise<void> {
  const evento = params.evento ?? "agendada";
  const titulo = { agendada: "Cita nueva", modificada: "Cita modificada", cancelada: "Cita cancelada" }[evento];
  const intro = {
    agendada: "te asignamos esta cita:",
    modificada: "esta cita de tu agenda cambió. Quedó así:",
    cancelada: params.reasignada
      ? "esta cita ya no es tuya, se reasignó a otro profesional:"
      : "se canceló esta cita de tu agenda:",
  }[evento];
  const html = `
    <h2>${titulo} — ${escapeHtml(params.clinicName)}</h2>

    <p>Hola ${escapeHtml(params.professionalName)}, ${intro}</p>

    <table>
      <tr><td><strong>Fecha</strong></td><td>${escapeHtml(params.fecha)}</td></tr>
      <tr><td><strong>Hora</strong></td><td>${escapeHtml(params.hora)}</td></tr>
      <tr><td><strong>Servicio</strong></td><td>${escapeHtml(params.service)}</td></tr>
      <tr><td><strong>Paciente</strong></td><td>${escapeHtml(params.patientName)}</td></tr>
      ${
        params.roomName
          ? `<tr><td><strong>Espacio</strong></td><td>${escapeHtml(params.roomName)}${
              params.preferredRoomUnavailable
                ? " — tu espacio habitual estaba ocupado a esa hora"
                : ""
            }</td></tr>`
          : ""
      }
    </table>
  `;

  const ics = buildAppointmentIcs({
    appointmentId: params.appointmentId,
    start: params.start,
    end: params.end,
    summary: `${params.service} — ${params.patientName}`,
    description: [
      `Paciente: ${params.patientName}`,
      `Servicio: ${params.service}`,
      params.roomName
        ? `Espacio: ${params.roomName}${
            params.preferredRoomUnavailable
              ? " (tu espacio habitual estaba ocupado a esa hora)"
              : ""
          }`
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
    location: params.roomName,
    organizerName: params.clinicName,
    organizerEmail: params.clinicEmail,
    attendeeName: params.professionalName,
    attendeeEmail: params.to,
    // Una actualización o una baja del mismo turno lleva el mismo UID y una versión mayor: así el calendario del
    // profesional mueve o saca la cita en lugar de dejar la vieja.
    method: evento === "cancelada" ? "CANCEL" : "REQUEST",
    sequence: evento === "agendada" ? 0 : Math.floor(Date.now() / 1000),
  });

  await transporter.sendMail({
    from: env.smtp.user,
    to: params.to,
    subject: `${titulo}: ${params.fecha} ${params.hora} — ${params.clinicName}`,
    html,
    // `icalEvent` de nodemailer arma las cabeceras que hacen que se vea como
    // invitación (text/calendar; method=REQUEST). Adjuntarlo como un archivo
    // común lo dejaría como un adjunto que hay que abrir a mano.
    icalEvent: { method: evento === "cancelada" ? "CANCEL" : "REQUEST", filename: "turno.ics", content: ics },
  });
}

export interface PackageReminderRow {
  /** Ya formateado en la zona de la clínica: "10:30" (hoy) o "16/11 10:30" (atrasada). */
  cuando: string;
  paciente: string;
  servicio: string;
  profesional: string;
  /** Sesiones del paquete que le quedan sin descontar esta. */
  quedan: number;
  total: number;
}

/**
 * Le recuerda a quien lleva la agenda las citas que vienen por un paquete de
 * sesiones y todavía nadie marcó como atendidas.
 *
 * Va por email y a quienes tienen `paquetes.gestionar`: es un aviso operativo
 * interno, no un mensaje a un paciente (por eso no pasa por una plantilla de
 * Meta). Existe porque la sesión solo se descuenta cuando una persona marca la
 * cita, y si se olvida el paciente cree que le quedan más de las que le quedan.
 */
export async function sendPackageReminder(params: {
  clinicName: string;
  to: string[];
  hoy: PackageReminderRow[];
  atrasadas: PackageReminderRow[];
  panelUrl: string;
}): Promise<void> {
  const filas = (rows: PackageReminderRow[]) =>
    rows
      .map(
        (r) =>
          `<li><strong>${escapeHtml(r.cuando)}</strong> — ${escapeHtml(r.paciente)}
           <span style="color:#666">· ${escapeHtml(r.servicio)} · ${escapeHtml(r.profesional)}
           · le quedan ${r.quedan} de ${r.total}</span></li>`
      )
      .join("");

  const atrasadas = params.atrasadas.length
    ? `<p><strong>Sin marcar de días anteriores (${params.atrasadas.length}).</strong>
       Estas citas ya pasaron y la sesión del paquete todavía no se descontó:</p>
       <ul>${filas(params.atrasadas)}</ul>`
    : "";
  const hoy = params.hoy.length
    ? `<p><strong>Hoy vienen por paquete (${params.hoy.length}):</strong></p>
       <ul>${filas(params.hoy)}</ul>`
    : "";

  const html = `
    <h2>Citas por paquete para marcar — ${escapeHtml(params.clinicName)}</h2>

    <p>La sesión de un paquete se descuenta <strong>cuando marcas la cita como
    atendida</strong>, no al agendarla. Si no se marca, al paciente le van a
    figurar más sesiones de las que le quedan.</p>

    ${atrasadas}
    ${hoy}

    <p><a href="${escapeHtml(params.panelUrl)}">Marcarlas desde "Citas"</a></p>

    <p style="color:#666">Este aviso llega una vez por día mientras haya citas por
    paquete sin marcar.</p>
  `;

  await transporter.sendMail({
    from: env.smtp.user,
    to: params.to,
    subject:
      params.atrasadas.length > 0
        ? `Hay citas por paquete sin marcar — ${params.clinicName}`
        : `Hoy vienen por paquete — ${params.clinicName}`,
    html,
  });
}
