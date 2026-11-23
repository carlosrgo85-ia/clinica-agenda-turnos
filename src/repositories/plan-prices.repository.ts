import { Prisma } from "@prisma/client";
import type { BillingPeriod } from "@prisma/client";
import { prisma } from "../db/client";

/**
 * Los precios de lista de un plan, por país y periodicidad.
 *
 * **Editar la lista NUNCA toca a una clínica.** Cada clínica tiene su precio
 * copiado en `Clinic.membershipCost`, así que un aumento acá solo cambia lo
 * que se le va a ofrecer a las clínicas nuevas. Es lo que hace que no se le
 * pise el precio a alguien con quien se negoció, y por eso ninguna función de
 * este archivo escribe en `Clinic`.
 *
 * Las invariantes devuelven un motivo en vez de tirar una excepción — mismo
 * patrón que `deletePlan` y `updateTitle`.
 */

export function listPlanPrices(planId: string) {
  return prisma.planPrice.findMany({
    where: { planId },
    orderBy: [{ countryId: "asc" }, { billingPeriod: "asc" }],
  });
}

export function findPlanPrice(params: {
  planId: string;
  countryId: string;
  billingPeriod: BillingPeriod;
}) {
  return prisma.planPrice.findUnique({
    where: {
      planId_countryId_billingPeriod: {
        planId: params.planId,
        countryId: params.countryId,
        billingPeriod: params.billingPeriod,
      },
    },
  });
}

/** Cuántas clínicas de cada país están en este plan, para la grilla. */
export async function countClinicsByCountry(planId: string): Promise<Map<string, number>> {
  const filas = await prisma.clinic.groupBy({
    by: ["country"],
    where: { planId, country: { not: null } },
    _count: { _all: true },
  });
  return new Map(filas.map((f) => [f.country as string, f._count._all]));
}

export async function upsertPlanPrice(params: {
  planId: string;
  countryId: string;
  billingPeriod: BillingPeriod;
  amount: Prisma.Decimal;
  changedById: string | null;
}): Promise<
  | { ok: true }
  | { ok: false; reason: "plan_no_encontrado" | "pais_no_encontrado" | "pais_inactivo" }
> {
  const [plan, country] = await Promise.all([
    prisma.plan.findUnique({ where: { id: params.planId }, select: { id: true } }),
    prisma.country.findUnique({ where: { id: params.countryId }, select: { active: true } }),
  ]);
  if (!plan) return { ok: false, reason: "plan_no_encontrado" };
  if (!country) return { ok: false, reason: "pais_no_encontrado" };

  const anterior = await findPlanPrice(params);
  // Un país desactivado se puede corregir si ya tenía precio, pero no estrenar
  // uno: cargarle precio a un país que nadie puede elegir es trabajo perdido.
  if (!country.active && !anterior) return { ok: false, reason: "pais_inactivo" };

  await prisma.$transaction(async (tx) => {
    const price = await tx.planPrice.upsert({
      where: {
        planId_countryId_billingPeriod: {
          planId: params.planId,
          countryId: params.countryId,
          billingPeriod: params.billingPeriod,
        },
      },
      update: { amount: params.amount },
      create: {
        planId: params.planId,
        countryId: params.countryId,
        billingPeriod: params.billingPeriod,
        amount: params.amount,
      },
    });

    await tx.membershipPriceChange.create({
      data: {
        scope: "lista",
        planPriceId: price.id,
        fromAmount: anterior?.amount ?? null,
        toAmount: params.amount,
        fromPeriod: anterior ? params.billingPeriod : null,
        toPeriod: params.billingPeriod,
        changedById: params.changedById,
      },
    });
  });

  return { ok: true };
}

/**
 * Borra una celda de la grilla.
 *
 * **No se bloquea aunque haya clínicas en ese plan y país**: el precio que
 * pagan ya está copiado en cada una, así que borrar la lista no les cambia
 * nada — lo único que se pierde es la referencia contra la que compararlas.
 * Se devuelve cuántas quedan sin referencia para poder decirlo en pantalla.
 */
export async function deletePlanPrice(params: {
  planId: string;
  countryId: string;
  billingPeriod: BillingPeriod;
  changedById: string | null;
}): Promise<{ ok: true; clinicasSinReferencia: number } | { ok: false; reason: "no_encontrado" }> {
  const anterior = await findPlanPrice(params);
  if (!anterior) return { ok: false, reason: "no_encontrado" };

  const clinicasSinReferencia = await prisma.clinic.count({
    where: {
      planId: params.planId,
      country: params.countryId,
      membershipBillingPeriod: params.billingPeriod,
      membershipPricing: { not: null },
    },
  });

  await prisma.$transaction(async (tx) => {
    await tx.planPrice.delete({ where: { id: anterior.id } });
    await tx.membershipPriceChange.create({
      data: {
        scope: "lista",
        planPriceId: anterior.id,
        fromAmount: anterior.amount,
        toAmount: null,
        fromPeriod: params.billingPeriod,
        changedById: params.changedById,
      },
    });
  });

  return { ok: true, clinicasSinReferencia };
}

/** Cuántas celdas con precio tiene cada plan, para la tabla de planes. */
export async function countPricesByPlan(): Promise<Map<string, number>> {
  const filas = await prisma.planPrice.groupBy({
    by: ["planId"],
    _count: { _all: true },
  });
  return new Map(filas.map((f) => [f.planId, f._count._all]));
}
