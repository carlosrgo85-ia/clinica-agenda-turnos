import type { Prisma } from "@prisma/client";
import type { BillingPeriod } from "@prisma/client";

/**
 * La grilla de precios de lista de un plan: un país por fila, una columna por
 * periodicidad.
 *
 * Es presentación pura, sin base. Lo único que decide de verdad es qué países
 * se listan y cómo se dice "no hay precio": una celda vacía es `null`
 * explícito y NO un cero, porque cero es un precio válido (gratis) y confundir
 * los dos es exactamente el error que este módulo viene a evitar.
 */

export interface PriceCell {
  amount: string;
  updatedAt: string;
}

export interface PriceRow {
  countryId: string;
  countryName: string;
  currency: string;
  countryActive: boolean;
  /** Clínicas de ese país que ya están en este plan. */
  clinicas: number;
  mensual: PriceCell | null;
  anual: PriceCell | null;
}

interface CountryInput {
  id: string;
  name: string;
  currency: string;
  active: boolean;
}

interface PriceInput {
  countryId: string;
  billingPeriod: BillingPeriod;
  amount: Prisma.Decimal;
  updatedAt: Date;
}

/**
 * Se listan **los países activos, más los inactivos que ya tengan un precio
 * cargado**. Lo segundo es para que un precio no desaparezca de la pantalla
 * sin explicación cuando alguien desactiva un país — mismo criterio que la
 * lista de títulos habilitados de una clínica.
 */
export function buildPriceGrid(params: {
  countries: CountryInput[];
  prices: PriceInput[];
  /** Cuántas clínicas del plan hay por país. */
  clinicasPorPais: Map<string, number>;
}): PriceRow[] {
  const { countries, prices, clinicasPorPais } = params;
  const conPrecio = new Set(prices.map((p) => p.countryId));

  const celda = (countryId: string, billingPeriod: BillingPeriod): PriceCell | null => {
    const precio = prices.find((p) => p.countryId === countryId && p.billingPeriod === billingPeriod);
    return precio
      ? { amount: precio.amount.toFixed(2), updatedAt: precio.updatedAt.toISOString() }
      : null;
  };

  return countries
    .filter((c) => c.active || conPrecio.has(c.id))
    .map((c) => ({
      countryId: c.id,
      countryName: c.name,
      currency: c.currency,
      countryActive: c.active,
      clinicas: clinicasPorPais.get(c.id) ?? 0,
      mensual: celda(c.id, "mensual"),
      anual: celda(c.id, "anual"),
    }));
}

/** Cuántas celdas de la grilla tienen precio, para el resumen de la tabla de planes. */
export function contarPreciosCargados(rows: PriceRow[]): { cargados: number; paises: number } {
  return {
    cargados: rows.filter((r) => r.mensual || r.anual).length,
    paises: rows.length,
  };
}
