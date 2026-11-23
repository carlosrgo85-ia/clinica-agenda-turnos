import { describe, expect, it } from "vitest";
import { buildLocationMessage } from "../src/services/location";

/**
 * El mensaje con la ubicación. Función pura, sin base ni red.
 *
 * Lo que importa es de dónde sale el link: la ficha de Google cuando está
 * cargada (apunta al lugar exacto) y la búsqueda por dirección como respaldo.
 */

function clinica(overrides?: { address?: string | null; googleBusinessUrl?: string | null }) {
  return {
    name: "Clínica Ejemplo",
    address: null,
    googleBusinessUrl: null,
    ...overrides,
  };
}

describe("buildLocationMessage", () => {
  it("usa la ficha de Google cuando está cargada", () => {
    const mensaje = buildLocationMessage(
      clinica({ address: "Av. Siempreviva 742", googleBusinessUrl: "https://share.google/abc123" })
    );

    expect(mensaje).toContain("https://share.google/abc123");
    // La búsqueda por dirección es el respaldo: acá no tiene que aparecer.
    expect(mensaje).not.toContain("maps/search");
    expect(mensaje).toContain("Av. Siempreviva 742");
  });

  it("cae a buscar por dirección si no hay ficha", () => {
    const mensaje = buildLocationMessage(clinica({ address: "Av. Siempreviva 742" }));

    expect(mensaje).toContain(
      "https://www.google.com/maps/search/?api=1&query=Av.%20Siempreviva%20742"
    );
  });

  it("escapa la dirección dentro del link, pero no en el texto", () => {
    const mensaje = buildLocationMessage(clinica({ address: "Calle 5 #12, Piso 3 & 4" }));

    // Sin escapar, el `#` corta la URL: Google recibiría "Calle 5 " y nada más.
    const link = mensaje!.split("Cómo llegar: ")[1];
    expect(link).toBe(
      "https://www.google.com/maps/search/?api=1&query=Calle%205%20%2312%2C%20Piso%203%20%26%204"
    );
    // La dirección legible va tal cual la cargó la clínica.
    expect(mensaje).toContain("Calle 5 #12, Piso 3 & 4");
  });

  it("incluye el nombre de la clínica", () => {
    const mensaje = buildLocationMessage(clinica({ address: "Av. Siempreviva 742" }));

    expect(mensaje).toContain("Clínica Ejemplo");
  });

  it("manda solo el link si hay ficha pero no dirección", () => {
    const mensaje = buildLocationMessage(clinica({ googleBusinessUrl: "https://share.google/abc" }));

    // Sin anunciar una dirección que no se va a mostrar.
    expect(mensaje).toBe("Cómo llegar a Clínica Ejemplo: https://share.google/abc");
  });

  it("no arma nada sin dirección ni ficha", () => {
    expect(buildLocationMessage(clinica())).toBeNull();
  });

  it("trata los campos en blanco como vacíos", () => {
    expect(buildLocationMessage(clinica({ address: "   ", googleBusinessUrl: "  " }))).toBeNull();
  });
});
