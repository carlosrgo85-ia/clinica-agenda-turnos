import { prisma } from "../db/client";

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hora, para invitación y recuperación por igual

/**
 * Invalida cualquier token anterior sin usar del usuario y crea uno nuevo.
 * Evita que queden varios links de invitación/reset vivos al mismo tiempo.
 */
export async function createPasswordResetToken(userId: string, tokenHash: string) {
  await prisma.passwordResetToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });

  return prisma.passwordResetToken.create({
    data: { userId, tokenHash, expiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
  });
}

/** Devuelve el token con su usuario si es válido (existe, no venció, no se usó). */
export async function findValidResetToken(tokenHash: string) {
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  if (!record || record.usedAt || record.expiresAt < new Date()) return null;
  return record;
}

export function markResetTokenUsed(id: string) {
  return prisma.passwordResetToken.update({ where: { id }, data: { usedAt: new Date() } });
}
