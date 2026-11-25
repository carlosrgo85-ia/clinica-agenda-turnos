import { describe, expect, it } from "vitest";
import { normalizeTaxId } from "../src/services/tax-id";

describe("normalizeTaxId", () => {
  it("pasa el RFC a mayúsculas y quita los espacios de los extremos", () => {
    expect(normalizeTaxId("  abc010203ab1 ")).toBe("ABC010203AB1");
  });

  it("acepta la ñ y el & del RFC de una persona moral", () => {
    expect(normalizeTaxId("ñab&010203ab1")).toBe("ÑAB&010203AB1");
  });

  it("no toca guiones, puntos ni barras de otros países", () => {
    expect(normalizeTaxId("20-12345678-9")).toBe("20-12345678-9"); // CUIT
    expect(normalizeTaxId("12.345.678-k")).toBe("12.345.678-K"); // RUT
    expect(normalizeTaxId("12.345.678/0001-90")).toBe("12.345.678/0001-90"); // CNPJ
  });

  it("colapsa los espacios repetidos pero no los borra", () => {
    expect(normalizeTaxId("b  12345678")).toBe("B 12345678");
  });

  it("vacío o sin texto es null (campo sin cargar)", () => {
    expect(normalizeTaxId("")).toBeNull();
    expect(normalizeTaxId("   ")).toBeNull();
    expect(normalizeTaxId(null)).toBeNull();
    expect(normalizeTaxId(undefined)).toBeNull();
  });
});
