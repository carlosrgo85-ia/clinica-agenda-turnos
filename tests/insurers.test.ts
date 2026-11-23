import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import {
  listActiveInsurersForClinic,
  listInsurersForClinic,
  setClinicInsurer,
  updateInsurer,
} from "../src/repositories/insurers.repository";
import { buildSystemPrompt } from "../src/prompts/system-prompt";
import { SIN_SEGUROS, describeInsurers } from "../src/prompts/insurers-context";

/**
 * Con qué obras sociales trabaja una clínica.
 *
 * Lo que se testea es que el agente vea SOLO la intersección (activa en el
 * catálogo y activa para esa clínica) y que el prompt distinga "no trabaja con
 * ninguno" de "no está cargado": afirmar cualquiera de las dos cosas de más
 * termina en un paciente que llega y tiene que pagar, o en uno que no viene
 * creyendo que no lo atienden.
 */

const clinicIds: string[] = [];
const insurerIds: string[] = [];

async function crearClinica() {
  const sufijo = `${Date.now()}-${Math.random()}`;
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica seguros ${sufijo}`,
      whatsappPhoneNumberId: `seguros-${sufijo}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "seguros@example.com",
      timezone: "UTC",
      services: "Consulta",
    },
  });
  clinicIds.push(clinic.id);
  return clinic;
}

async function crearSeguro(name: string) {
  const insurer = await prisma.insurer.create({
    data: { name: `${name} ${Date.now()}-${Math.random()}` },
  });
  insurerIds.push(insurer.id);
  return insurer;
}

afterEach(async () => {
  await prisma.clinicInsurer.deleteMany({ where: { clinicId: { in: clinicIds } } });
  for (const clinicId of clinicIds) {
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
  await prisma.insurer.deleteMany({ where: { id: { in: insurerIds } } });
  insurerIds.length = 0;
});

describe("seguros de una clínica", () => {
  it("el agente ve solo los activos en las dos puntas", async () => {
    const clinic = await crearClinica();
    const activo = await crearSeguro("OSDE");
    const dadoDeBaja = await crearSeguro("Swiss Medical");
    const fueraDelCatalogo = await crearSeguro("Galeno");
    await crearSeguro("Medifé"); // existe pero la clínica no lo tomó

    await setClinicInsurer({ clinicId: clinic.id, insurerId: activo.id, active: true });
    await setClinicInsurer({ clinicId: clinic.id, insurerId: dadoDeBaja.id, active: false });
    await setClinicInsurer({ clinicId: clinic.id, insurerId: fueraDelCatalogo.id, active: true });
    // Se saca del catálogo global después de que la clínica lo tomó.
    await prisma.insurer.update({ where: { id: fueraDelCatalogo.id }, data: { active: false } });

    expect(await listActiveInsurersForClinic(clinic.id)).toEqual([activo.name]);
  });

  it("tomar un seguro es idempotente y reactivarlo no duplica la fila", async () => {
    const clinic = await crearClinica();
    const seguro = await crearSeguro("OSDE");

    await setClinicInsurer({ clinicId: clinic.id, insurerId: seguro.id, active: true });
    await setClinicInsurer({ clinicId: clinic.id, insurerId: seguro.id, active: false });
    await setClinicInsurer({ clinicId: clinic.id, insurerId: seguro.id, active: true });

    expect(await prisma.clinicInsurer.count({ where: { clinicId: clinic.id } })).toBe(1);
    expect(await listActiveInsurersForClinic(clinic.id)).toEqual([seguro.name]);
  });

  it("la pantalla distingue no tomado, activo y dado de baja", async () => {
    const clinic = await crearClinica();
    const activo = await crearSeguro("OSDE");
    const baja = await crearSeguro("Swiss Medical");
    const nuncaTomado = await crearSeguro("Galeno");

    await setClinicInsurer({ clinicId: clinic.id, insurerId: activo.id, active: true });
    await setClinicInsurer({ clinicId: clinic.id, insurerId: baja.id, active: false });

    const filas = await listInsurersForClinic(clinic.id);
    const porId = new Map(filas.map((f) => [f.id, f.active]));

    expect(porId.get(activo.id)).toBe(true);
    expect(porId.get(baja.id)).toBe(false);
    expect(porId.get(nuncaTomado.id)).toBe(null);
  });

  it("no se puede desactivar del catálogo uno que una clínica tiene activo", async () => {
    const clinic = await crearClinica();
    const seguro = await crearSeguro("OSDE");
    await setClinicInsurer({ clinicId: clinic.id, insurerId: seguro.id, active: true });

    expect(await updateInsurer(seguro.id, { active: false })).toEqual({
      ok: false,
      reason: "en_uso",
      clinicas: 1,
    });

    // Si la clínica lo da de baja primero, ya se puede.
    await setClinicInsurer({ clinicId: clinic.id, insurerId: seguro.id, active: false });
    expect(await updateInsurer(seguro.id, { active: false })).toEqual({ ok: true });
  });

  it("uno que salió del catálogo no se puede volver a tomar, pero sí dar de baja", async () => {
    const clinic = await crearClinica();
    const seguro = await crearSeguro("OSDE");
    await setClinicInsurer({ clinicId: clinic.id, insurerId: seguro.id, active: true });
    await prisma.insurer.update({ where: { id: seguro.id }, data: { active: false } });

    // Darlo de baja tiene que seguir siendo posible: si no, la clínica queda
    // con una fila activa que no puede sacarse.
    expect(await setClinicInsurer({ clinicId: clinic.id, insurerId: seguro.id, active: true })).toEqual(
      { ok: false, reason: "aseguradora_inexistente" }
    );
    expect(
      await setClinicInsurer({ clinicId: clinic.id, insurerId: seguro.id, active: false })
    ).toEqual({ ok: true });
  });
});

describe("la línea de seguros del prompt", () => {
  it("lista los nombres cuando hay", () => {
    expect(describeInsurers(["OSDE", "Swiss Medical"])).toBe("OSDE, Swiss Medical");
  });

  it("sin seguros cargados no afirma ni niega", () => {
    // El punto: una lista vacía puede ser "no trabajamos con ninguno" o
    // "todavía no lo cargamos", y no hay forma de distinguirlas.
    expect(describeInsurers([])).toBe(SIN_SEGUROS);
    expect(SIN_SEGUROS).toContain("no afirmes");
  });

  it("el prompt incluye los seguros y prohíbe hablar de cobertura", async () => {
    const clinic = await crearClinica();

    const prompt = buildSystemPrompt(clinic, {
      esPrimeraVez: false,
      seguros: ["OSDE", "Swiss Medical"],
    });

    expect(prompt).toContain("OSDE, Swiss Medical");
    expect(prompt).toContain("NUNCA digas qué cubre un seguro");
  });

  it("el prompt avisa que no está cargado cuando la clínica no tiene ninguno", async () => {
    const clinic = await crearClinica();

    expect(buildSystemPrompt(clinic, { esPrimeraVez: false, seguros: [] })).toContain(SIN_SEGUROS);
  });
});
