import { describe, expect, it } from "vitest";
import { periodsATramos } from "../src/services/google-hours";

/**
 * La conversión del horario que publica Google a tramos de `WorkingHours`.
 *
 * Importa que el corte del mediodía salga como dos tramos del mismo día —
 * que es exactamente cómo el sistema modela la hora de comida— y que los
 * casos raros de Google (abierto 24hs, cruce de medianoche) se descarten en
 * vez de inventar un horario que el negocio no declaró.
 */

function punto(day: number, hour: number, minute = 0) {
  return { day, hour, minute };
}

describe("periodsATramos", () => {
  it("convierte un día simple", () => {
    // Google numera desde el domingo: 1 = lunes.
    const tramos = periodsATramos([{ open: punto(1, 10), close: punto(1, 19) }]);

    expect(tramos).toEqual([{ weekday: "lunes", startMinute: 600, endMinute: 1140 }]);
  });

  it("mapea bien los siete días", () => {
    const tramos = periodsATramos(
      [0, 1, 2, 3, 4, 5, 6].map((d) => ({ open: punto(d, 9), close: punto(d, 10) }))
    );

    expect(tramos.map((t) => t.weekday)).toEqual([
      "lunes",
      "martes",
      "miercoles",
      "jueves",
      "viernes",
      "sabado",
      "domingo",
    ]);
  });

  /** La hora de comida: Google la manda como dos periods del mismo día. */
  it("deja el corte del mediodía como dos tramos", () => {
    const tramos = periodsATramos([
      { open: punto(1, 10), close: punto(1, 15) },
      { open: punto(1, 16), close: punto(1, 19) },
    ]);

    expect(tramos).toEqual([
      { weekday: "lunes", startMinute: 600, endMinute: 900 },
      { weekday: "lunes", startMinute: 960, endMinute: 1140 },
    ]);
  });

  it("respeta los minutos", () => {
    const tramos = periodsATramos([{ open: punto(2, 9, 30), close: punto(2, 13, 45) }]);

    expect(tramos[0]).toEqual({ weekday: "martes", startMinute: 570, endMinute: 825 });
  });

  it("ordena de lunes a domingo, no como los manda Google", () => {
    const tramos = periodsATramos([
      { open: punto(0, 10), close: punto(0, 14) }, // domingo
      { open: punto(6, 10), close: punto(6, 14) }, // sábado
      { open: punto(1, 10), close: punto(1, 14) }, // lunes
    ]);

    expect(tramos.map((t) => t.weekday)).toEqual(["lunes", "sabado", "domingo"]);
  });

  /** Un negocio abierto 24hs: Google manda `open` y omite `close`. */
  it("descarta un period sin cierre", () => {
    expect(periodsATramos([{ open: punto(1, 0) }])).toEqual([]);
  });

  /**
   * Abre el lunes a la noche y cierra el martes de madrugada. No se puede
   * representar en un horario semanal por día, y partirlo en dos inventaría
   * tramos que el negocio no declaró.
   */
  it("descarta un tramo que cruza la medianoche", () => {
    expect(periodsATramos([{ open: punto(1, 20), close: punto(2, 2) }])).toEqual([]);
  });

  it("descarta un tramo que termina antes de empezar", () => {
    expect(periodsATramos([{ open: punto(1, 18), close: punto(1, 9) }])).toEqual([]);
  });

  it("descarta horas fuera de rango", () => {
    expect(periodsATramos([{ open: punto(1, 25), close: punto(1, 26) }])).toEqual([]);
    expect(periodsATramos([{ open: { day: 1, hour: 9, minute: 99 }, close: punto(1, 18) }])).toEqual([]);
  });

  it("no rompe si Google no manda horario", () => {
    expect(periodsATramos(undefined)).toEqual([]);
    expect(periodsATramos([])).toEqual([]);
  });

  it("descarta lo que no tenga día", () => {
    expect(periodsATramos([{ open: { hour: 9 }, close: { hour: 18 } }])).toEqual([]);
  });
});
