import { prisma } from "../db/client";
import { CLINIC_ADMIN_PERMISSION_IDS, PLATFORM_ONLY_PERMISSIONS } from "../config/permissions";

const ROLE_WITH_PERMISSIONS_INCLUDE = {
  permissions: { include: { permission: true } },
} as const;

/** Lista los roles de una clínica. `clinicId` null lista los de plataforma. */
export function listRolesByClinic(clinicId: string | null) {
  return prisma.role.findMany({
    where: { clinicId },
    include: ROLE_WITH_PERMISSIONS_INCLUDE,
    orderBy: { name: "asc" },
  });
}

export function findRoleInClinic(id: string, clinicId: string | null) {
  return prisma.role.findFirst({
    where: { id, clinicId },
    include: ROLE_WITH_PERMISSIONS_INCLUDE,
  });
}

/** Para validar que los roleIds que se le quieren asignar a un usuario existen y son de su clínica. */
export async function roleIdsBelongToClinic(roleIds: string[], clinicId: string | null): Promise<boolean> {
  if (roleIds.length === 0) return true;
  const count = await prisma.role.count({ where: { id: { in: roleIds }, clinicId } });
  return count === roleIds.length;
}

export function createRole(params: {
  clinicId: string | null;
  name: string;
  description?: string;
  permissionIds: string[];
}) {
  return prisma.role.create({
    data: {
      clinicId: params.clinicId,
      name: params.name,
      description: params.description,
      permissions: { create: params.permissionIds.map((permissionId) => ({ permissionId })) },
    },
    include: ROLE_WITH_PERMISSIONS_INCLUDE,
  });
}

export async function updateRoleInClinic(params: {
  id: string;
  clinicId: string | null;
  name?: string;
  description?: string;
  permissionIds?: string[];
}) {
  const existing = await prisma.role.findFirst({ where: { id: params.id, clinicId: params.clinicId } });
  if (!existing) return null;

  await prisma.role.update({
    where: { id: params.id },
    data: { name: params.name, description: params.description },
  });

  if (params.permissionIds) {
    await prisma.$transaction([
      prisma.rolePermission.deleteMany({ where: { roleId: params.id } }),
      prisma.rolePermission.createMany({
        data: params.permissionIds.map((permissionId) => ({ roleId: params.id, permissionId })),
      }),
    ]);
  }

  return findRoleInClinic(params.id, params.clinicId);
}

/**
 * Crea el rol "Admin de clínica" para una clínica nueva, con todos los
 * permisos salvo los de plataforma. Se llama al dar de alta una clínica, tanto
 * desde `scripts/add-clinic.ts` como desde `routes/platform.ts`.
 *
 * Si el rol ya existe, le agrega los permisos que le falten en vez de no hacer
 * nada: cuando se suma un permiso nuevo al catálogo, los roles de las clínicas
 * ya creadas quedarían sin él para siempre y sus admins no verían la pantalla
 * nueva. Nunca quita permisos — alcanzarían para dejar afuera algo que alguien
 * agregó a mano.
 */
export async function ensureClinicAdminRole(clinicId: string) {
  const existing = await prisma.role.findFirst({
    where: { clinicId, name: "Admin de clínica" },
    include: { permissions: true },
  });
  if (existing) {
    // Un permiso que pasó a ser solo de la plataforma (`PLATFORM_ONLY_PERMISSIONS`) se le saca al rol de
    // la clínica: agregar los que faltan no alcanza, los que sobran se quedaban para siempre.
    const sobrantes = existing.permissions.filter((p) => PLATFORM_ONLY_PERMISSIONS.includes(p.permissionId as never));
    if (sobrantes.length > 0) {
      await prisma.rolePermission.deleteMany({
        where: { roleId: existing.id, permissionId: { in: sobrantes.map((p) => p.permissionId) } },
      });
    }
    const actuales = new Set(existing.permissions.map((p) => p.permissionId));
    const faltantes = CLINIC_ADMIN_PERMISSION_IDS.filter((id) => !actuales.has(id));
    if (faltantes.length > 0) {
      await prisma.rolePermission.createMany({
        data: faltantes.map((permissionId) => ({ roleId: existing.id, permissionId })),
        skipDuplicates: true,
      });
    }
    return existing;
  }

  return prisma.role.create({
    data: {
      clinicId,
      name: "Admin de clínica",
      description: "Acceso completo a la gestión de esta clínica.",
      isSystem: true,
      permissions: { create: CLINIC_ADMIN_PERMISSION_IDS.map((permissionId) => ({ permissionId })) },
    },
  });
}

/** No borra roles `isSystem`. Devuelve false si el rol no existe, es de otra clínica, o es de sistema. */
export async function deleteRoleInClinic(id: string, clinicId: string | null): Promise<boolean> {
  const { count } = await prisma.role.deleteMany({ where: { id, clinicId, isSystem: false } });
  return count > 0;
}
