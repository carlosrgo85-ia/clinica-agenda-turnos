import { afterEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import { PLAN_FEATURES } from "../src/config/plan-features";
import {
  getClinicMembership,
  listMembershipChanges,
  setClinicMembership,
} from "../src/repositories/clinic-membership.repository";
import { deletePlanPrice, upsertPlanPrice } from "../src/repositories/plan-prices.repository";

/**
 * La membresía de una clínica contra la base.
 *
 * Las dos reglas que más importan y que este archivo protege:
 *
 * 1. **Subir el precio de lista no mueve a las clínicas que ya estaban.** Es
 *    lo que evita pisarle el precio a alguien con quien se negoció.
 * 2. **Exonerar conserva el plan y sus funcionalidades.** Antes, la única
 *    forma de no cobrarle era sacarle el plan, y eso le apagaba los
 *    recordatorios de 2hs y el seguimiento post-visita.
 */

const clinicIds: string[] = [];
const planIds: string[] = [];
const countryIds: string[] = [];

const dec = (n: string) => new Prisma.Decimal(n);

async function crearPais(currency = "ARS") {
  const id = `T${Math.floor(Math.random() * 100000)}`;
  const country = await prisma.country.create({
    data: { id, name: `País ${id}`, currency, timezones: ["UTC"] },
  });
  countryIds.push(country.id);
  return country;
}

async function crearPlan(features: string[] = []) {
  const plan = await prisma.plan.create({
    data: { name: `Plan ${Date.now()}-${Math.random()}`, features },
  });
  planIds.push(plan.id);
  return plan;
}

async function crearClinica(params: { country?: string | null; planId?: string | null } = {}) {
  const sufijo = `${Date.now()}-${Math.random()}`;
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica membresía ${sufijo}`,
      whatsappPhoneNumberId: `membresia-${sufijo}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "membresia@example.com",
      timezone: "UTC",
      services: "Consulta",
      country: params.country ?? null,
      planId: params.planId ?? null,
    },
  });
  clinicIds.push(clinic.id);
  return clinic;
}

afterEach(async () => {
  await prisma.membershipPriceChange.deleteMany({ where: { clinicId: { in: clinicIds } } });
  for (const clinicId of clinicIds) {
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
  await prisma.planPrice.deleteMany({ where: { planId: { in: planIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
  planIds.length = 0;
  await prisma.country.deleteMany({ where: { id: { in: countryIds } } });
  countryIds.length = 0;
});

describe("precio de lista", () => {
  it("subirlo NO mueve a la clínica que ya lo tenía, y sí a la nueva", async () => {
    // Es la regla central de todo el diseño.
    const pais = await crearPais();
    const plan = await crearPlan();
    await upsertPlanPrice({
      planId: plan.id,
      countryId: pais.id,
      billingPeriod: "mensual",
      amount: dec("18000"),
      changedById: null,
    });

    const vieja = await crearClinica({ country: pais.id });
    await setClinicMembership({
      clinicId: vieja.id,
      input: { pricing: "lista", planId: plan.id, billingPeriod: "mensual" },
      changedById: null,
    });

    // Aumento del precio de lista.
    await upsertPlanPrice({
      planId: plan.id,
      countryId: pais.id,
      billingPeriod: "mensual",
      amount: dec("25000"),
      changedById: null,
    });

    const nueva = await crearClinica({ country: pais.id });
    await setClinicMembership({
      clinicId: nueva.id,
      input: { pricing: "lista", planId: plan.id, billingPeriod: "mensual" },
      changedById: null,
    });

    expect((await getClinicMembership(vieja.id))?.amount).toBe("18000.00");
    expect((await getClinicMembership(nueva.id))?.amount).toBe("25000.00");
  });

  it("avisa que la lista cambió después, sin cambiar el monto", async () => {
    const pais = await crearPais();
    const plan = await crearPlan();
    await upsertPlanPrice({
      planId: plan.id,
      countryId: pais.id,
      billingPeriod: "mensual",
      amount: dec("18000"),
      changedById: null,
    });
    const clinic = await crearClinica({ country: pais.id });
    await setClinicMembership({
      clinicId: clinic.id,
      input: { pricing: "lista", planId: plan.id, billingPeriod: "mensual" },
      changedById: null,
    });

    await upsertPlanPrice({
      planId: plan.id,
      countryId: pais.id,
      billingPeriod: "mensual",
      amount: dec("25000"),
      changedById: null,
    });

    const view = await getClinicMembership(clinic.id);
    expect(view?.amount).toBe("18000.00");
    expect(view?.listPrice?.amount).toBe("25000.00");
    expect(view?.listaCambiadaDespues).toBe(true);
    expect(view?.comparacion).toMatchObject({ estado: "por_debajo" });
  });

  it("borrar un precio de lista no le toca el monto a nadie", async () => {
    const pais = await crearPais();
    const plan = await crearPlan();
    await upsertPlanPrice({
      planId: plan.id,
      countryId: pais.id,
      billingPeriod: "mensual",
      amount: dec("18000"),
      changedById: null,
    });
    const clinic = await crearClinica({ country: pais.id });
    await setClinicMembership({
      clinicId: clinic.id,
      input: { pricing: "lista", planId: plan.id, billingPeriod: "mensual" },
      changedById: null,
    });

    const result = await deletePlanPrice({
      planId: plan.id,
      countryId: pais.id,
      billingPeriod: "mensual",
      changedById: null,
    });

    expect(result).toEqual({ ok: true, clinicasSinReferencia: 1 });
    const view = await getClinicMembership(clinic.id);
    expect(view?.amount).toBe("18000.00");
    // Se pierde la referencia, no el precio.
    expect(view?.listPriceStatus).toBe("no_cargado");
  });

  it("no deja estrenar precio en un país desactivado, pero sí corregir el que ya estaba", async () => {
    const pais = await crearPais();
    const plan = await crearPlan();
    await prisma.country.update({ where: { id: pais.id }, data: { active: false } });

    expect(
      await upsertPlanPrice({
        planId: plan.id,
        countryId: pais.id,
        billingPeriod: "mensual",
        amount: dec("100"),
        changedById: null,
      })
    ).toEqual({ ok: false, reason: "pais_inactivo" });

    await prisma.country.update({ where: { id: pais.id }, data: { active: true } });
    await upsertPlanPrice({
      planId: plan.id,
      countryId: pais.id,
      billingPeriod: "mensual",
      amount: dec("100"),
      changedById: null,
    });
    await prisma.country.update({ where: { id: pais.id }, data: { active: false } });

    expect(
      await upsertPlanPrice({
        planId: plan.id,
        countryId: pais.id,
        billingPeriod: "mensual",
        amount: dec("200"),
        changedById: null,
      })
    ).toEqual({ ok: true });
  });
});

describe("membresía de una clínica", () => {
  it("exonerar conserva el plan y sus funcionalidades", async () => {
    // La regresión que más importa: antes, no cobrarle obligaba a dejarla sin
    // plan, y los jobs filtran por `clinic.plan?.features`.
    const plan = await crearPlan([PLAN_FEATURES.REMINDER_2H]);
    const clinic = await crearClinica({ planId: plan.id });

    const result = await setClinicMembership({
      clinicId: clinic.id,
      input: { pricing: "exonerada", planId: plan.id, reason: "Convenio de colaboración" },
      changedById: null,
    });
    expect(result).toEqual({ ok: true });

    const despues = await prisma.clinic.findUniqueOrThrow({
      where: { id: clinic.id },
      include: { plan: true },
    });
    expect(despues.planId).toBe(plan.id);
    expect(despues.plan?.features).toContain(PLAN_FEATURES.REMINDER_2H);
    expect(despues.membershipPricing).toBe("exonerada");
    expect(despues.membershipCost).toBe(null);
    expect(despues.membershipReason).toBe("Convenio de colaboración");
  });

  it("exonerar no necesita país: no hay monto que expresar", async () => {
    const plan = await crearPlan();
    const clinic = await crearClinica({ country: null, planId: plan.id });

    expect(
      await setClinicMembership({
        clinicId: clinic.id,
        input: { pricing: "exonerada", planId: plan.id, reason: "Convenio" },
        changedById: null,
      })
    ).toEqual({ ok: true });
  });

  it("un precio sin país se rechaza: no hay moneda en la que expresarlo", async () => {
    const plan = await crearPlan();
    const clinic = await crearClinica({ country: null });

    expect(
      await setClinicMembership({
        clinicId: clinic.id,
        input: {
          pricing: "especial",
          planId: plan.id,
          billingPeriod: "mensual",
          amount: dec("1000"),
          reason: "Colaboración",
        },
        changedById: null,
      })
    ).toEqual({ ok: false, reason: "sin_pais" });
  });

  it("'lista' sin precio cargado se rechaza en vez de dejar el monto en null", async () => {
    const pais = await crearPais();
    const plan = await crearPlan();
    const clinic = await crearClinica({ country: pais.id });

    expect(
      await setClinicMembership({
        clinicId: clinic.id,
        input: { pricing: "lista", planId: plan.id, billingPeriod: "mensual" },
        changedById: null,
      })
    ).toEqual({ ok: false, reason: "sin_precio_de_lista" });
  });

  it("la moneda se congela: cambiarle el país a la clínica no reinterpreta el monto", async () => {
    const ar = await crearPais("ARS");
    const mx = await crearPais("MXN");
    const plan = await crearPlan();
    const clinic = await crearClinica({ country: ar.id });

    await setClinicMembership({
      clinicId: clinic.id,
      input: {
        pricing: "especial",
        planId: plan.id,
        billingPeriod: "mensual",
        amount: dec("15000"),
        reason: "Colaboración",
      },
      changedById: null,
    });

    await prisma.clinic.update({ where: { id: clinic.id }, data: { country: mx.id } });

    const view = await getClinicMembership(clinic.id);
    expect(view?.currency).toBe("ARS");
    expect(view?.currencyMismatch).toEqual({ membresia: "ARS", pais: "MXN" });
  });

  it("volver a 'sin configurar' limpia todo, incluido el plan", async () => {
    const plan = await crearPlan();
    const clinic = await crearClinica({ planId: plan.id });
    await setClinicMembership({
      clinicId: clinic.id,
      input: { pricing: "exonerada", planId: plan.id, reason: "Convenio" },
      changedById: null,
    });

    await setClinicMembership({
      clinicId: clinic.id,
      input: { pricing: null },
      changedById: null,
    });

    const despues = await prisma.clinic.findUniqueOrThrow({ where: { id: clinic.id } });
    expect(despues.membershipPricing).toBe(null);
    expect(despues.membershipCost).toBe(null);
    expect(despues.planId).toBe(null);
  });

  it("sacarle el precio pero dejarle el plan conserva las funcionalidades", async () => {
    // Es el estado en el que nace toda clínica (`POST /platform/clinics` la
    // crea en "Base" sin precio), así que la pantalla tiene que poder volver a
    // él. Si el único "sin configurar" posible borrara el plan, quitarle el
    // precio a una clínica le apagaría de paso los recordatorios de 2hs.
    const pais = await crearPais();
    const plan = await crearPlan([PLAN_FEATURES.REMINDER_2H]);
    const clinic = await crearClinica({ country: pais.id, planId: plan.id });
    await setClinicMembership({
      clinicId: clinic.id,
      input: {
        pricing: "especial",
        planId: plan.id,
        billingPeriod: "mensual",
        amount: dec("15000"),
        reason: "Colaboración",
      },
      changedById: null,
    });

    await setClinicMembership({
      clinicId: clinic.id,
      input: { pricing: null, planId: plan.id },
      changedById: null,
    });

    const despues = await prisma.clinic.findUniqueOrThrow({
      where: { id: clinic.id },
      include: { plan: true },
    });
    expect(despues.membershipPricing).toBe(null);
    expect(despues.membershipCost).toBe(null);
    expect(despues.membershipCurrency).toBe(null);
    expect(despues.membershipReason).toBe(null);
    expect(despues.planId).toBe(plan.id);
    expect(despues.plan?.features).toContain(PLAN_FEATURES.REMINDER_2H);
  });

  it("no acepta un plan inexistente ni cuando no hay precio que fijar", async () => {
    const clinic = await crearClinica();
    const result = await setClinicMembership({
      clinicId: clinic.id,
      input: { pricing: null, planId: "plan-que-no-existe" },
      changedById: null,
    });
    expect(result).toEqual({ ok: false, reason: "plan_no_encontrado" });
  });

  it("cada cambio deja una fila de historial con el antes y el después", async () => {
    const pais = await crearPais();
    const plan = await crearPlan();
    await upsertPlanPrice({
      planId: plan.id,
      countryId: pais.id,
      billingPeriod: "mensual",
      amount: dec("18000"),
      changedById: null,
    });
    const clinic = await crearClinica({ country: pais.id });

    await setClinicMembership({
      clinicId: clinic.id,
      input: { pricing: "lista", planId: plan.id, billingPeriod: "mensual" },
      changedById: null,
    });
    await setClinicMembership({
      clinicId: clinic.id,
      input: { pricing: "exonerada", planId: plan.id, reason: "Pasa a convenio" },
      changedById: null,
    });

    const historial = await listMembershipChanges(clinic.id);
    expect(historial).toHaveLength(2);
    // El más nuevo primero.
    expect(historial[0].toPricing).toBe("exonerada");
    expect(historial[0].fromPricing).toBe("lista");
    expect(historial[0].fromAmount?.toFixed(2)).toBe("18000.00");
    expect(historial[0].toAmount).toBe(null);
    expect(historial[0].reason).toBe("Pasa a convenio");
  });
});
