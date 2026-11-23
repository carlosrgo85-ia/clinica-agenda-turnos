import { describe, expect, it } from "vitest";
import { resolvePermissions } from "../src/services/permissions";

/**
 * Un usuario puede tener varios roles; el permiso efectivo es la UNIÓN de
 * los permisos de todos, no solo del primero. Si esto se rompe, un admin
 * que le agrega un segundo rol a alguien podría verlo perder permisos del
 * primero en vez de sumarlos.
 */
describe("resolvePermissions", () => {
  it("es la unión de los permisos de todos los roles del usuario", () => {
    const user = {
      roles: [
        { role: { permissions: [{ permission: { id: "usuarios.ver" } }] } },
        { role: { permissions: [{ permission: { id: "roles.ver" } }] } },
      ],
    };
    const permissions = resolvePermissions(user);
    expect(permissions.has("usuarios.ver")).toBe(true);
    expect(permissions.has("roles.ver")).toBe(true);
    expect(permissions.size).toBe(2);
  });

  it("no duplica un permiso que dos roles comparten", () => {
    const user = {
      roles: [
        { role: { permissions: [{ permission: { id: "usuarios.ver" } }] } },
        { role: { permissions: [{ permission: { id: "usuarios.ver" } }] } },
      ],
    };
    expect(resolvePermissions(user).size).toBe(1);
  });

  it("un usuario sin roles no tiene ningún permiso", () => {
    expect(resolvePermissions({ roles: [] }).size).toBe(0);
  });
});
