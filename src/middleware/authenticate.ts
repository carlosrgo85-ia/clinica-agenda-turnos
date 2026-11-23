import type { NextFunction, Request, Response } from "express";
import type { PermissionKey } from "../config/permissions";
import { SESSION_COOKIE_NAME, verifySession } from "../services/auth";
import { findUserWithPermissionsById } from "../repositories/users.repository";
import { resolvePermissions } from "../services/permissions";

export interface AuthenticatedUser {
  id: string;
  clinicId: string | null;
  email: string;
  name: string;
  permissions: Set<PermissionKey>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/**
 * Lee la cookie de sesión, valida el JWT, y carga el usuario + sus
 * permisos efectivos en `req.user`. 401 si falta o es inválida, o si el
 * usuario fue desactivado después de haber firmado el token.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  const payload = token ? verifySession(token) : null;
  if (!payload) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  const user = await findUserWithPermissionsById(payload.userId);
  if (!user || !user.active) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  req.user = {
    id: user.id,
    clinicId: user.clinicId,
    email: user.email,
    name: user.name,
    permissions: resolvePermissions(user),
  };
  next();
}
