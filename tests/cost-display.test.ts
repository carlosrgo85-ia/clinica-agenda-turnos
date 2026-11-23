import { describe, expect, it } from "vitest";
import { mostrarCosto } from "../frontend/src/lib/cost-display";

const usd = (n: number) => `US$ ${n.toFixed(2)}`;

describe("mostrar un costo cuando falta la tarifa", () => {
  it("127 llamadas y ninguna con tarifa NO se muestra como US$ 0,00", () => {
    expect(mostrarCosto({ costoUsd: 0, total: 127, sinTarifa: 127, formatear: usd })).toEqual({ texto: "Sin tarifa", incompleto: true });
  });

  it("si solo a una parte le falta la tarifa, muestra lo conocido y cuántas faltan", () => {
    expect(mostrarCosto({ costoUsd: 0.12, total: 100, sinTarifa: 40, formatear: usd })).toEqual({
      texto: "US$ 0.12 + 40 sin tarifa", incompleto: true,
    });
  });

  it("con todo tarifado muestra el costo, y un consumo realmente gratis es cero", () => {
    expect(mostrarCosto({ costoUsd: 1.5, total: 10, sinTarifa: 0, formatear: usd })).toEqual({ texto: "US$ 1.50", incompleto: false });
    expect(mostrarCosto({ costoUsd: 0, total: 10, sinTarifa: 0, formatear: usd })).toEqual({ texto: "US$ 0.00", incompleto: false });
  });

  it("sin consumo no inventa un aviso", () => {
    expect(mostrarCosto({ costoUsd: 0, total: 0, sinTarifa: 0, formatear: usd })).toEqual({ texto: "US$ 0.00", incompleto: false });
  });
});
