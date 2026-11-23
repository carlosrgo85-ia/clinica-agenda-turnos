import { describe, expect, it } from "vitest";
import { validateNewPatientName } from "../src/services/patient-admin";

/**
 * El alta a mano de un paciente (Agenda) exige nombre Y apellido (2026-11-21): con "Pedro" a secas la ficha quedaba sin apellido.
 */
describe("el nombre de un paciente que se da de alta a mano", () => {
  it("rechaza una sola palabra", () => {
    for (const name of ["Pedro", "  Pedro  ", ""]) {
      const r = validateNewPatientName({ name });
      expect(r.ok).toBe(false);
    }
    expect(validateNewPatientName({})).toMatchObject({ ok: false });
  });

  it("acepta el nombre completo con al menos dos palabras y lo normaliza", () => {
    expect(validateNewPatientName({ name: "  Pedro   Pérez " })).toEqual({
      ok: true, name: "Pedro Pérez", firstName: null, lastName: null,
    });
  });

  it("con las partes por separado exige las dos y las guarda tal cual (un nombre compuesto no se parte mal)", () => {
    expect(validateNewPatientName({ firstName: "Ana María", lastName: "de la Cruz" })).toEqual({
      ok: true, name: "Ana María de la Cruz", firstName: "Ana María", lastName: "de la Cruz",
    });
    const sinApellido = validateNewPatientName({ firstName: "Pedro", lastName: "  " });
    expect(sinApellido).toMatchObject({ ok: false });
    expect((sinApellido as { error: string }).error).toMatch(/apellido/);
    const sinNombre = validateNewPatientName({ firstName: "", lastName: "Pérez" });
    expect((sinNombre as { error: string }).error).toMatch(/nombre/);
  });

  it("las partes mandan sobre el nombre completo si vienen las dos formas", () => {
    expect(validateNewPatientName({ name: "X", firstName: "Pedro", lastName: "Pérez" })).toMatchObject({ ok: true, name: "Pedro Pérez" });
  });

  it("rechaza un nombre o apellido desmedido y valores que no son texto", () => {
    expect(validateNewPatientName({ firstName: "a".repeat(81), lastName: "b" })).toMatchObject({ ok: false });
    expect(validateNewPatientName({ name: 123 as unknown as string })).toMatchObject({ ok: false });
  });
});
