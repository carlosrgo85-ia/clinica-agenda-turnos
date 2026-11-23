import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { requirePermission, requireSuperAdmin } from "../src/middleware/authorize";
import type { AuthenticatedUser } from "../src/middleware/authenticate";

function mockRes() {
  const res = { statusCode: 0, body: undefined as unknown };
  return {
    status: (code: number) => {
      res.statusCode = code;
      return { json: (body: unknown) => (res.body = body) };
    },
    get statusCode() {
      return res.statusCode;
    },
    get body() {
      return res.body;
    },
  };
}

function mockReq(user: AuthenticatedUser | undefined, params: Record<string, string> = {}) {
  return { user, params } as unknown as Request;
}

describe("requirePermission", () => {
  it("deja pasar si el usuario tiene el permiso y no hay :clinicId en la ruta", () => {
    const next = vi.fn();
    const req = mockReq({ id: "u1", clinicId: "c1", permissions: new Set(["usuarios.ver"]) });
    requirePermission("usuarios.ver")(req, mockRes() as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("responde 401 si no hay usuario autenticado", () => {
    const next = vi.fn();
    const res = mockRes();
    requirePermission("usuarios.ver")(mockReq(undefined), res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("responde 403 si le falta el permiso", () => {
    const next = vi.fn();
    const res = mockRes();
    const req = mockReq({ id: "u1", clinicId: "c1", permissions: new Set() });
    requirePermission("usuarios.ver")(req, res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("responde 403 si el usuario es de OTRA clínica que la de la ruta", () => {
    const next = vi.fn();
    const res = mockRes();
    const req = mockReq(
      { id: "u1", clinicId: "c1", permissions: new Set(["usuarios.ver"]) },
      { clinicId: "c2" }
    );
    requirePermission("usuarios.ver")(req, res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("un super-admin (clinicId null) pasa para cualquier :clinicId de la ruta", () => {
    const next = vi.fn();
    const req = mockReq(
      { id: "u1", clinicId: null, permissions: new Set(["usuarios.ver"]) },
      { clinicId: "c2" }
    );
    requirePermission("usuarios.ver")(req, mockRes() as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("requireSuperAdmin", () => {
  it("deja pasar a un usuario sin clínica asociada", () => {
    const next = vi.fn();
    const req = mockReq({ id: "u1", clinicId: null, permissions: new Set() });
    requireSuperAdmin(req, mockRes() as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("responde 403 a un usuario de una clínica puntual", () => {
    const next = vi.fn();
    const res = mockRes();
    const req = mockReq({ id: "u1", clinicId: "c1", permissions: new Set() });
    requireSuperAdmin(req, res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
