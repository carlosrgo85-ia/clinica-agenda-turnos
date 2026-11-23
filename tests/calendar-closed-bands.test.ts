import { describe, expect, it } from "vitest";
import { bandasCerradas, unirDisponibilidades } from "../frontend/src/lib/closed-bands";

/**
 * Las franjas que la Agenda pinta como cerradas.
 *
 * Es el complemento de los tramos de atención: el hueco del mediodía, lo de
 * antes de abrir, lo de después de cerrar, y el día entero cuando es feriado.
 * Los tramos salen de `getEffectiveIntervalsForRange()` —la misma función que
 * valida los turnos—, así que lo que se pinta cerrado es exactamente lo que
 * `booking.ts` rechaza.
 */

const APERTURA = 9 * 60; // 09:00
const CIERRE = 18 * 60; // 18:00

describe("bandasCerradas", () => {
  it("marca el hueco del mediodía entre dos tramos", () => {
    const bandas = bandasCerradas(
      {
        tramos: [
          { startMinute: 540, endMinute: 780 }, // 09:00–13:00
          { startMinute: 840, endMinute: 1080 }, // 14:00–18:00
        ],
        cerrado: false,
        motivo: null,
      },
      APERTURA,
      CIERRE
    );

    expect(bandas).toEqual([{ startMinute: 780, endMinute: 840 }]);
  });

  /** Un feriado: la columna entera. */
  it("cubre todo el día cuando está cerrado", () => {
    const bandas = bandasCerradas(
      { tramos: [], cerrado: true, motivo: "Día de la Independencia" },
      APERTURA,
      CIERRE
    );

    expect(bandas).toEqual([{ startMinute: APERTURA, endMinute: CIERRE }]);
  });

  it("marca lo de antes de abrir y lo de después de cerrar", () => {
    // La grilla va de 09:00 a 18:00 pero este profesional atiende 10 a 16.
    const bandas = bandasCerradas(
      { tramos: [{ startMinute: 600, endMinute: 960 }], cerrado: false, motivo: null },
      APERTURA,
      CIERRE
    );

    expect(bandas).toEqual([
      { startMinute: 540, endMinute: 600 },
      { startMinute: 960, endMinute: 1080 },
    ]);
  });

  it("no marca nada si se atiende toda la grilla", () => {
    const bandas = bandasCerradas(
      { tramos: [{ startMinute: APERTURA, endMinute: CIERRE }], cerrado: false, motivo: null },
      APERTURA,
      CIERRE
    );

    expect(bandas).toEqual([]);
  });

  it("recorta los tramos que se salen de la grilla", () => {
    const bandas = bandasCerradas(
      { tramos: [{ startMinute: 0, endMinute: 24 * 60 }], cerrado: false, motivo: null },
      APERTURA,
      CIERRE
    );

    expect(bandas).toEqual([]);
  });

  it("ordena los tramos antes de calcular", () => {
    const bandas = bandasCerradas(
      {
        tramos: [
          { startMinute: 840, endMinute: 1080 },
          { startMinute: 540, endMinute: 780 },
        ],
        cerrado: false,
        motivo: null,
      },
      APERTURA,
      CIERRE
    );

    expect(bandas).toEqual([{ startMinute: 780, endMinute: 840 }]);
  });

  /**
   * Sin dato no se pinta nada: una grilla neutra es mejor que una que diga
   * "cerrado" porque la respuesta no trajo la disponibilidad.
   */
  it("no inventa nada si no hay disponibilidad", () => {
    expect(bandasCerradas(undefined, APERTURA, CIERRE)).toEqual([]);
  });
});

describe("unirDisponibilidades (la Agenda en \"Todos\")", () => {
  const abierto = (...t: Array<[number, number]>) => ({
    tramos: t.map(([startMinute, endMinute]) => ({ startMinute, endMinute })),
    cerrado: false,
    motivo: null,
  });
  const cerrado = (motivo: string | null = null) => ({ tramos: [], cerrado: true, motivo });

  it("sin ninguna disponibilidad no pinta nada (grilla neutra)", () => {
    expect(unirDisponibilidades([])).toBeUndefined();
  });

  it("un feriado de la clínica cierra a todos: el día entero queda cerrado y trae el motivo", () => {
    const u = unirDisponibilidades([cerrado("Año Nuevo"), cerrado("Año Nuevo")])!;
    expect(u).toEqual({ tramos: [], cerrado: true, motivo: "Año Nuevo" });
    expect(bandasCerradas(u, APERTURA, CIERRE)).toEqual([{ startMinute: APERTURA, endMinute: CIERRE }]);
  });

  it("si uno solo está cerrado (vacaciones) y otro atiende, el día NO se pinta cerrado", () => {
    const u = unirDisponibilidades([cerrado(), abierto([540, 1080])])!;
    expect(u.cerrado).toBe(false);
    expect(bandasCerradas(u, APERTURA, CIERRE)).toEqual([]);
  });

  it("une tramos que se tocan o se pisan, y deja el hueco que ninguno cubre", () => {
    const u = unirDisponibilidades([abierto([540, 780]), abierto([700, 900]), abierto([960, 1080])])!;
    expect(u.tramos).toEqual([
      { startMinute: 540, endMinute: 900 },
      { startMinute: 960, endMinute: 1080 },
    ]);
    expect(bandasCerradas(u, APERTURA, CIERRE)).toEqual([{ startMinute: 900, endMinute: 960 }]);
  });
});
