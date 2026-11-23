import type { PermissionKey } from "../config/permissions";

/**
 * Forma mínima que necesitamos de un User con sus roles y permisos
 * cargados (ver `findUserForLogin` / `findUserWithPermissionsById`), para
 * no acoplar esta función al tipo exacto que devuelve Prisma.
 */
interface UserWithRoles {
  roles: Array<{
    role: {
      permissions: Array<{ permission: { id: string } }>;
    };
  }>;
}

/** Unión de los permisos de todos los roles del usuario. */
export function resolvePermissions(user: UserWithRoles): Set<PermissionKey> {
  const permissions = new Set<PermissionKey>();
  for (const userRole of user.roles) {
    for (const rolePermission of userRole.role.permissions) {
      permissions.add(rolePermission.permission.id as PermissionKey);
    }
  }
  return permissions;
}
