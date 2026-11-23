import { Prisma } from "@prisma/client";
import type { BillingPeriod, MembershipPricing } from "@prisma/client";

/**
 * Qué le cobra la plataforma a una clínica.
 *
 * Tres ideas sostienen todo lo demás:
 *
 * 1. **El precio de lista se copia, no se lee.** Al fijarle la membresía a una
 *    clínica se guarda el monto en la clínica; a partir de ahí son
 *    independientes. Por eso cambiar la lista no mueve a nadie que ya esté, y
 *    no hace falta ningún job que se acuerde de no tocarlos.
 * 2. **"Exonerada" no es un costo en cero.** Es un estado propio, distinto de
 *    "todavía no le pusimos precio". Antes las dos cosas eran `null` y no se
 *    podían distinguir — mismo problema que `SIN_HORARIO` y `SIN_SEGUROS`.
 * 3. **Exonerar no toca el plan.** Una clínica exonerada conserva sus
 *    funcionalidades: los jobs filtran por `clinic.plan?.features`, así que
 *    sacarle el plan le apagaría los recordatorios de 2hs y el seguimiento
 *    post-visita.
 *
 * Todo lo de este archivo es puro: no toca la base ni la red.
 */

/** Por qué no hay un precio de lista con el que comparar. */
export type ListPriceStatus =
  | "ok"
  | "sin_plan"
  | "sin_pais"
  | "sin_periodicidad"
  | "no_cargado";

export interface MembershipSnapshot {
  pricing: MembershipPricing | null;
  amount: Prisma.Decimal | null;
  currency: string | null;
  billingPeriod: BillingPeriod | null;
  reason: string | null;
  pricedAt: Date | null;
}

export interface ListPrice {
  amount: Prisma.Decimal;
  currency: string;
  updatedAt: Date;
}

export type Comparacion =
  | { estado: "sin_referencia" }
  | { estado: "igual" }
  | { estado: "por_debajo" | "por_encima"; diffAmount: string; diffPercent: number };

/**
 * El monto que llega por la API.
 *
 * Llega como string y no como number a propósito: `Decimal` serializa a string
 * en JSON, y parsear desde un float ya habría perdido precisión antes de
 * llegar acá. Se rechaza el cero: un precio de cero es una exoneración, y esa
 * se expresa con `pricing: "exonerada"` y su motivo, no con un número.
 */
export function parseAmount(
  value: unknown
): { ok: true; amount: Prisma.Decimal } | { ok: false; error: string } {
  if (typeof value !== "string" && typeof value !== "number") {
    return { ok: false, error: "El monto tiene que venir como número o como texto." };
  }

  const texto = String(value).trim();
  // Se valida con regex ANTES de construir el Decimal: `new Decimal("1e5")` y
  // `new Decimal("Infinity")` son válidos para decimal.js y no son montos.
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(texto)) {
    return {
      ok: false,
      error: "El monto tiene que ser un número positivo con hasta dos decimales.",
    };
  }

  const amount = new Prisma.Decimal(texto);
  if (amount.lessThanOrEqualTo(0)) {
    return {
      ok: false,
      error: "El monto tiene que ser mayor a cero. Para no cobrarle, usa 'exonerada'.",
    };
  }
  return { ok: true, amount };
}

export type MembershipInput =
  /**
   * Sin precio configurado. **El plan viaja igual**, porque "tiene plan y
   * todavía no le pusimos precio" es el estado en el que nace toda clínica
   * (`POST /platform/clinics` la crea en "Base") y tiene que poder volver a
   * expresarse: si el único `pricing: null` posible borrara el plan, la
   * pantalla no podría reproducir el estado inicial y sacarle el precio a una
   * clínica le apagaría de paso las funcionalidades que paga.
   * `planId` ausente o en `null` es el otro caso: ni plan ni precio.
   */
  | { pricing: null; planId?: string | null }
  | { pricing: "lista"; planId: string; billingPeriod: BillingPeriod }
  | {
      pricing: "especial";
      planId: string;
      billingPeriod: BillingPeriod;
      amount: Prisma.Decimal;
      reason: string;
    }
  | { pricing: "exonerada"; planId: string; reason: string };

function esPeriodo(v: unknown): v is BillingPeriod {
  return v === "mensual" || v === "anual";
}

function textoNoVacio(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Valida el body del PUT de membresía.
 *
 * `lista` NO acepta monto: el backend lo copia de la grilla. Si el cliente
 * pudiera mandarlo, dejaría de ser "el precio de lista" y quedarían dos
 * fuentes para el mismo número.
 */
export function parseMembershipInput(
  body: unknown
): { ok: true; input: MembershipInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const { pricing } = b;

  if (pricing === null || pricing === undefined) {
    if (b.planId !== undefined && b.planId !== null && typeof b.planId !== "string") {
      return { ok: false, error: "`planId` tiene que ser un string o null." };
    }
    // Sin `planId` en el body se entiende "sacale todo", que es lo que hacía
    // esta rama cuando era el único `pricing: null` posible.
    return { ok: true, input: { pricing: null, planId: textoNoVacio(b.planId) } };
  }

  if (pricing !== "lista" && pricing !== "especial" && pricing !== "exonerada") {
    return { ok: false, error: '`pricing` tiene que ser "lista", "especial", "exonerada" o null.' };
  }

  const planId = textoNoVacio(b.planId);
  if (!planId) {
    return { ok: false, error: "Hace falta el plan: una membresía siempre es de un plan." };
  }

  if (pricing === "exonerada") {
    const reason = textoNoVacio(b.reason);
    if (!reason) {
      return {
        ok: false,
        error:
          "Hace falta el motivo de la exoneración: sin él es indistinguible de un error de carga.",
      };
    }
    return { ok: true, input: { pricing, planId, reason } };
  }

  if (!esPeriodo(b.billingPeriod)) {
    return { ok: false, error: '`billingPeriod` tiene que ser "mensual" o "anual".' };
  }

  if (pricing === "lista") {
    return { ok: true, input: { pricing, planId, billingPeriod: b.billingPeriod } };
  }

  const reason = textoNoVacio(b.reason);
  if (!reason) {
    return {
      ok: false,
      error:
        "Hace falta el motivo del precio especial: un precio distinto al de lista sin explicación " +
        "es indistinguible de un error de tipeo.",
    };
  }

  const amount = parseAmount(b.amount);
  if (!amount.ok) return amount;

  return {
    ok: true,
    input: { pricing, planId, billingPeriod: b.billingPeriod, amount: amount.amount, reason },
  };
}

/** Cuánto se aparta lo que paga la clínica del precio de lista de hoy. */
export function compareToListPrice(
  acordado: Prisma.Decimal | null,
  lista: Prisma.Decimal | null
): Comparacion {
  if (!acordado || !lista) return { estado: "sin_referencia" };
  if (acordado.equals(lista)) return { estado: "igual" };

  const diff = acordado.minus(lista);
  return {
    estado: diff.isNegative() ? "por_debajo" : "por_encima",
    diffAmount: diff.toFixed(2),
    // Solo para mostrar: el redondeo acá no afecta a ningún monto guardado.
    diffPercent: Number(diff.dividedBy(lista).times(100).toFixed(1)),
  };
}

export interface MembershipView {
  /**
   * El plan es parte de la membresía y no un campo suelto de la clínica: se
   * devuelve acá para que la tarjeta se refresque con una sola llamada después
   * de guardar, sin quedar mostrando el plan viejo del detalle.
   */
  planId: string | null;
  pricing: MembershipPricing | null;
  amount: string | null;
  currency: string | null;
  billingPeriod: BillingPeriod | null;
  reason: string | null;
  pricedAt: string | null;
  listPrice: { amount: string; currency: string; updatedAt: string } | null;
  listPriceStatus: ListPriceStatus;
  comparacion: Comparacion;
  /** El precio de lista se tocó después de fijarle el suyo a esta clínica. */
  listaCambiadaDespues: boolean;
  /** La moneda congelada dejó de coincidir con la del país de la clínica. */
  currencyMismatch: { membresia: string; pais: string } | null;
}

/**
 * Lo que devuelve el GET de membresía, listo para pintar.
 *
 * `listPriceStatus` existe para no devolver nunca un null mudo: la pantalla
 * tiene que poder decir POR QUÉ no hay referencia (falta el plan, falta el
 * país, falta la periodicidad, o nadie cargó ese precio), que es la diferencia
 * entre una pantalla que explica y una que deja al admin adivinando.
 */
export function buildMembershipView(params: {
  membership: MembershipSnapshot;
  planId: string | null;
  countryId: string | null;
  countryCurrency: string | null;
  listPrice: ListPrice | null;
}): MembershipView {
  const { membership, planId, countryId, countryCurrency, listPrice } = params;

  const periodo = membership.billingPeriod;
  const listPriceStatus: ListPriceStatus = !planId
    ? "sin_plan"
    : !countryId
      ? "sin_pais"
      : !periodo
        ? "sin_periodicidad"
        : listPrice
          ? "ok"
          : "no_cargado";

  return {
    planId,
    pricing: membership.pricing,
    amount: membership.amount?.toFixed(2) ?? null,
    currency: membership.currency,
    billingPeriod: periodo,
    reason: membership.reason,
    pricedAt: membership.pricedAt?.toISOString() ?? null,
    listPrice: listPrice
      ? {
          amount: listPrice.amount.toFixed(2),
          currency: listPrice.currency,
          updatedAt: listPrice.updatedAt.toISOString(),
        }
      : null,
    listPriceStatus,
    comparacion: compareToListPrice(membership.amount, listPrice?.amount ?? null),
    listaCambiadaDespues: Boolean(
      listPrice && membership.pricedAt && membership.pricedAt < listPrice.updatedAt
    ),
    currencyMismatch:
      membership.currency && countryCurrency && membership.currency !== countryCurrency
        ? { membresia: membership.currency, pais: countryCurrency }
        : null,
  };
}
