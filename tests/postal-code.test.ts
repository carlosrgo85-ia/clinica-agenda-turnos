import { describe, expect, it } from "vitest";
import { normalizePostalCode, postalCodeError } from "../src/services/postal-code";

describe("código postal del domicilio fiscal", () => {
  it("normaliza: recorta, junta espacios y pasa a mayúsculas", () => {
    expect(normalizePostalCode("  06700 ")).toBe("06700");
    expect(normalizePostalCode("c1425  abc")).toBe("C1425 ABC");
    expect(normalizePostalCode("   ")).toBeNull();
    expect(normalizePostalCode(null)).toBeNull();
  });

  it("en México exige exactamente 5 dígitos", () => {
    expect(postalCodeError("06700", "MX")).toBeNull();
    expect(postalCodeError("06700", "mx")).toBeNull();
    expect(postalCodeError("6700", "MX")).toMatch(/5 dígitos/);
    expect(postalCodeError("067001", "MX")).toMatch(/5 dígitos/);
    expect(postalCodeError("0670A", "MX")).toMatch(/5 dígitos/);
  });

  it("en otros países acepta los formatos habituales sin imponer uno", () => {
    expect(postalCodeError("01310-100", "BR")).toBeNull(); // CEP
    expect(postalCodeError("C1425 ABC", "AR")).toBeNull(); // CPA
    expect(postalCodeError("90210-1234", "US")).toBeNull(); // ZIP+4
    expect(postalCodeError("1425", "AR")).toBeNull();
  });

  it("rechaza lo que no tiene forma de código postal", () => {
    expect(postalCodeError("12", "AR")).not.toBeNull();
    expect(postalCodeError("calle 5, piso 2", "AR")).not.toBeNull();
    expect(postalCodeError("1".repeat(13), "AR")).not.toBeNull();
  });

  it("vacío es válido: el campo es opcional", () => {
    expect(postalCodeError("", "MX")).toBeNull();
    expect(postalCodeError(null, "MX")).toBeNull();
  });

  it("sin país conocido aplica la regla general", () => {
    expect(postalCodeError("06700", undefined)).toBeNull();
  });
});
