import { describe, expect, it } from "vitest";
import { filterNavItems, activeHref, groupHasActiveRoute, groupNavItems, isActiveRoute, NAV_GROUPS, NAV_ITEMS, CATALOG_ITEMS, type NavItem } from "./nav-items";
import { Users } from "lucide-react";

describe("isActiveRoute", () => {
  it("es verdadero para una coincidencia exacta", () => {
    expect(isActiveRoute("/users", "/users")).toBe(true);
  });

  it("es verdadero para una ruta descendiente", () => {
    expect(isActiveRoute("/users/123", "/users")).toBe(true);
  });

  it("es falso para otra sección, aunque el prefijo de texto coincida", () => {
    // "/users-archived" no es descendiente de "/users" — sin la barra de
    // por medio, un startsWith ingenuo marcaría esto como activo.
    expect(isActiveRoute("/users-archived", "/users")).toBe(false);
  });

  it("es falso para una ruta no relacionada", () => {
    expect(isActiveRoute("/roles", "/users")).toBe(false);
  });
});

describe("filterNavItems", () => {
  const items: NavItem[] = [
    { title: "Usuarios", href: "/users", icon: Users, permission: "usuarios.ver" },
    { title: "Clínicas", href: "/clinics", icon: Users, superadminOnly: true },
  ];

  it("saca un item si al usuario le falta el permiso", () => {
    const result = filterNavItems(items, { clinicId: "c1", hasPermission: () => false });
    expect(result.map((i) => i.href)).toEqual([]);
  });

  it("un admin de clínica no ve los items superadminOnly", () => {
    const result = filterNavItems(items, { clinicId: "c1", hasPermission: () => true });
    expect(result.map((i) => i.href)).toEqual(["/users"]);
  });

  it("un super-admin (clinicId null) sí ve los items superadminOnly", () => {
    const result = filterNavItems(items, { clinicId: null, hasPermission: () => true });
    expect(result.map((i) => i.href)).toEqual(["/users", "/clinics"]);
  });
});

describe("el grupo Catálogos", () => {
  it("sus rutas cuelgan de /platform/catalogs, así el item del menú queda activo adentro", () => {
    for (const item of CATALOG_ITEMS) {
      expect(isActiveRoute(item.href, "/platform/catalogs")).toBe(true);
    }
  });

  it("Clínicas queda afuera del grupo y no lo enciende", () => {
    // El motivo de todo el cambio: Clínicas es la única operativa, así que
    // tiene su propio item. Si los catálogos colgaran de "/platform" a secas,
    // "Catálogos" se marcaría activo también estando en Clínicas.
    expect(isActiveRoute("/platform/clinics", "/platform/catalogs")).toBe(false);
    expect(NAV_ITEMS.map((i) => i.href)).toContain("/platform/clinics");
    expect(CATALOG_ITEMS.map((i) => i.href)).not.toContain("/platform/clinics");
  });

  it("cada tarjeta sigue siendo una opción con su permiso", () => {
    // Agruparlos no es que dejen de filtrarse: un usuario de plataforma puede
    // tener acceso a unos y no a otros.
    for (const item of CATALOG_ITEMS) {
      expect(item.permission).toBeTruthy();
      expect(item.superadminOnly).toBe(true);
    }

    const soloPaises = filterNavItems(CATALOG_ITEMS, {
      clinicId: null,
      hasPermission: (p) => p === "paises.ver",
    });
    expect(soloPaises.map((i) => i.title)).toEqual(["Países"]);
  });

  it("no quedaron sueltos en el menú principal", () => {
    const hrefs = NAV_ITEMS.map((i) => i.href);
    for (const item of CATALOG_ITEMS) {
      expect(hrefs).not.toContain(item.href);
    }
    expect(hrefs).toContain("/platform/catalogs");
  });

  it("un admin de clínica no ve ninguno, ni siquiera con todos los permisos", () => {
    const result = filterNavItems(CATALOG_ITEMS, {
      clinicId: "c1",
      hasPermission: () => true,
    });
    expect(result).toEqual([]);
  });
});

describe("las secciones del menú", () => {
  const todos = { clinicId: null, hasPermission: () => true };
  const deClinica = { clinicId: "c1", hasPermission: () => true };

  it("cada ítem del menú tiene una sección que existe", () => {
    const ids = NAV_GROUPS.map((g) => g.id);
    for (const item of NAV_ITEMS) expect(ids, item.title).toContain(item.group);
  });

  it("ninguna sección queda vacía y ningún ítem se pierde ni se repite", () => {
    const grupos = groupNavItems(NAV_ITEMS, todos);
    for (const g of grupos) expect(g.items.length, g.group.id).toBeGreaterThan(0);
    const hrefs = grupos.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs.sort()).toEqual(NAV_ITEMS.map((i) => i.href).sort());
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("lo frecuente va arriba y la configuración, los accesos y el sistema al fondo", () => {
    const orden = groupNavItems(NAV_ITEMS, todos).map((g) => g.group.id);
    expect(orden).toEqual(["plataforma", "dia", "seguimiento", "configuracion", "accesos", "sistema"]);
    const dia = groupNavItems(NAV_ITEMS, deClinica).find((g) => g.group.id === "dia")!;
    expect(dia.items.map((i) => i.title)).toEqual(["Agenda", "Citas", "Pacientes", "Por atender", "Conversaciones"]);
    expect(dia.group.defaultCollapsed).toBe(false);
    for (const id of ["configuracion", "accesos", "sistema"] as const) {
      expect(NAV_GROUPS.find((g) => g.id === id)!.defaultCollapsed, id).toBe(true);
    }
  });

  it("un admin de clínica no ve Plataforma ni Sistema, y un super-admin sí", () => {
    const clinica = groupNavItems(NAV_ITEMS, deClinica).map((g) => g.group.id);
    expect(clinica).not.toContain("plataforma");
    expect(clinica).not.toContain("sistema");
    const plataforma = groupNavItems(NAV_ITEMS, todos).map((g) => g.group.id);
    expect(plataforma).toContain("plataforma");
    expect(plataforma).toContain("sistema");
  });

  it("respeta los permisos: sin ninguno de una sección, la sección no se dibuja", () => {
    const soloAgenda = groupNavItems(NAV_ITEMS, { clinicId: "c1", hasPermission: (p) => p === "turnos.ver" });
    expect(soloAgenda.map((g) => g.group.id)).toEqual(["dia"]);
    expect(soloAgenda[0].items.map((i) => i.title)).toEqual(["Agenda", "Citas"]);
  });

  it("estar en una pantalla de una sección la marca como activa (para abrirla sola)", () => {
    const config = groupNavItems(NAV_ITEMS, deClinica).find((g) => g.group.id === "configuracion")!;
    expect(groupHasActiveRoute(config.items, "/holidays")).toBe(true);
    expect(groupHasActiveRoute(config.items, "/appointments")).toBe(false);
  });

  it("los sinónimos del buscador son palabras que no repiten el título", () => {
    for (const item of NAV_ITEMS) {
      for (const k of item.keywords ?? []) {
        expect(k.trim().toLowerCase(), `${item.title}: ${k}`).not.toBe(item.title.toLowerCase());
      }
    }
  });

  it("se llega a una pantalla por cómo la llamaría la gente", () => {
    const quien = (palabra: string) => NAV_ITEMS.filter((i) => (i.keywords ?? []).some((k) => k.includes(palabra))).map((i) => i.title);
    expect(quien("horario de comida")).toContain("Horarios");
    expect(quien("precio")).toEqual(expect.arrayContaining(["Servicios", "Costos"]));
    expect(quien("obra social")).toContain("Seguros");
    expect(quien("consultorios")).toContain("Recursos");
    expect(quien("permisos")).toContain("Roles");
  });
});

describe("lo que el menú recuerda", () => {
  it("las pantallas recientes: la última primero, sin repetir y hasta cinco", async () => {
    const { pushRecent, MAX_RECENTS } = await import("./nav-state");
    let r: string[] = [];
    for (const h of ["/a", "/b", "/c", "/d", "/e", "/f"]) r = pushRecent(h, r);
    expect(r).toEqual(["/f", "/e", "/d", "/c", "/b"]);
    expect(r).toHaveLength(MAX_RECENTS);
    expect(pushRecent("/d", r)).toEqual(["/d", "/f", "/e", "/c", "/b"]);
  });

  it("sin localStorage (ventana privada, o este runner) no falla y simplemente no recuerda", async () => {
    const { readGroupState, readRecents, writeGroupState } = await import("./nav-state");
    expect(readGroupState()).toEqual({});
    expect(readRecents()).toEqual([]);
    expect(() => writeGroupState({ dia: true })).not.toThrow();
  });
});

describe("Clínicas y Nueva clínica", () => {
  const todos = { clinicId: null, hasPermission: () => true };

  it("Crear clínica está en Plataforma, justo después de Clínicas, con el permiso de crear", () => {
    const plataforma = groupNavItems(NAV_ITEMS, todos).find((g) => g.group.id === "plataforma")!;
    expect(plataforma.items.map((i) => i.title).slice(0, 2)).toEqual(["Clínicas", "Crear clínica"]);
    const nueva = NAV_ITEMS.find((i) => i.href === "/platform/clinics/new")!;
    expect(nueva.permission).toBe("clinicas.crear");
    expect(nueva.superadminOnly).toBe(true);
  });

  it("quien puede ver pero no crear clínicas no ve Crear clínica", () => {
    const soloVer = groupNavItems(NAV_ITEMS, { clinicId: null, hasPermission: (p) => p === "clinicas.ver" });
    const titulos = soloVer.flatMap((g) => g.items.map((i) => i.title));
    expect(titulos).toContain("Clínicas");
    expect(titulos).not.toContain("Crear clínica");
  });

  it("en /platform/clinics/new se enciende solo Crear clínica; en el listado y en un detalle, solo Clínicas", () => {
    const items = NAV_ITEMS;
    expect(activeHref(items, "/platform/clinics/new")).toBe("/platform/clinics/new");
    expect(activeHref(items, "/platform/clinics")).toBe("/platform/clinics");
    expect(activeHref(items, "/platform/clinics/abc123")).toBe("/platform/clinics");
    expect(activeHref(items, "/nada")).toBeNull();
  });

  it("el buscador encuentra el alta por 'nueva clínica' y 'alta'", () => {
    const quien = (palabra: string) => NAV_ITEMS.filter((i) => (i.keywords ?? []).some((k) => k.includes(palabra))).map((i) => i.title);
    expect(quien("nueva clínica")).toEqual(["Crear clínica"]);
    expect(quien("alta")).toContain("Crear clínica");
  });
});
