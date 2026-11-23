import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  buildMembershipView,
  compareToListPrice,
  parseAmount,
  parseMembershipInput,
} from "../src/services/membership";
import { buildPriceGrid, contarPreciosCargados } from "../src/services/plan-prices";

/**
 * La lógica pura de precios de membresía. Sin base ni red.
 *
 * Lo que se protege acá es que un monto mal formado no llegue nunca a la
 * columna, y que la pantalla siempre pueda explicar POR QUÉ no hay un precio
 * de lista con el que comparar, en vez de mostrar un guion.
 */

const dec = (n: string) => new Prisma.Decimal(n);

describe("parseAmount", () => {
  it("acepta enteros y dos decimales", () => {
    expect(parseAmount("15000")).toEqual({ ok: true, amount: dec("15000") });
    expect(parseAmount("15000.50")).toEqual({ ok: true, amount: dec("15000.50") });
    expect(parseAmount(15000)).toEqual({ ok: true, amount: dec("15000") });
  });

  it("rechaza negativos, que hoy la API acepta", () => {
    // `typeof === "number"` dejaba pasar -5000 contra una columna INTEGER.
    expect(parseAmount("-5000").ok).toBe(false);
    expect(parseAmount(-5000).ok).toBe(false);
  });

  it("rechaza más de dos decimales", () => {
    expect(parseAmount("1500.755").ok).toBe(false);
  });

  it("rechaza cero: no cobrar es una exoneración, no un precio", () => {
    const result = parseAmount("0");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("exonerada");
  });

  it("rechaza lo que decimal.js aceptaría pero no es un monto", () => {
    // `new Decimal("1e5")` y `new Decimal("Infinity")` son válidos para
    // decimal.js: por eso se valida con regex ANTES de construirlo.
    for (const raro of ["1e5", "Infinity", "NaN", "  ", "abc", "1,50"]) {
      expect(parseAmount(raro).ok).toBe(false);
    }
  });
});

describe("parseMembershipInput", () => {
  it("'lista' no acepta monto: lo copia el backend", () => {
    const result = parseMembershipInput({
      pricing: "lista",
      planId: "p1",
      billingPeriod: "mensual",
      amount: "999",
    });

    expect(result).toEqual({
      ok: true,
      input: { pricing: "lista", planId: "p1", billingPeriod: "mensual" },
    });
  });

  it("'especial' exige monto y motivo", () => {
    expect(
      parseMembershipInput({ pricing: "especial", planId: "p1", billingPeriod: "mensual", amount: "100" }).ok
    ).toBe(false);

    const ok = parseMembershipInput({
      pricing: "especial",
      planId: "p1",
      billingPeriod: "mensual",
      amount: "12000.50",
      reason: "Colaboración",
    });
    expect(ok.ok).toBe(true);
  });

  it("'exonerada' exige motivo y no pide periodicidad ni monto", () => {
    const sinMotivo = parseMembershipInput({ pricing: "exonerada", planId: "p1" });
    expect(sinMotivo.ok).toBe(false);
    if (!sinMotivo.ok) expect(sinMotivo.error).toContain("motivo");

    expect(parseMembershipInput({ pricing: "exonerada", planId: "p1", reason: "Convenio" })).toEqual({
      ok: true,
      input: { pricing: "exonerada", planId: "p1", reason: "Convenio" },
    });
  });

  it("un motivo en blanco no cuenta como motivo", () => {
    expect(parseMembershipInput({ pricing: "exonerada", planId: "p1", reason: "   " }).ok).toBe(false);
  });

  it("null vuelve a 'sin configurar' y, sin plan en el body, saca también el plan", () => {
    expect(parseMembershipInput({ pricing: null })).toEqual({
      ok: true,
      input: { pricing: null, planId: null },
    });
  });

  it("null con plan es 'tiene plan, todavía sin precio' — el estado en que nace una clínica", () => {
    expect(parseMembershipInput({ pricing: null, planId: "p1" })).toEqual({
      ok: true,
      input: { pricing: null, planId: "p1" },
    });
    expect(parseMembershipInput({ pricing: null, planId: 7 }).ok).toBe(false);
  });

  it("cualquier modalidad que no sea null exige plan", () => {
    expect(parseMembershipInput({ pricing: "lista", billingPeriod: "mensual" }).ok).toBe(false);
  });
});

describe("compareToListPrice", () => {
  it("dice cuánto y qué porcentaje por debajo", () => {
    expect(compareToListPrice(dec("15000"), dec("18000"))).toEqual({
      estado: "por_debajo",
      diffAmount: "-3000.00",
      diffPercent: -16.7,
    });
  });

  it("sin precio de lista no inventa una comparación", () => {
    expect(compareToListPrice(dec("15000"), null)).toEqual({ estado: "sin_referencia" });
    expect(compareToListPrice(null, dec("18000"))).toEqual({ estado: "sin_referencia" });
  });

  it("igual es igual, no 0%", () => {
    expect(compareToListPrice(dec("18000"), dec("18000.00"))).toEqual({ estado: "igual" });
  });
});

describe("buildMembershipView", () => {
  const base = {
    membership: {
      pricing: "especial" as const,
      amount: dec("15000"),
      currency: "ARS",
      billingPeriod: "mensual" as const,
      reason: "Colaboración",
      pricedAt: new Date("2026-03-01T00:00:00Z"),
    },
    planId: "p1",
    countryId: "AR",
    countryCurrency: "ARS",
    listPrice: {
      amount: dec("18000"),
      currency: "ARS",
      updatedAt: new Date("2026-09-12T00:00:00Z"),
    },
  };

  it("explica POR QUÉ no hay precio de lista, en vez de devolver null a secas", () => {
    // Es la diferencia entre una pantalla que explica y uno adivinando.
    expect(buildMembershipView({ ...base, planId: null, listPrice: null }).listPriceStatus).toBe("sin_plan");
    expect(buildMembershipView({ ...base, countryId: null, listPrice: null }).listPriceStatus).toBe("sin_pais");
    expect(buildMembershipView({ ...base, listPrice: null }).listPriceStatus).toBe("no_cargado");
    expect(
      buildMembershipView({
        ...base,
        membership: { ...base.membership, billingPeriod: null },
        listPrice: null,
      }).listPriceStatus
    ).toBe("sin_periodicidad");
    expect(buildMembershipView(base).listPriceStatus).toBe("ok");
  });

  it("avisa cuando la lista cambió después de fijarle el precio a la clínica", () => {
    expect(buildMembershipView(base).listaCambiadaDespues).toBe(true);

    const fijadoDespues = buildMembershipView({
      ...base,
      membership: { ...base.membership, pricedAt: new Date("2026-10-01T00:00:00Z") },
    });
    expect(fijadoDespues.listaCambiadaDespues).toBe(false);
  });

  it("avisa si la moneda congelada dejó de coincidir con la del país", () => {
    // Pasa si alguien le cambia el país a la clínica: el monto sigue pactado
    // en la moneda vieja y reinterpretarlo sería mentir.
    expect(buildMembershipView({ ...base, countryCurrency: "MXN" }).currencyMismatch).toEqual({
      membresia: "ARS",
      pais: "MXN",
    });
    expect(buildMembershipView(base).currencyMismatch).toBe(null);
  });

  it("los montos salen como string con dos decimales", () => {
    const view = buildMembershipView(base);
    expect(view.amount).toBe("15000.00");
    expect(view.listPrice?.amount).toBe("18000.00");
  });

  it("una exonerada no tiene monto pero sí motivo", () => {
    const view = buildMembershipView({
      ...base,
      membership: {
        pricing: "exonerada",
        amount: null,
        currency: null,
        billingPeriod: null,
        reason: "Convenio de colaboración",
        pricedAt: new Date("2026-03-01T00:00:00Z"),
      },
      listPrice: null,
    });

    expect(view.amount).toBe(null);
    expect(view.reason).toBe("Convenio de colaboración");
    expect(view.comparacion).toEqual({ estado: "sin_referencia" });
  });
});

describe("buildPriceGrid", () => {
  const countries = [
    { id: "AR", name: "Argentina", currency: "ARS", active: true },
    { id: "MX", name: "México", currency: "MXN", active: true },
    { id: "VE", name: "Venezuela", currency: "VES", active: false },
  ];

  it("una celda sin precio es null, no cero", () => {
    // Cero es un precio válido (gratis); confundirlos es el error que este
    // módulo viene a evitar.
    const grid = buildPriceGrid({
      countries,
      prices: [
        { countryId: "AR", billingPeriod: "mensual", amount: dec("18000"), updatedAt: new Date() },
      ],
      clinicasPorPais: new Map([["AR", 7]]),
    });

    const ar = grid.find((r) => r.countryId === "AR");
    expect(ar?.mensual).toEqual({ amount: "18000.00", updatedAt: expect.any(String) });
    expect(ar?.anual).toBe(null);
    expect(ar?.clinicas).toBe(7);
  });

  it("un país inactivo se oculta, salvo que ya tenga un precio cargado", () => {
    const sinPrecio = buildPriceGrid({ countries, prices: [], clinicasPorPais: new Map() });
    expect(sinPrecio.map((r) => r.countryId)).toEqual(["AR", "MX"]);

    const conPrecio = buildPriceGrid({
      countries,
      prices: [
        { countryId: "VE", billingPeriod: "anual", amount: dec("100"), updatedAt: new Date() },
      ],
      clinicasPorPais: new Map(),
    });
    expect(conPrecio.map((r) => r.countryId)).toEqual(["AR", "MX", "VE"]);
    expect(conPrecio.find((r) => r.countryId === "VE")?.countryActive).toBe(false);
  });

  it("cuenta cuántos países tienen algún precio", () => {
    const grid = buildPriceGrid({
      countries,
      prices: [
        { countryId: "AR", billingPeriod: "mensual", amount: dec("18000"), updatedAt: new Date() },
      ],
      clinicasPorPais: new Map(),
    });
    expect(contarPreciosCargados(grid)).toEqual({ cargados: 1, paises: 2 });
  });
});
