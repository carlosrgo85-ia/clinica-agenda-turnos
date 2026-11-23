import { afterEach, describe, expect, it } from "vitest";
import { CLINIC_TEMPLATES, ensureClinicTemplates } from "../src/services/whatsapp-templates";

/**
 * El alta de plantillas contra un Meta simulado (`fetch` reemplazado).
 *
 * Lo que importa: Meta contesta casi todo como "Invalid parameter" genérico, y
 * el motivo de verdad viene en `error_user_msg`. Antes el código mostraba solo
 * el genérico —dos plantillas quedaron sin crear y nadie sabía por qué— y
 * además no reconocía "ya existe", que contestaba igual de genérico.
 */

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

function meta(respuestas: Record<string, { status: number; body: unknown }>) {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const { name } = JSON.parse(String(init?.body)) as { name: string };
    const r = respuestas[name] ?? { status: 200, body: { id: `id-${name}`, status: "PENDING" } };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
}

describe("ensureClinicTemplates", () => {
  it("crea las que faltan y reconoce las que ya existen aunque Meta conteste 'Invalid parameter'", async () => {
    meta({
      recordatorio_turno: {
        status: 400,
        body: {
          error: {
            message: "Invalid parameter",
            code: 100,
            error_subcode: 2388024,
            error_user_msg: "Ya existe contenido en este idioma para esta plantilla.",
          },
        },
      },
    });
    const r = await ensureClinicTemplates({ wabaId: "w", token: "t" });

    expect(r.find((x) => x.name === "recordatorio_turno")?.outcome).toBe("ya_existia");
    expect(r.filter((x) => x.outcome === "creada")).toHaveLength(CLINIC_TEMPLATES.length - 1);
  });

  it("muestra el motivo real del rechazo, no solo 'Invalid parameter'", async () => {
    meta({
      aviso_configuracion: {
        status: 400,
        body: {
          error: {
            message: "Invalid parameter",
            code: 100,
            error_subcode: 2388293,
            error_user_title: "La proporción entre parámetros y palabras es superior al límite",
            error_user_msg: "Esta plantilla tiene demasiadas variables en relación con su longitud.",
          },
        },
      },
    });
    const r = await ensureClinicTemplates({ wabaId: "w", token: "t" });
    const fallo = r.find((x) => x.name === "aviso_configuracion");

    expect(fallo?.outcome).toBe("error");
    expect(fallo?.error).toContain("demasiadas variables");
    expect(fallo?.error).toContain("2388293");
  });

  it("cada plantilla trae un ejemplo por variable (Meta lo exige)", () => {
    for (const t of CLINIC_TEMPLATES) {
      const variables = new Set(t.body.match(/\{\{\d+\}\}/g));
      expect(t.ejemplos, t.name).toHaveLength(variables.size);
      // Meta no admite una variable al principio ni al final del texto.
      expect(t.body, t.name).not.toMatch(/^\{\{\d+\}\}|\{\{\d+\}\}$/);
    }
  });
});
