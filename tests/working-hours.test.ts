import { describe, expect, it } from "vitest";
import {
  fitsInSomeInterval,
  intersectIntervals,
  validateWorkingHours,
  type Interval,
} from "../src/services/working-hours";

/** Lunes a viernes de 9 a 13 y de 14 a 18: el corte de comida es el hueco. */
const CON_CORTE: Interval[] = [
  { startMinute: 9 * 60, endMinute: 13 * 60 },
  { startMinute: 14 * 60, endMinute: 18 * 60 },
];

const CORRIDO: Interval[] = [{ startMinute: 9 * 60, endMinute: 18 * 60 }];

describe("fitsInSomeInterval", () => {
  it("acepta un turno dentro del tramo de la mañana", () => {
    // 10:00 a 10:30
    expect(fitsInSomeInterval(CON_CORTE, 600, 630)).toBe(true);
  });

  it("acepta un turno dentro del tramo de la tarde", () => {
    // 15:00 a 15:30
    expect(fitsInSomeInterval(CON_CORTE, 900, 930)).toBe(true);
  });

  it("rechaza un turno en el horario de comida", () => {
    // 13:15 a 13:45, justo en el hueco de 13 a 14.
    expect(fitsInSomeInterval(CON_CORTE, 795, 825)).toBe(false);
  });

  it("rechaza un turno que pisa el arranque de la comida", () => {
    // 12:45 a 13:15 — empieza dentro del tramo pero termina en el corte.
    expect(fitsInSomeInterval(CON_CORTE, 765, 795)).toBe(false);
  });

  it("rechaza un turno que cruza la comida de punta a punta", () => {
    // 12:30 a 14:30. Entra "entre" los dos tramos pero atendería durante la
    // comida, así que tiene que caber en UNO solo.
    expect(fitsInSomeInterval(CON_CORTE, 750, 870)).toBe(false);
  });

  it("acepta un turno que termina justo cuando arranca la comida", () => {
    // 12:30 a 13:00 — el borde es válido.
    expect(fitsInSomeInterval(CON_CORTE, 750, 780)).toBe(true);
  });

  it("acepta un turno que arranca justo cuando termina la comida", () => {
    // 14:00 a 14:30
    expect(fitsInSomeInterval(CON_CORTE, 840, 870)).toBe(true);
  });

  it("rechaza un turno antes de abrir y después de cerrar", () => {
    expect(fitsInSomeInterval(CON_CORTE, 480, 510)).toBe(false); // 08:00
    expect(fitsInSomeInterval(CON_CORTE, 1080, 1110)).toBe(false); // 18:00 a 18:30
  });

  it("acepta el turno que termina exactamente al cierre", () => {
    // 17:30 a 18:00
    expect(fitsInSomeInterval(CON_CORTE, 1050, 1080)).toBe(true);
  });

  it("en un horario corrido sí acepta el mediodía", () => {
    expect(fitsInSomeInterval(CORRIDO, 795, 825)).toBe(true);
  });

  it("un día sin tramos no acepta nada", () => {
    expect(fitsInSomeInterval([], 600, 630)).toBe(false);
  });
});

describe("validateWorkingHours", () => {
  it("acepta un horario con corte de comida", () => {
    expect(
      validateWorkingHours([
        { weekday: "lunes", startMinute: 540, endMinute: 780 },
        { weekday: "lunes", startMinute: 840, endMinute: 1080 },
      ])
    ).toEqual([]);
  });

  it("acepta tramos pegados de días distintos", () => {
    expect(
      validateWorkingHours([
        { weekday: "lunes", startMinute: 540, endMinute: 1080 },
        { weekday: "martes", startMinute: 540, endMinute: 1080 },
      ])
    ).toEqual([]);
  });

  it("rechaza un tramo que termina antes de empezar", () => {
    const errores = validateWorkingHours([
      { weekday: "lunes", startMinute: 1080, endMinute: 540 },
    ]);
    expect(errores).toHaveLength(1);
    expect(errores[0]).toContain("posterior al inicio");
  });

  it("rechaza un tramo de duración cero", () => {
    const errores = validateWorkingHours([
      { weekday: "lunes", startMinute: 540, endMinute: 540 },
    ]);
    expect(errores).toHaveLength(1);
  });

  it("rechaza tramos solapados del mismo día", () => {
    const errores = validateWorkingHours([
      { weekday: "lunes", startMinute: 540, endMinute: 800 },
      { weekday: "lunes", startMinute: 780, endMinute: 1080 },
    ]);
    expect(errores).toHaveLength(1);
    expect(errores[0]).toContain("se solapan");
  });

  it("no confunde solapamiento con tramos contiguos", () => {
    // 09:00-13:00 y 13:00-18:00 se tocan pero no se pisan.
    expect(
      validateWorkingHours([
        { weekday: "lunes", startMinute: 540, endMinute: 780 },
        { weekday: "lunes", startMinute: 780, endMinute: 1080 },
      ])
    ).toEqual([]);
  });

  it("rechaza minutos fuera del rango de un día", () => {
    expect(
      validateWorkingHours([{ weekday: "lunes", startMinute: -60, endMinute: 540 }])
    ).not.toEqual([]);
    expect(
      validateWorkingHours([{ weekday: "lunes", startMinute: 540, endMinute: 1500 }])
    ).not.toEqual([]);
  });

  it("rechaza minutos no enteros", () => {
    const errores = validateWorkingHours([
      { weekday: "lunes", startMinute: 540.5, endMinute: 1080 },
    ]);
    expect(errores).toHaveLength(1);
    expect(errores[0]).toContain("enteros");
  });

  it("acepta una lista vacía (un profesional que vuelve a heredar)", () => {
    expect(validateWorkingHours([])).toEqual([]);
  });
});

/**
 * La intersección es lo que permite ENUMERAR huecos. `fitsInSomeInterval`
 * alcanza para validar un turno puntual contra cada nivel por separado, pero
 * para ofrecer horarios hace falta la lista de ratos realmente hábiles.
 */
describe("intersectIntervals", () => {
  it("recorta al más restrictivo de los dos lados", () => {
    expect(
      intersectIntervals(
        [{ startMinute: 9 * 60, endMinute: 18 * 60 }],
        [{ startMinute: 8 * 60, endMinute: 12 * 60 }]
      )
    ).toEqual([{ startMinute: 9 * 60, endMinute: 12 * 60 }]);
  });

  it("mantiene el tramo contenido", () => {
    expect(
      intersectIntervals(
        [{ startMinute: 9 * 60, endMinute: 18 * 60 }],
        [{ startMinute: 10 * 60, endMinute: 11 * 60 }]
      )
    ).toEqual([{ startMinute: 10 * 60, endMinute: 11 * 60 }]);
  });

  it("devuelve vacío si los tramos no se cruzan", () => {
    expect(
      intersectIntervals(
        [{ startMinute: 9 * 60, endMinute: 12 * 60 }],
        [{ startMinute: 14 * 60, endMinute: 18 * 60 }]
      )
    ).toEqual([]);
  });

  it("dos tramos que apenas se tocan no dejan intersección", () => {
    // Un turno no puede durar cero minutos.
    expect(
      intersectIntervals(
        [{ startMinute: 13 * 60, endMinute: 14 * 60 }],
        [{ startMinute: 14 * 60, endMinute: 18 * 60 }]
      )
    ).toEqual([]);
  });

  it("cruza varios tramos de cada lado", () => {
    expect(intersectIntervals(CON_CORTE, [{ startMinute: 11 * 60, endMinute: 15 * 60 }])).toEqual([
      { startMinute: 11 * 60, endMinute: 13 * 60 },
      { startMinute: 14 * 60, endMinute: 15 * 60 },
    ]);
  });

  it("con un lado vacío no hay nada hábil", () => {
    expect(intersectIntervals(CON_CORTE, [])).toEqual([]);
    expect(intersectIntervals([], CON_CORTE)).toEqual([]);
  });
});
