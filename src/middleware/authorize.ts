import type { NextFunction, Request, Response } from "express";
import type { PermissionKey } from "../config/permissions";
import type { AuthenticatedUser } from "./authenticate";

/**
 * La misma regla que `requirePermission`, para rutas donde el `clinicId` no
 * viene en `req.params` (el flujo de OAuth lo recibe por query o por el
 * `state`). Un super-admin (`clinicId: null`) accede a cualquier clínica.
 */
export function userCanAccessClinic(
  user: AuthenticatedUser,
  clinicId: string,
  permission: PermissionKey
): boolean {
  if (user.clinicId !== null && user.clinicId !== clinicId) return false;
  return user.permissions.has(permission);
}

/**
 * Requiere que `req.user` (cargado por `authenticate`) tenga el permiso
 * dado. Si la ruta tiene un `:clinicId` en los params, además exige que el
 * usuario pertenezca a esa clínica — un super-admin (`clinicId: null`)
 * pasa siempre. Esto es la puerta de autorización antes de llegar a los
 * repositorios, que igual siguen filtrando por `clinicId` como defensa en
 * profundidad (mismo patrón que el resto del código).
 */
export function requirePermission(permission: PermissionKey) {
  const guard = (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "No autenticado" });
      return;
    }

    const { clinicId } = req.params;
    if (clinicId && user.clinicId !== null && user.clinicId !== clinicId) {
      res.status(403).json({ error: "No tienes acceso a esta clínica" });
      return;
    }

    if (!user.permissions.has(permission)) {
      res.status(403).json({ error: "No tienes permiso para esta acción" });
      return;
    }

    next();
  };
  // El nombre de la función dice qué permiso exige: así un test puede recorrer todas las rutas y
  // comprobar que ninguna quedó sin esta puerta (`tests/route-guards.test.ts`).
  Object.defineProperty(guard, "name", { value: `requirePermission:${permission}` });
  return guard;
}

/** Solo para rutas de plataforma: exige que el usuario NO tenga clínica asociada. */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  if (req.user.clinicId !== null) {
    res.status(403).json({ error: "Solo para administradores de plataforma" });
    return;
  }
  next();
}
