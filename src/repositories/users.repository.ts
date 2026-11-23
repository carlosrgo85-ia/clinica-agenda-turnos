import { prisma } from "../db/client";

/** Selección de campos segura para devolver por API: nunca `passwordHash`. */
const SAFE_USER_SELECT = {
  id: true,
  clinicId: true,
  email: true,
  name: true,
  active: true,
  createdAt: true,
  updatedAt: true,
  roles: { select: { role: { select: { id: true, name: true } } } },
} as const;

/** Para el login: incluye passwordHash y el detalle de permisos de sus roles. */
export function findUserForLogin(email: string) {
  return prisma.user.findUnique({
    where: { email },
    include: {
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
    },
  });
}

export function findUserWithPermissionsById(id: string) {
  return prisma.user.findUnique({
    where: { id },
    include: {
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
    },
  });
}

/** Lista los usuarios de una clínica. `clinicId` null lista los de plataforma. */
export function listUsersByClinic(clinicId: string | null) {
  return prisma.user.findMany({
    where: { clinicId },
    select: SAFE_USER_SELECT,
    orderBy: { createdAt: "asc" },
  });
}

/** `null` si no existe o pertenece a otra clínica — mismo criterio que el resto del código. */
export function findUserInClinic(id: string, clinicId: string | null) {
  return prisma.user.findFirst({ where: { id, clinicId }, select: SAFE_USER_SELECT });
}

export function createUser(params: {
  clinicId: string | null;
  email: string;
  name: string;
  roleIds: string[];
}) {
  return prisma.user.create({
    data: {
      clinicId: params.clinicId,
      email: params.email,
      name: params.name,
      roles: { create: params.roleIds.map((roleId) => ({ roleId })) },
    },
    select: SAFE_USER_SELECT,
  });
}

export async function updateUserInClinic(params: {
  id: string;
  clinicId: string | null;
  name?: string;
  active?: boolean;
  roleIds?: string[];
}) {
  const { count } = await prisma.user.updateMany({
    where: { id: params.id, clinicId: params.clinicId },
    data: { name: params.name, active: params.active },
  });
  if (count === 0) return null;

  if (params.roleIds) {
    await prisma.$transaction([
      prisma.userRole.deleteMany({ where: { userId: params.id } }),
      prisma.userRole.createMany({
        data: params.roleIds.map((roleId) => ({ userId: params.id, roleId })),
      }),
    ]);
  }

  return findUserInClinic(params.id, params.clinicId);
}

export function setUserPassword(userId: string, passwordHash: string) {
  return prisma.user.update({ where: { id: userId }, data: { passwordHash } });
}
