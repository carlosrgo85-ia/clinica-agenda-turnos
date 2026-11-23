import { describe, expect, it } from "vitest";
import { buildOAuthState, readOAuthState } from "../src/services/oauth-state";
import { signState } from "../src/services/crypto";
import { userCanAccessClinic } from "../src/middleware/authorize";
import type { AuthenticatedUser } from "../src/middleware/authenticate";

/**
 * El flujo de OAuth de Google lo inicia un usuario autenticado y el callback
 * exige que lo complete el mismo. Acá se testean las dos piezas puras: el
 * `state` que lleva quién inició el flujo, y la regla de acceso a la clínica.
 */

function user(clinicId: string | null, permissions: string[]): AuthenticatedUser {
  return { id: "u1", clinicId, email: "a@b.c", name: "A", permissions: new Set(permissions) } as AuthenticatedUser;
}

describe("readOAuthState", () => {
  it("devuelve clínica y usuario de un state válido", () => {
    expect(readOAuthState(buildOAuthState("google", "c1", "u1"), "google")).toEqual({ clinicId: "c1", userId: "u1" });
  });

  it("rechaza un state sin usuario (los emitidos antes de este cambio)", () => {
    expect(readOAuthState(signState({ provider: "google", clinicId: "c1" }), "google")).toBeNull();
  });

  it("rechaza un state vencido o adulterado", () => {
    expect(readOAuthState(signState({ provider: "google", clinicId: "c1", userId: "u1" }, -1), "google")).toBeNull();
    const [body, sig] = buildOAuthState("google", "c1", "u1").split(".");
    const otro = Buffer.from(JSON.stringify({ provider: "google", clinicId: "c2", userId: "u1", exp: Date.now() + 1e5 })).toString("base64url");
    expect(readOAuthState(`${otro}.${sig}`, "google")).toBeNull();
    expect(readOAuthState(`${body}.x`, "google")).toBeNull();
    expect(readOAuthState("basura", "google")).toBeNull();
  });
});

describe("el state es de un proveedor", () => {
  it("un state de Google no vale en el callback de Microsoft, ni al revés", () => {
    const g = buildOAuthState("google", "c1", "u1");
    const m = buildOAuthState("microsoft", "c1", "u1");
    expect(readOAuthState(g, "microsoft")).toBeNull();
    expect(readOAuthState(m, "google")).toBeNull();
    expect(readOAuthState(m, "microsoft")).toEqual({ clinicId: "c1", userId: "u1" });
  });

  it("rechaza un state viejo sin proveedor", () => {
    expect(readOAuthState(signState({ clinicId: "c1", userId: "u1" }), "google")).toBeNull();
  });
});

describe("userCanAccessClinic", () => {
  it("deja pasar a un usuario de la clínica con el permiso", () => {
    expect(userCanAccessClinic(user("c1", ["calendarios.editar"]), "c1", "calendarios.editar")).toBe(true);
  });

  it("rechaza a un usuario de otra clínica aunque tenga el permiso", () => {
    expect(userCanAccessClinic(user("c2", ["calendarios.editar"]), "c1", "calendarios.editar")).toBe(false);
  });

  it("rechaza a un usuario de la clínica sin el permiso", () => {
    expect(userCanAccessClinic(user("c1", ["calendarios.ver"]), "c1", "calendarios.editar")).toBe(false);
  });

  it("deja pasar al super-admin con el permiso, en cualquier clínica", () => {
    expect(userCanAccessClinic(user(null, ["calendarios.editar"]), "c9", "calendarios.editar")).toBe(true);
  });
});
