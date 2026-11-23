import { describe, expect, it } from "vitest";
import { repartirEnCarriles } from "../frontend/src/lib/appointment-lanes";

/**
 * Dos citas del mismo profesional a la misma hora (sobreturno confirmado) no
 * pueden quedar una encima de la otra en la Agenda: la de abajo no se veía.
 */
describe("repartirEnCarriles", () => {
  it("una cita sola ocupa todo el ancho", () => {
    const r = repartirEnCarriles([{ id: "a", inicio: 600, fin: 660 }]);
    expect(r.get("a")).toEqual({ carril: 0, carriles: 1 });
  });

  it("dos citas a la misma hora van lado a lado", () => {
    const r = repartirEnCarriles([
      { id: "a", inicio: 660, fin: 720 },
      { id: "b", inicio: 660, fin: 720 },
    ]);
    expect(r.get("a")).toEqual({ carril: 0, carriles: 2 });
    expect(r.get("b")).toEqual({ carril: 1, carriles: 2 });
  });

  it("citas que solo se rozan no se pisan y conservan el ancho completo", () => {
    const r = repartirEnCarriles([
      { id: "a", inicio: 600, fin: 660 },
      { id: "b", inicio: 660, fin: 720 },
    ]);
    expect(r.get("a")).toEqual({ carril: 0, carriles: 1 });
    expect(r.get("b")).toEqual({ carril: 0, carriles: 1 });
  });

  it("una cita larga y dos cortas seguidas: las cortas comparten un carril", () => {
    const r = repartirEnCarriles([
      { id: "larga", inicio: 600, fin: 720 },
      { id: "c1", inicio: 600, fin: 660 },
      { id: "c2", inicio: 660, fin: 720 },
    ]);
    // c1 y c2 no se pisan entre sí, así que no hace falta un tercer carril.
    expect(r.get("c1")).toEqual({ carril: 0, carriles: 2 });
    expect(r.get("c2")).toEqual({ carril: 0, carriles: 2 });
    expect(r.get("larga")).toEqual({ carril: 1, carriles: 2 });
  });

  it("un grupo no afecta el ancho de las citas que vienen después", () => {
    const r = repartirEnCarriles([
      { id: "a", inicio: 600, fin: 660 },
      { id: "b", inicio: 600, fin: 660 },
      { id: "c", inicio: 720, fin: 780 },
    ]);
    expect(r.get("c")).toEqual({ carril: 0, carriles: 1 });
  });

  it("es estable sin importar el orden en que llegan", () => {
    const a = repartirEnCarriles([
      { id: "x", inicio: 660, fin: 720 },
      { id: "y", inicio: 660, fin: 720 },
    ]);
    const b = repartirEnCarriles([
      { id: "y", inicio: 660, fin: 720 },
      { id: "x", inicio: 660, fin: 720 },
    ]);
    expect(a.get("x")).toEqual(b.get("x"));
    expect(a.get("y")).toEqual(b.get("y"));
  });
});
