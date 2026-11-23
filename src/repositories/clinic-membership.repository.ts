import type { BillingPeriod, MembershipPricing, Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { buildMembershipView, type MembershipInput, type MembershipView } from "../services/membership";
import { findPlanPrice } from "./plan-prices.repository";

/**
 * Qué le cobra la plataforma a una clínica.
 *
 * Dos reglas gobiernan todo:
 *
 * - **El precio de lista se COPIA, no se referencia.** `pricing: "lista"` lee
 *   `PlanPrice` una sola vez, en el momento de fijarlo, y guarda el número en
 *   la clínica. Por eso un aumento en la lista no mueve a nadie que ya esté.
 * - **Exonerar no toca `planId`.** Los jobs filtran por
 *   `clinic.plan?.features`, así que sacarle el plan a una clínica exonerada
 *   le apagaría los recordatorios de 2hs y el seguimiento post-visita. Se le
 *   deja de cobrar; sigue teniendo todo.
 *
 * Las invariantes devuelven un motivo en vez de tirar una excepción — mismo
 * patrón que `deletePlan` y `updateTitle`.
 */

export type MembershipFailure =
  | "clinica_no_encontrada"
  | "plan_no_encontrado"
  | "sin_pais"
  | "pais_no_encontrado"
  | "sin_precio_de_lista";

export async function getClinicMembership(clinicId: string): Promise<MembershipView | null> {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: {
      planId: true,
      country: true,
      membershipPricing: true,
      membershipCost: true,
      membershipCurrency: true,
      membershipBillingPeriod: true,
      membershipReason: true,
      membershipPricedAt: true,
    },
  });
  if (!clinic) return null;

  const country = clinic.country
    ? await prisma.country.findUnique({
        where: { id: clinic.country },
        select: { currency: true },
      })
    : null;

  // El precio de lista con el que se compara es el de HOY, para la
  // periodicidad que la clínica tiene pactada. Es solo referencia: no entra en
  // ningún cálculo de lo que paga.
  const listPrice =
    clinic.planId && clinic.country && clinic.membershipBillingPeriod
      ? await findPlanPrice({
          planId: clinic.planId,
          countryId: clinic.country,
          billingPeriod: clinic.membershipBillingPeriod,
        })
      : null;

  return buildMembershipView({
    membership: {
      pricing: clinic.membershipPricing,
      amount: clinic.membershipCost,
      currency: clinic.membershipCurrency,
      billingPeriod: clinic.membershipBillingPeriod,
      reason: clinic.membershipReason,
      pricedAt: clinic.membershipPricedAt,
    },
    planId: clinic.planId,
    countryId: clinic.country,
    countryCurrency: country?.currency ?? null,
    listPrice: listPrice
      ? { amount: listPrice.amount, currency: country?.currency ?? "", updatedAt: listPrice.updatedAt }
      : null,
  });
}

export async function setClinicMembership(params: {
  clinicId: string;
  input: MembershipInput;
  changedById: string | null;
}): Promise<{ ok: true } | { ok: false; reason: MembershipFailure }> {
  const { clinicId, input, changedById } = params;

  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: {
      country: true,
      membershipPricing: true,
      membershipCost: true,
      membershipCurrency: true,
      membershipBillingPeriod: true,
    },
  });
  if (!clinic) return { ok: false, reason: "clinica_no_encontrada" };

  const anterior = {
    pricing: clinic.membershipPricing,
    amount: clinic.membershipCost,
    period: clinic.membershipBillingPeriod,
    currency: clinic.membershipCurrency,
  };

  /** Lo que se va a escribir en la clínica. */
  let data: {
    planId: string | null;
    membershipPricing: MembershipPricing | null;
    membershipCost: Prisma.Decimal | null;
    membershipCurrency: string | null;
    membershipBillingPeriod: BillingPeriod | null;
    membershipReason: string | null;
    membershipPricedAt: Date | null;
  };

  if (input.pricing === null) {
    // El plan se conserva si vino en el body: "plan asignado, precio sin
    // definir" es un estado real (toda clínica nace ahí) y sacarle el precio
    // no puede apagarle de paso las funcionalidades que tiene contratadas.
    if (input.planId) {
      const plan = await prisma.plan.findUnique({ where: { id: input.planId }, select: { id: true } });
      if (!plan) return { ok: false, reason: "plan_no_encontrado" };
    }
    data = {
      planId: input.planId ?? null,
      membershipPricing: null,
      membershipCost: null,
      membershipCurrency: null,
      membershipBillingPeriod: null,
      membershipReason: null,
      membershipPricedAt: null,
    };
  } else {
    const plan = await prisma.plan.findUnique({ where: { id: input.planId }, select: { id: true } });
    if (!plan) return { ok: false, reason: "plan_no_encontrado" };

    if (input.pricing === "exonerada") {
      // No se toca el país ni se pide moneda: no hay monto que expresar. Y el
      // plan se conserva, que es el punto de toda la modalidad.
      data = {
        planId: input.planId,
        membershipPricing: "exonerada",
        membershipCost: null,
        membershipCurrency: null,
        membershipBillingPeriod: null,
        membershipReason: input.reason,
        membershipPricedAt: new Date(),
      };
    } else {
      // Lista y especial necesitan moneda, y la moneda sale del país.
      if (!clinic.country) return { ok: false, reason: "sin_pais" };
      const country = await prisma.country.findUnique({
        where: { id: clinic.country },
        select: { currency: true },
      });
      if (!country) return { ok: false, reason: "pais_no_encontrado" };

      if (input.pricing === "lista") {
        const listPrice = await findPlanPrice({
          planId: input.planId,
          countryId: clinic.country,
          billingPeriod: input.billingPeriod,
        });
        if (!listPrice) return { ok: false, reason: "sin_precio_de_lista" };

        // Acá está la copia: a partir de ahora el monto es de la clínica y
        // cambiar la lista no la mueve.
        data = {
          planId: input.planId,
          membershipPricing: "lista",
          membershipCost: listPrice.amount,
          membershipCurrency: country.currency,
          membershipBillingPeriod: input.billingPeriod,
          membershipReason: null,
          membershipPricedAt: new Date(),
        };
      } else {
        data = {
          planId: input.planId,
          membershipPricing: "especial",
          membershipCost: input.amount,
          membershipCurrency: country.currency,
          membershipBillingPeriod: input.billingPeriod,
          membershipReason: input.reason,
          membershipPricedAt: new Date(),
        };
      }
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.clinic.update({ where: { id: clinicId }, data });
    await tx.membershipPriceChange.create({
      data: {
        scope: "clinica",
        clinicId,
        fromPricing: anterior.pricing,
        toPricing: data.membershipPricing,
        fromAmount: anterior.amount,
        toAmount: data.membershipCost,
        fromPeriod: anterior.period,
        toPeriod: data.membershipBillingPeriod,
        currency: data.membershipCurrency ?? anterior.currency,
        reason: data.membershipReason,
        changedById,
      },
    });
  });

  return { ok: true };
}

/** El historial de una clínica, del cambio más nuevo al más viejo. */
export function listMembershipChanges(clinicId: string, take = 20) {
  return prisma.membershipPriceChange.findMany({
    where: { scope: "clinica", clinicId },
    orderBy: { changedAt: "desc" },
    take,
    include: { changedBy: { select: { name: true, email: true } } },
  });
}
