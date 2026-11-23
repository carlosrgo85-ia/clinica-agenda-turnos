import { prisma } from "../db/client";

export function listPlans() {
  return prisma.plan.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { clinics: true } } },
  });
}

export function findPlan(id: string) {
  return prisma.plan.findUnique({ where: { id } });
}

/** Para asignarle el plan "Base" a una clínica nueva que no eligió uno explícito. */
export function findPlanByName(name: string) {
  return prisma.plan.findUnique({ where: { name } });
}

export function createPlan(params: { name: string; description?: string | null; features: string[] }) {
  return prisma.plan.create({
    data: { name: params.name, description: params.description ?? null, features: params.features },
  });
}

export async function updatePlan(
  id: string,
  data: { name?: string; description?: string | null; features?: string[] }
): Promise<boolean> {
  const { count } = await prisma.plan.updateMany({ where: { id }, data });
  return count > 0;
}

/**
 * No borra planes `isSystem` ni planes con clínicas asignadas — en ese
 * caso esas clínicas se quedarían sin funcionalidades definidas de un
 * momento a otro. Devuelve un motivo específico para que la interfaz lo
 * explique en vez de un 404 genérico.
 */
export async function deletePlan(
  id: string
): Promise<{ ok: true } | { ok: false; reason: "no_encontrado" | "es_de_sistema" | "tiene_clinicas" }> {
  const plan = await prisma.plan.findUnique({ where: { id }, include: { _count: { select: { clinics: true } } } });
  if (!plan) return { ok: false, reason: "no_encontrado" };
  if (plan.isSystem) return { ok: false, reason: "es_de_sistema" };
  if (plan._count.clinics > 0) return { ok: false, reason: "tiene_clinicas" };

  await prisma.plan.delete({ where: { id } });
  return { ok: true };
}
