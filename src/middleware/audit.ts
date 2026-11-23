import type { NextFunction, Request, Response } from "express";
import { SESSION_COOKIE_NAME, verifySession } from "../services/auth";
import {
  bodyFieldNames,
  deriveFromRoute,
  isAuditable,
  outcomeFromStatus,
  recordAudit,
  routePattern,
  unmatchedDenied,
  type AuditEnrichment,
} from "../services/audit";

/**
 * Audita cada operación de la API: una fila de `AuditLog` por cada POST, PUT, PATCH
 * y DELETE, y por la lectura de datos sensibles (ver `services/audit.ts`).
 *
 * **Va como middleware global, montado antes de los routers**, y no ruta por ruta: así
 * una ruta nueva queda auditada sin que nadie se acuerde. Registra al terminar la
 * respuesta (`finish`), cuando ya se sabe qué ruta atendió el pedido, quién era el
 * usuario y con qué resultado — y también cuando la operación fue DENEGADA o falló.
 *
 * Una ruta puede sumarle contexto con `enrichAudit(res, …)`; la fila la escribe
 * siempre este middleware.
 *
 * **No registra valores**: solo los nombres de los campos que vinieron en el cuerpo.
 * Un fallo escribiendo la auditoría no puede afectar la respuesta, que ya salió.
 */
export function auditRequests(req: Request, res: Response, next: NextFunction): void {
  res.on("finish", () => {
    void registrar(req, res).catch((error) => {
      // `recordAudit` ya no lanza; esto es por un fallo antes de llamarlo.
      console.error("Error armando el registro de auditoría:", error);
    });
  });
  next();
}

async function registrar(req: Request, res: Response): Promise<void> {
  let pattern = routePattern(req);
  let params = req.params as Record<string, string>;

  // Un middleware de router (`authenticate`) rechaza antes de que ninguna ruta atienda
  // el pedido: no hay `req.route`. Un intento SIN SESIÓN de modificar algo es justo lo que
  // más importa registrar, así que se arma el patrón a partir de la URL.
  if (!pattern) {
    const sinRuta = unmatchedDenied(req.method, req.originalUrl, res.statusCode);
    if (!sinRuta) return;
    pattern = sinRuta.pattern;
    params = sinRuta.clinicId ? { clinicId: sinRuta.clinicId } : {};
  } else if (!isAuditable(req.method, pattern)) {
    return;
  }

  const derived = deriveFromRoute(req.method, pattern, params);
  const extra = (res.locals.audit as AuditEnrichment | undefined) ?? {};

  // Quién: la sesión cargada; si no la hubo (un logout, un login), lo que puso la
  // ruta; y, como último recurso, el id que lleva la cookie (sin ir a la base).
  let userId = req.user?.id ?? extra.actor?.userId ?? null;
  const userEmail = req.user?.email ?? extra.actor?.email ?? null;
  const userName = req.user?.name ?? extra.actor?.name ?? null;
  if (!userId && !extra.actor) {
    const token = req.cookies?.[SESSION_COOKIE_NAME];
    userId = (token ? verifySession(token)?.userId : null) ?? null;
  }

  const { campos, omitidos } = bodyFieldNames(req.body);
  const details: Record<string, unknown> = { ...(extra.details ?? {}) };
  if (campos.length > 0) details.campos = campos;
  if (omitidos) details.camposSensiblesOmitidos = true;

  await recordAudit({
    userId,
    userEmail,
    userName,
    clinicId: extra.clinicId !== undefined ? extra.clinicId : (derived.clinicId ?? req.user?.clinicId ?? null),
    // Todo lo que pasa por la API lo hace una persona desde el panel.
    origin: "panel",
    action: extra.action ?? derived.action,
    method: req.method,
    route: pattern,
    resourceType: extra.resourceType ?? derived.resourceType,
    resourceId: extra.resourceId ?? derived.resourceId,
    outcome: outcomeFromStatus(res.statusCode),
    statusCode: res.statusCode,
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
    details: Object.keys(details).length > 0 ? (details as never) : null,
  });
}
