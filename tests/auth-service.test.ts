import { describe, expect, it } from "vitest";
import {
  generateResetToken,
  hashPassword,
  hashResetToken,
  signSession,
  verifyPassword,
  verifySession,
} from "../src/services/auth";

describe("hashPassword / verifyPassword", () => {
  it("un hash verifica contra la contraseña original", async () => {
    const hash = await hashPassword("una-contraseña-larga");
    expect(await verifyPassword("una-contraseña-larga", hash)).toBe(true);
  });

  it("rechaza una contraseña distinta", async () => {
    const hash = await hashPassword("una-contraseña-larga");
    expect(await verifyPassword("otra-cosa", hash)).toBe(false);
  });
});

describe("signSession / verifySession", () => {
  it("recupera el mismo payload que se firmó", () => {
    const token = signSession({ userId: "u1", clinicId: "c1" });
    expect(verifySession(token)).toEqual({ userId: "u1", clinicId: "c1" });
  });

  it("acepta clinicId null (super-admin)", () => {
    const token = signSession({ userId: "u1", clinicId: null });
    expect(verifySession(token)).toEqual({ userId: "u1", clinicId: null });
  });

  it("rechaza un token con la firma alterada", () => {
    const token = signSession({ userId: "u1", clinicId: null });
    expect(verifySession(token.slice(0, -1) + (token.endsWith("a") ? "b" : "a"))).toBeNull();
  });

  it("rechaza basura que no es un JWT", () => {
    expect(verifySession("esto-no-es-un-token")).toBeNull();
  });
});

describe("generateResetToken / hashResetToken", () => {
  it("el hash del token generado coincide con volver a hashearlo", () => {
    const { token, tokenHash } = generateResetToken();
    expect(hashResetToken(token)).toBe(tokenHash);
  });

  it("dos tokens generados no se repiten", () => {
    const a = generateResetToken();
    const b = generateResetToken();
    expect(a.token).not.toBe(b.token);
  });
});
