import { describe, expect, it } from "vitest";
import {
  displayAIso,
  enmascararFecha,
  isoADisplay,
} from "../frontend/src/lib/date-format";

/**
 * La conversión entre la fecha que se muestra (DD/MM/AAAA) y la que viaja
 * por la API (`YYYY-MM-DD`).
 *
 * Es del frontend, pero el módulo no tiene dependencias justamente para
 * poder correrlo con el runner del backend, que es el único que hay. Sin
 * esto, la parte donde de verdad se esconden los errores —fechas
 * imposibles, entradas a medias— quedaría sin probar.
 */

describe("isoADisplay", () => {
  it("da vuelta la fecha", () => {
    expect(isoADisplay("2026-09-15")).toBe("15/09/2026");
  });

  it("conserva los ceros a la izquierda", () => {
    expect(isoADisplay("2026-01-05")).toBe("05/01/2026");
  });

  it("devuelve vacío si no es una fecha ISO", () => {
    expect(isoADisplay("")).toBe("");
    expect(isoADisplay("15/09/2026")).toBe("");
    expect(isoADisplay("2026-9-5")).toBe("");
  });
});

describe("displayAIso", () => {
  it("da vuelta la fecha", () => {
    expect(displayAIso("15/09/2026")).toBe("2026-09-15");
  });

  /**
   * El caso que justifica validar el día contra el mes en vez de mirar solo
   * los rangos: `new Date("2026-02-31")` no falla, devuelve el 3 de marzo. Es
   * la misma trampa que está anotada para `dateKeyToUtcMidnight()`, y acá
   * cerraría la clínica un día que nadie eligió.
   */
  it("rechaza un día que no existe en ese mes", () => {
    expect(displayAIso("31/02/2026")).toBeNull();
    expect(displayAIso("31/04/2026")).toBeNull();
    expect(displayAIso("30/02/2028")).toBeNull();
  });

  it("acepta el 29 de febrero solo en año bisiesto", () => {
    expect(displayAIso("29/02/2028")).toBe("2028-02-29");
    expect(displayAIso("29/02/2026")).toBeNull();
  });

  it("rechaza meses y días fuera de rango", () => {
    expect(displayAIso("15/13/2026")).toBeNull();
    expect(displayAIso("00/09/2026")).toBeNull();
    expect(displayAIso("15/00/2026")).toBeNull();
  });

  it("devuelve null si la fecha está a medias", () => {
    expect(displayAIso("")).toBeNull();
    expect(displayAIso("15")).toBeNull();
    expect(displayAIso("15/09")).toBeNull();
    expect(displayAIso("15/09/20")).toBeNull();
  });

  it("es la vuelta exacta de isoADisplay", () => {
    for (const iso of ["2026-09-15", "2026-01-01", "2028-02-29", "2030-12-31"]) {
      expect(displayAIso(isoADisplay(iso))).toBe(iso);
    }
  });
});

describe("enmascararFecha", () => {
  it("va metiendo las barras mientras se escribe", () => {
    expect(enmascararFecha("1")).toBe("1");
    expect(enmascararFecha("15")).toBe("15");
    expect(enmascararFecha("159")).toBe("15/9");
    expect(enmascararFecha("1509")).toBe("15/09");
    expect(enmascararFecha("15092")).toBe("15/09/2");
    expect(enmascararFecha("15092026")).toBe("15/09/2026");
  });

  it("ignora lo que no sea un dígito", () => {
    expect(enmascararFecha("15/09/2026")).toBe("15/09/2026");
    expect(enmascararFecha("15-09-2026")).toBe("15/09/2026");
    expect(enmascararFecha("abc15def09")).toBe("15/09");
  });

  it("no deja escribir más de ocho dígitos", () => {
    expect(enmascararFecha("150920261234")).toBe("15/09/2026");
  });

  it("permite borrar", () => {
    expect(enmascararFecha("")).toBe("");
    expect(enmascararFecha("15/0")).toBe("15/0");
  });
});
