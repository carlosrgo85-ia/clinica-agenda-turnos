import type { ReactNode } from "react";
import { useAuth } from "./AuthContext";

/** Oculta el contenido si el usuario no tiene el permiso — no bloquea, solo esconde. */
export function RequirePermission({
  permission,
  children,
  fallback = null,
}: {
  permission: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { hasPermission } = useAuth();
  return <>{hasPermission(permission) ? children : fallback}</>;
}
