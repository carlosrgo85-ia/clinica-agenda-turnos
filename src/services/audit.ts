import type { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { prisma } from "../db/client";
import { describeError, recordSystemEvent, SYSTEM_EVENT_KINDS } from "./system-events";

/**
 * El registro de auditoría de TODA la aplicación (`AuditLog`).
 *
 * Quién hizo qué, cuándo, sobre qué y con qué resultado, desde el login. Lo escribe
 * el middleware `middleware/audit.ts` para cada operación que modifica algo y para
 * la lectura de datos sensibles, así que una ruta nueva queda cubierta sin que
 * nadie se acuerde. Ver "Auditoría" en CLAUDE.md.
 *
 * **Solo se agrega** (un trigger de la base impide editar o borrar), y **nunca guarda
 * valores de lo que se escribió**: solo los NOMBRES de los campos que cambiaron.
 */

export type AuditOutcome = "ok" | "denegado" | "error";

/**
 * Desde dónde se originó una operación:
 * - `panel`: una persona desde la aplicación web (la API). Lo escribe el middleware.
 * - `whatsapp`: el asistente, por un mensaje del paciente.
 * - `sistema`: un job.
 * Las dos últimas NO pasan por el middleware: quien las hace tiene que registrarlas
 * explícitamente con `recordSystemAudit()`.
 */
export type AuditOrigin = "panel" | "whatsapp" | "sistema";

export const AUDIT_ORIGIN_LABELS: Record<AuditOrigin, string> = {
  panel: "Panel",
  whatsapp: "Asistente (WhatsApp)",
  sistema: "Sistema",
};

export interface AuditEntry {
  userId?: string | null;
  userEmail?: string | null;
  userName?: string | null;
  clinicId?: string | null;
  /** Desde dónde se originó. El middleware pone `panel`. */
  origin?: AuditOrigin | null;
  action: string;
  method?: string | null;
  route?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  outcome: AuditOutcome;
  statusCode?: number | null;
  ip?: string | null;
  userAgent?: string | null;
  details?: Prisma.InputJsonValue | null;
}

const MAX_TEXT = 200;
const recortar = (v: string | null | undefined, max = MAX_TEXT): string | null =>
  v ? (v.length > max ? v.slice(0, max) : v) : null;

/**
 * Registra una entrada. **Nunca lanza**: se llama al terminar una respuesta que ya se
 * mandó, y que falle el registro no puede tumbar nada. Pero un hueco en la
 * auditoría es grave, así que además de loguearlo deja un evento en Monitoreo.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: entry.userId ?? null,
        userEmail: recortar(entry.userEmail),
        userName: recortar(entry.userName),
        clinicId: entry.clinicId ?? null,
        origin: entry.origin ?? null,
        action: recortar(entry.action, 160) ?? "desconocida",
        method: entry.method ?? null,
        route: recortar(entry.route, 300),
        resourceType: recortar(entry.resourceType, 80),
        resourceId: recortar(entry.resourceId, 80),
        outcome: entry.outcome,
        statusCode: entry.statusCode ?? null,
        ip: recortar(entry.ip, 64),
        userAgent: recortar(entry.userAgent),
        details: entry.details ?? undefined,
      },
    });
  } catch (error) {
    console.error("No se pudo registrar la auditoría:", error);
    await recordSystemEvent({
      kind: SYSTEM_EVENT_KINDS.AUDITORIA_FALLO,
      clinicId: entry.clinicId ?? null,
      message: `${entry.action}: ${describeError(error)}`,
    });
  }
}

/**
 * Registra una operación que NO hizo un usuario del panel y por eso no pasa por el
 * middleware: el asistente por WhatsApp o un job. **Es obligatorio llamarla desde cualquier
 * código de ese tipo que modifique datos** (ver "Reglas transversales" en CLAUDE.md).
 *
 * `details` solo con datos estructurados y NO sensibles (de qué etapa a cuál, qué campos
 * cambiaron): nunca valores de lo que escribió el paciente.
 */
export function recordSystemAudit(entry: {
  origin: AuditOrigin;
  /** Una persona, si la hubo (por ejemplo, quien confirmó una asistencia desde el panel). */
  userId?: string | null;
  clinicId?: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  details?: Prisma.InputJsonValue | null;
}): Promise<void> {
  return recordAudit({
    userId: entry.userId ?? null,
    clinicId: entry.clinicId ?? null,
    origin: entry.origin,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    outcome: "ok",
    details: entry.details ?? null,
  });
}

/** 2xx/3xx = ok; 401, 403 y 429 = denegado (alguien intentó y no pudo); el resto = error. */
export function outcomeFromStatus(status: number): AuditOutcome {
  if (status < 400) return "ok";
  if (status === 401 || status === 403 || status === 429) return "denegado";
  return "error";
}

// --- Qué se audita ---

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Lecturas que SÍ se auditan: datos de pacientes y conversaciones (salud, contacto)
 * y la propia auditoría. Auditar todos los GET llenaría la tabla con cada refresco de
 * pantalla y taparía lo que importa.
 */
const SENSITIVE_READS: RegExp[] = [
  /^GET \/dashboard\/clinics\/:clinicId\/patients\/:patientId$/,
  /^GET \/dashboard\/clinics\/:clinicId\/conversations/,
  // Los contactos de las campañas traen nombre y teléfono.
  /^GET \/dashboard\/clinics\/:clinicId\/campaigns\/leads/,
  // Los reportes muestran nombres de pacientes en el detalle y se pueden exportar.
  /^GET \/dashboard\/clinics\/:clinicId\/reports\/:report$/,
  /^GET \/platform\/audit/,
  // Efectos con GET: el callback de OAuth conecta una cuenta de calendario.
  /^GET \/oauth\/[^/]+\/callback$/,
];

/** Lo que no se audita: lo manda Meta o es estático, sin ningún usuario detrás. */
const EXCLUDED_PREFIXES = ["/webhook", "/health", "/ui", "/app"];

export function routePattern(req: Request): string | null {
  const path = req.route?.path;
  if (typeof path !== "string") return null;
  const pattern = `${req.baseUrl}${path}`;
  return pattern === "" ? "/" : pattern;
}

export function isAuditable(method: string, pattern: string | null): boolean {
  if (!pattern) return false; // 404: no hay ruta, solo ruido de bots
  if (EXCLUDED_PREFIXES.some((p) => pattern === p || pattern.startsWith(`${p}/`))) return false;
  if (MUTATING.has(method)) return true;
  return SENSITIVE_READS.some((r) => r.test(`${method} ${pattern}`));
}

// --- Qué se hizo ---

/**
 * Claves semánticas de las operaciones principales, para que el registro se lea
 * ("appointment.cancel") y no solo como una ruta. Las que no están acá salen como
 * `METHOD patrón`, que sigue identificando la operación sin ambigüedad.
 */
export const ROUTE_ACTIONS: Record<string, string> = {
  "POST /auth/login": "auth.login",
  "POST /auth/logout": "auth.logout",
  "POST /auth/forgot-password": "auth.forgot_password",
  "POST /auth/reset-password": "auth.reset_password",
  "GET /oauth/:provider/callback": "calendar.connect",

  "POST /dashboard/clinics/:clinicId/appointments": "appointment.create",
  "PATCH /dashboard/clinics/:clinicId/appointments/:appointmentId": "appointment.update",
  "POST /dashboard/clinics/:clinicId/appointments/:appointmentId/cancel": "appointment.cancel",
  "POST /dashboard/clinics/:clinicId/appointments/:appointmentId/attended": "appointment.mark_attended",
  "DELETE /dashboard/clinics/:clinicId/appointments/:appointmentId/attended": "appointment.unmark_attended",

  "GET /dashboard/clinics/:clinicId/patients/:patientId": "patient.view",
  "GET /dashboard/clinics/:clinicId/conversations": "conversation.view",
  "GET /dashboard/clinics/:clinicId/conversations/:patientPhone": "conversation.view",
  "GET /dashboard/clinics/:clinicId/reports/:report": "report.view",
  "GET /platform/audit": "audit.view",
  "POST /dashboard/clinics/:clinicId/patients": "patient.create",
  "PUT /dashboard/clinics/:clinicId/patients/:patientId": "patient.update",
  "POST /dashboard/clinics/:clinicId/patients/:patientId/comments": "patient.comment_add",
  "DELETE /dashboard/clinics/:clinicId/patients/:patientId/comments/:commentId": "patient.comment_delete",

  "POST /dashboard/clinics/:clinicId/packages": "package.assign",
  "PUT /dashboard/clinics/:clinicId/packages/:packageId": "package.update",
  "POST /dashboard/clinics/:clinicId/test-chat": "sandbox.message",
  "DELETE /dashboard/clinics/:clinicId/test-chat": "sandbox.reset",
  "POST /dashboard/clinics/:clinicId/campaigns": "campaign.create",
  "PUT /dashboard/clinics/:clinicId/campaigns/:campaignId": "campaign.update",
  "POST /dashboard/clinics/:clinicId/campaigns/leads/:leadId/close": "campaign.lead_close",
  "POST /dashboard/clinics/:clinicId/package-templates": "package_template.create",
  "PUT /dashboard/clinics/:clinicId/package-templates/:templateId": "package_template.update",

  "POST /dashboard/clinics/:clinicId/users": "user.create",
  "PUT /dashboard/clinics/:clinicId/users/:userId": "user.update",
  "DELETE /dashboard/clinics/:clinicId/users/:userId": "user.deactivate",
  "POST /dashboard/clinics/:clinicId/roles": "role.create",
  "PUT /dashboard/clinics/:clinicId/roles/:roleId": "role.update",
  "DELETE /dashboard/clinics/:clinicId/roles/:roleId": "role.delete",

  "POST /platform/clinics": "clinic.create",
  "PUT /platform/clinics/:id": "clinic.update",
  "PUT /platform/clinics/:id/membership": "clinic.membership_update",
  "POST /platform/clinics/:id/whatsapp/templates": "clinic.whatsapp_templates_sync",
  "POST /platform/google-oauth/verify": "platform.google_oauth_verify",
  "PUT /platform/google-oauth": "platform.google_oauth_update",
  "DELETE /platform/google-oauth": "platform.google_oauth_delete",
  "PUT /platform/costs/rates": "platform.cost_rate_set",
  "DELETE /platform/costs/rates/:id": "platform.cost_rate_delete",
  "PUT /platform/costs/fx-rates": "platform.fx_rate_set",
  "DELETE /platform/costs/fx-rates/:id": "platform.fx_rate_delete",
  "PUT /platform/secrets/:key": "platform.secret_update",
  "DELETE /platform/secrets/:key": "platform.secret_delete",
  "DELETE /platform/secrets/:key/value": "platform.secret_value_delete",
};

/** Etiquetas en español para la pantalla de auditoría. */
export const ACTION_LABELS: Record<string, string> = {
  "auth.login": "Inicio de sesión",
  "auth.logout": "Cierre de sesión",
  "auth.forgot_password": "Pidió recuperar la contraseña",
  "auth.reset_password": "Cambió la contraseña con el link",
  "calendar.connect": "Conectó una cuenta de calendario",
  "appointment.create": "Creó una cita",
  "appointment.update": "Modificó una cita",
  "appointment.cancel": "Canceló una cita",
  "appointment.mark_attended": "Marcó una cita como atendida",
  "appointment.unmark_attended": "Deshizo una asistencia",
  "patient.view": "Vio la ficha de un paciente",
  "conversation.view": "Vio una conversación",
  "audit.view": "Consultó la auditoría",
  "report.view": "Consultó un reporte",
  "report.export": "Exportó un reporte",
  "patient.create": "Cargó un paciente",
  "patient.update": "Editó la ficha de un paciente",
  "patient.comment_add": "Agregó un comentario a un paciente",
  "patient.comment_delete": "Borró un comentario de un paciente",
  "patient.create_whatsapp": "Se cargó un paciente (por WhatsApp)",
  "patient.name_set": "Se registró el nombre de un paciente",
  "patient.stage_change": "Cambió la etapa de un paciente",
  "patient.import": "Importó pacientes de la clínica (carga inicial)",
  "patient.assistant_intro_sent": "Se le avisó por WhatsApp que lo atiende un asistente virtual",
  "patient.privacy_notice_sent": "Se le mandó por WhatsApp el link al aviso de privacidad de la clínica",
  "patient.import_rollback": "Deshizo una importación de pacientes",
  "patient.outreach_sent": "Se le escribió a un paciente por su próxima cita",
  "package.assign": "Asignó un paquete a un paciente",
  "package.update": "Modificó el paquete de un paciente",
  "sandbox.message": "Habló con el asistente en el chat de pruebas",
  "sandbox.reset": "Reinició el chat de pruebas",
  "campaign.create": "Creó una campaña",
  "campaign.update": "Modificó una campaña",
  "campaign.lead_close": "Cerró el seguimiento de un contacto de una campaña",
  "campaign.lead_create": "Llegó un contacto por una campaña (WhatsApp)",
  "campaign.lead_converted": "Un contacto de una campaña agendó una cita (WhatsApp)",
  "campaign.followup_sent": "Se le mandó un seguimiento a un contacto de una campaña",
  "package_template.create": "Agregó un paquete al catálogo",
  "package_template.update": "Modificó un paquete del catálogo",
  "user.create": "Creó un usuario",
  "user.update": "Modificó un usuario",
  "user.deactivate": "Desactivó un usuario",
  "role.create": "Creó un rol",
  "role.update": "Modificó un rol",
  "role.delete": "Borró un rol",
  "clinic.create": "Creó una clínica",
  "clinic.update": "Modificó una clínica",
  "clinic.membership_update": "Cambió la membresía de una clínica",
  "clinic.whatsapp_templates_sync": "Sincronizó las plantillas de WhatsApp",
  "platform.google_oauth_update": "Cambió la app de Google de la plataforma",
  "platform.google_oauth_delete": "Quitó la app de Google de la plataforma",
  "platform.google_oauth_verify": "Verificó la app de Google contra Google",
  "platform.cost_rate_set": "Cargó una tarifa de costos",
  "platform.cost_rate_delete": "Borró una tarifa de costos",
  "platform.fx_rate_set": "Cargó un tipo de cambio",
  "platform.fx_rate_delete": "Borró un tipo de cambio",
  "platform.secret_update": "Modificó un secreto de la plataforma",
  "platform.secret_delete": "Dejó de seguir un secreto",
  "platform.secret_value_delete": "Quitó el valor de un secreto",
};

const VERBOS: Record<string, string> = {
  POST: "Creó o ejecutó",
  PUT: "Modificó",
  PATCH: "Modificó",
  DELETE: "Eliminó",
  GET: "Consultó",
};

/** "Canceló una cita", o, si la acción no tiene etiqueta, "Modificó working-hours". */
export function actionLabel(row: { action: string; method: string | null; resourceType: string | null }): string {
  const conocida = ACTION_LABELS[row.action];
  if (conocida) return conocida;
  const verbo = VERBOS[row.method ?? ""] ?? "Operó sobre";
  return row.resourceType ? `${verbo} ${row.resourceType}` : verbo;
}

export interface DerivedRoute {
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  clinicId: string | null;
}

/**
 * De la ruta que atendió el pedido, qué operación fue, sobre qué recurso y de qué
 * clínica. Se deriva del PATRÓN y de los parámetros: no de la URL cruda, que puede
 * traer datos en el query string.
 */
export function deriveFromRoute(method: string, pattern: string, params: Record<string, string>): DerivedRoute {
  const segmentos = pattern.split("/").filter(Boolean);
  const idxParams = segmentos.map((s, i) => (s.startsWith(":") ? i : -1)).filter((i) => i >= 0);

  // La clínica: `:clinicId`, o `:id` bajo /platform/clinics.
  const esRutaDeClinica = pattern.includes("/clinics/:id");
  const clinicId = params.clinicId ?? (esRutaDeClinica ? (params.id ?? null) : null);

  let resourceType: string | null = null;
  let resourceId: string | null = null;
  const ultimo = idxParams[idxParams.length - 1];
  if (ultimo !== undefined) {
    const nombre = segmentos[ultimo].slice(1);
    const esLaClinica = nombre === "clinicId" || (nombre === "id" && esRutaDeClinica && segmentos[ultimo - 1] === "clinics");
    const estaticosDespues = segmentos.slice(ultimo + 1).filter((s) => !s.startsWith(":"));
    if (esLaClinica && estaticosDespues.length > 0) {
      // /clinics/:clinicId/working-hours → el recurso es "working-hours", de esa clínica.
      resourceType = estaticosDespues[estaticosDespues.length - 1];
    } else {
      resourceType = ultimo > 0 ? segmentos[ultimo - 1] : nombre;
      resourceId = params[nombre] ?? null;
    }
  } else {
    resourceType = segmentos[segmentos.length - 1] ?? null;
  }

  // El callback de OAuth se registra con el nombre del proveedor en la ruta
  // (`/oauth/google/callback`), así que no está en la tabla por patrón.
  const esCallbackOAuth = method === "GET" && /^\/oauth\/[^/]+\/callback$/.test(pattern);

  return {
    action: esCallbackOAuth
      ? "calendar.connect"
      : (ROUTE_ACTIONS[`${method} ${pattern}`] ?? `${method} ${pattern}`),
    resourceType,
    resourceId,
    clinicId,
  };
}

// --- Qué se cambió (sin valores) ---

/** Campos cuyo NOMBRE ni siquiera se registra: hablan de credenciales. */
const SENSITIVE_FIELD = /pass(word)?|token|secret|credential|private_?key|^value$/i;

/**
 * Los NOMBRES de los campos que vinieron en el cuerpo, sin sus valores y sin los de
 * credenciales. Una observación clínica o una contraseña no pueden terminar en un
 * registro que se conserva por años.
 */
export function bodyFieldNames(body: unknown): { campos: string[]; omitidos: boolean } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { campos: [], omitidos: false };
  const todos = Object.keys(body as Record<string, unknown>);
  const campos = todos.filter((k) => !SENSITIVE_FIELD.test(k)).slice(0, 40);
  return { campos, omitidos: campos.length < todos.length };
}

// --- Enriquecimiento desde una ruta ---

export interface AuditEnrichment {
  /** Pisa la clave derivada de la ruta. */
  action?: string;
  resourceType?: string;
  resourceId?: string;
  clinicId?: string | null;
  /** Quién, cuando no hay sesión (un login): el id si se sabe y el email intentado. */
  actor?: { userId?: string | null; email?: string | null; name?: string | null };
  /**
   * Datos estructurados y NO sensibles que ayudan a entender la operación. Ojo con una
   * diferencia: `campos` (lo pone el middleware solo) son los campos que LLEGARON en el
   * pedido, no necesariamente los que cambiaron; donde importa saber lo que cambió de
   * verdad, la ruta lo calcula y lo pone acá (`camposModificados`).
   */
  details?: Record<string, Prisma.InputJsonValue | null>;
}

/**
 * Una ruta le suma contexto al registro de SU pedido (el motivo de una cancelación,
 * los permisos de un rol, el email de un login fallido). Mezcla con lo que ya puso:
 * el middleware es quien escribe, una sola fila por pedido.
 */
export function enrichAudit(res: Response, extra: AuditEnrichment): void {
  const previo = (res.locals.audit as AuditEnrichment | undefined) ?? {};
  res.locals.audit = {
    ...previo,
    ...extra,
    actor: extra.actor ?? previo.actor,
    details: { ...(previo.details ?? {}), ...(extra.details ?? {}) },
  };
}

// --- Consulta ---

export interface AuditFilters {
  /** Solo esta clínica. Sin él, todas (solo el super-admin). */
  clinicId?: string;
  userId?: string;
  /** Texto que tiene que contener el email del usuario. */
  userEmail?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  outcome?: string;
  origin?: string;
  from?: Date;
  to?: Date;
  /** Cursor: solo los anteriores a esta fecha. */
  before?: Date;
  limit?: number;
}

export async function listAudit(filters: AuditFilters) {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const rows = await prisma.auditLog.findMany({
    where: {
      ...(filters.clinicId ? { clinicId: filters.clinicId } : {}),
      ...(filters.userId ? { userId: filters.userId } : {}),
      ...(filters.userEmail ? { userEmail: { contains: filters.userEmail, mode: "insensitive" as const } } : {}),
      ...(filters.action ? { action: { contains: filters.action, mode: "insensitive" as const } } : {}),
      ...(filters.resourceType ? { resourceType: filters.resourceType } : {}),
      ...(filters.resourceId ? { resourceId: filters.resourceId } : {}),
      ...(filters.outcome ? { outcome: filters.outcome } : {}),
      ...(filters.origin ? { origin: filters.origin } : {}),
      ...(filters.from || filters.to || filters.before
        ? {
            occurredAt: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
              ...(filters.before ? { lt: filters.before } : {}),
            },
          }
        : {}),
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hayMas = rows.length > limit;
  const pagina = rows.slice(0, limit);
  return {
    registros: pagina.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt.toISOString(),
      userId: r.userId,
      userEmail: r.userEmail,
      userName: r.userName,
      clinicId: r.clinicId,
      origin: r.origin,
      origenEtiqueta: r.origin ? (AUDIT_ORIGIN_LABELS[r.origin as AuditOrigin] ?? r.origin) : null,
      action: r.action,
      etiqueta: actionLabel(r),
      method: r.method,
      route: r.route,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      outcome: r.outcome,
      statusCode: r.statusCode,
      ip: r.ip,
      details: r.details,
    })),
    siguiente: hayMas ? pagina[pagina.length - 1].occurredAt.toISOString() : null,
  };
}

/** Fecha o fecha-hora ISO del query string, o null si no es válida. */
function fechaDelQuery(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Los filtros del query string de la pantalla de auditoría. `hasta` como YYYY-MM-DD
 * incluye el día entero. Devuelve un error legible si una fecha no se entiende.
 */
export function auditFiltersFromQuery(
  q: Record<string, unknown>
): { ok: true; filters: AuditFilters } | { ok: false; error: string } {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const from = q.desde === undefined || q.desde === "" ? undefined : fechaDelQuery(q.desde);
  let to = q.hasta === undefined || q.hasta === "" ? undefined : fechaDelQuery(q.hasta);
  const before = q.before === undefined || q.before === "" ? undefined : fechaDelQuery(q.before);
  if (from === null || to === null || before === null) {
    return { ok: false, error: "Alguna de las fechas no se entiende (usa YYYY-MM-DD o una fecha ISO)." };
  }
  // "hasta el 15" incluye todo el día 15.
  if (to && typeof q.hasta === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q.hasta)) {
    to = new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1);
  }
  const limit = typeof q.limit === "string" ? Number(q.limit) : undefined;
  return {
    ok: true,
    filters: {
      userId: str(q.userId),
      userEmail: str(q.usuario),
      action: str(q.accion),
      resourceType: str(q.recurso),
      resourceId: str(q.recursoId),
      outcome: ["ok", "denegado", "error"].includes(String(q.resultado)) ? String(q.resultado) : undefined,
      origin: ["panel", "whatsapp", "sistema"].includes(String(q.origen)) ? String(q.origen) : undefined,
      from,
      to,
      before,
      limit: Number.isFinite(limit) ? limit : undefined,
    },
  };
}

/** Prefijos de la API donde un rechazo SIN ruta resuelta es una operación denegada que importa. */
const API_PREFIXES = ["/dashboard", "/platform", "/auth", "/oauth"];

/**
 * El patrón de una ruta que NO llegó a resolverse. Pasa cuando un middleware de router
 * (`authenticate`) rechaza el pedido antes de que ninguna ruta lo atienda: no hay
 * `req.route`, pero un intento sin sesión de modificar algo es justo lo que más
 * importa auditar.
 *
 * Los ids de la URL (largos o numéricos) se reemplazan por `:id`, y el de la clínica,
 * que sigue a `clinics`, por `:clinicId`: así no se cuelgan ids ni query string en el
 * registro. Solo para pedidos que MODIFICAN y fueron DENEGADOS, en la API: un 404 sin
 * ruta es ruido de bots.
 */
export function unmatchedDenied(
  method: string,
  originalUrl: string,
  status: number
): { pattern: string; clinicId: string | null } | null {
  if (!MUTATING.has(method) || (status !== 401 && status !== 403)) return null;
  const path = originalUrl.split("?")[0];
  if (!API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return null;
  if (EXCLUDED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return null;

  const segmentos = path.split("/").filter(Boolean);
  let clinicId: string | null = null;
  const normalizados = segmentos.map((s, i) => {
    if (segmentos[i - 1] === "clinics") {
      clinicId = s;
      return ":clinicId";
    }
    return /^[a-z0-9_-]{20,}$/i.test(s) || /^\d+$/.test(s) ? ":id" : s;
  });
  return { pattern: `/${normalizados.join("/")}`, clinicId };
}
