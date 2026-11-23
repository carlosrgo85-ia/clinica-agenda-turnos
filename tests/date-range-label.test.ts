import { describe, expect, it } from "vitest";
import { etiquetaDeCitas, tituloDeDia, tituloDeRango } from "../frontend/src/lib/date-range-label";

describe("el título del período de la Agenda", () => {
  it("un día: con el día de la semana, el mes en letras y el año", () => {
    expect(tituloDeDia("2026-11-21")).toBe("Sábado 21 de noviembre de 2026");
    expect(tituloDeDia("2027-01-01")).toBe("Viernes 1 de enero de 2027");
  });

  it("una semana del mismo mes no repite el mes", () => {
    expect(tituloDeRango("2026-11-16", "2026-11-22")).toBe("16 – 22 de noviembre de 2026");
  });

  it("una semana que cruza de mes nombra los dos meses y un solo año", () => {
    expect(tituloDeRango("2026-10-26", "2026-11-01")).toBe("26 de octubre – 1 de noviembre de 2026");
  });

  it("una semana que cruza de año nombra los dos años", () => {
    expect(tituloDeRango("2026-12-28", "2027-01-03")).toBe("28 de diciembre de 2026 – 3 de enero de 2027");
  });

  it("no depende de la zona horaria: el día no se corre", () => {
    expect(tituloDeDia("2026-03-01")).toBe("Domingo 1 de marzo de 2026");
  });

  it("una fecha rara devuelve vacío en vez de romper la pantalla", () => {
    expect(tituloDeDia("x")).toBe("");
    expect(tituloDeRango("x", "2026-01-01")).toBe("");
  });

  it("la cantidad de citas va en singular o plural", () => {
    expect([0, 1, 2, 12].map(etiquetaDeCitas)).toEqual(["0 citas", "1 cita", "2 citas", "12 citas"]);
  });
});
