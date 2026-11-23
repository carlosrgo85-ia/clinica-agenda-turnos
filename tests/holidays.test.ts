import { describe, expect, it } from "vitest";
import {
  easterSunday,
  holidaysForCountry,
  relevantHolidayYears,
} from "../src/services/holidays";
import { suggestCountryFromTimezone } from "../src/data/holidays";
import { isSupportedCountry, supportedCountries } from "../src/repositories/countries.repository";

/**
 * El catálogo de feriados calcula fechas, y una fecha mal calculada se
 * traduce en una clínica cerrada el día equivocado. Se valida contra
 * fechas conocidas. Corre contra Postgres (el catálogo vive en las tablas
 * Country/HolidayRule, sembradas por `prisma/seed.ts`).
 */
describe("easterSunday", () => {
  // Domingos de Pascua reales, para verificar el algoritmo gregoriano.
  const conocidos: Array<[number, number, number]> = [
    [2024, 3, 31],
    [2025, 4, 20],
    [2026, 4, 5],
    [2027, 3, 28],
    [2028, 4, 16],
    [2029, 4, 1],
    [2030, 4, 21],
    [2031, 4, 13],
    [2032, 3, 28],
    [2033, 4, 17],
  ];

  for (const [year, month, day] of conocidos) {
    it(`${year} → ${month}/${day}`, () => {
      expect(easterSunday(year)).toEqual({ month, day });
    });
  }
});

describe("feriados relativos a Pascua", () => {
  it("Viernes Santo cae dos días antes de Pascua", async () => {
    // Pascua 2026 es el 5 de abril, así que el Viernes Santo es el 3.
    const feriados = await holidaysForCountry("AR", 2026);
    const viernesSanto = feriados.find((f) => f.name === "Viernes Santo");
    expect(viernesSanto?.dateKey).toBe("2026-04-03");
  });

  it("Carnaval cae 48 y 47 días antes de Pascua", async () => {
    // 48 días antes del 5 de abril de 2026 es el 16 de febrero.
    const feriados = await holidaysForCountry("AR", 2026);
    expect(feriados.find((f) => f.name === "Lunes de Carnaval")?.dateKey).toBe("2026-02-16");
    expect(feriados.find((f) => f.name === "Martes de Carnaval")?.dateKey).toBe("2026-02-17");
  });

  it("resuelve bien cuando el offset cruza de mes", async () => {
    // Pascua 2024 es el 31 de marzo: el Viernes Santo cae el 29 de marzo, y
    // Carnaval en febrero.
    const feriados = await holidaysForCountry("AR", 2024);
    expect(feriados.find((f) => f.name === "Viernes Santo")?.dateKey).toBe("2024-03-29");
    expect(feriados.find((f) => f.name === "Lunes de Carnaval")?.dateKey).toBe("2024-02-12");
  });
});

describe("feriados en el enésimo día de la semana", () => {
  it("el tercer lunes de marzo de 2026 es el 16", async () => {
    // Marzo de 2026 arranca un domingo: los lunes son 2, 9, 16, 23 y 30.
    const feriados = await holidaysForCountry("MX", 2026);
    const juarez = feriados.find((f) => f.name === "Natalicio de Benito Juárez");
    expect(juarez?.dateKey).toBe("2026-03-16");
  });

  it("el primer lunes de febrero de 2026 es el 2", async () => {
    // Febrero de 2026 arranca un domingo.
    const feriados = await holidaysForCountry("MX", 2026);
    expect(feriados.find((f) => f.name === "Día de la Constitución")?.dateKey).toBe(
      "2026-02-02"
    );
  });

  it("el tercer lunes de noviembre de 2026 es el 16", async () => {
    // Noviembre de 2026 arranca un domingo: lunes 2, 9, 16.
    const feriados = await holidaysForCountry("MX", 2026);
    expect(feriados.find((f) => f.name === "Revolución Mexicana")?.dateKey).toBe(
      "2026-11-16"
    );
  });

  it("el último lunes de mayo es el cuarto o el quinto según el año", async () => {
    // El Memorial Day de Estados Unidos es el ÚLTIMO lunes de mayo
    // (`ordinal: -1`), no el cuarto: en 2027 mayo tiene cinco lunes y el
    // feriado cae el 31. Cargado como "cuarto lunes" estaría mal uno de cada
    // tantos años, y como fecha fija estaría mal casi siempre.
    const esperados: Array<[number, string]> = [
      [2026, "2026-05-25"], // cuatro lunes: 4, 11, 18, 25
      [2027, "2027-05-31"], // cinco lunes: 3, 10, 17, 24, 31
      [2028, "2028-05-29"],
      [2032, "2032-05-31"],
    ];

    for (const [year, dateKey] of esperados) {
      const feriados = await holidaysForCountry("US", year);
      expect(feriados.find((f) => f.name === "Día de los Caídos")?.dateKey).toBe(dateKey);
    }
  });

  it("el cuarto jueves de noviembre no es el último", async () => {
    // Thanksgiving es el CUARTO jueves, y noviembre puede tener cinco: si se
    // cargara como "el último", en esos años caería una semana tarde.
    expect(
      (await holidaysForCountry("US", 2029)).find((f) => f.name === "Día de Acción de Gracias")
        ?.dateKey
    ).toBe("2029-11-22"); // jueves 1, 8, 15, 22 y 29
  });

  it("acierta cuando el mes arranca justo en el día buscado", async () => {
    // Junio de 2026 arranca un lunes, así que el primer lunes es el día 1.
    // Se verifica con marzo de 2027, que arranca un lunes: el tercer lunes
    // es el 15.
    const feriados = await holidaysForCountry("MX", 2027);
    expect(feriados.find((f) => f.name === "Natalicio de Benito Juárez")?.dateKey).toBe(
      "2027-03-15"
    );
  });
});

describe("feriados de fecha fija", () => {
  it("incluye los inamovibles de Argentina", async () => {
    const feriados = await holidaysForCountry("AR", 2026);
    const porFecha = new Map(feriados.map((f) => [f.dateKey, f.name]));

    expect(porFecha.get("2026-01-01")).toBe("Año Nuevo");
    expect(porFecha.get("2026-05-01")).toBe("Día del Trabajador");
    expect(porFecha.get("2026-07-09")).toBe("Día de la Independencia");
    expect(porFecha.get("2026-12-25")).toBe("Navidad");
  });

  it("incluye los obligatorios de México", async () => {
    const porFecha = new Map(
      (await holidaysForCountry("MX", 2026)).map((f) => [f.dateKey, f.name])
    );
    expect(porFecha.get("2026-09-16")).toBe("Día de la Independencia");
    expect(porFecha.get("2026-12-25")).toBe("Navidad");
  });

  it("devuelve las fechas ordenadas", async () => {
    const feriados = await holidaysForCountry("AR", 2026);
    const ordenadas = [...feriados].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    expect(feriados).toEqual(ordenadas);
  });

  it("todas las fechas tienen formato YYYY-MM-DD válido", async () => {
    for (const country of await supportedCountries()) {
      for (const year of [2026, 2027, 2030]) {
        for (const feriado of await holidaysForCountry(country.id, year)) {
          expect(feriado.dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(Number.isNaN(new Date(`${feriado.dateKey}T00:00:00Z`).getTime())).toBe(false);
        }
      }
    }
  });

  it("no repite fechas dentro de un mismo país y año", async () => {
    for (const country of await supportedCountries()) {
      const fechas = (await holidaysForCountry(country.id, 2026)).map((f) => f.dateKey);
      expect(new Set(fechas).size).toBe(fechas.length);
    }
  });
});

describe("precarga del año siguiente", () => {
  it("durante el año solo importa el año en curso", () => {
    for (const mes of [0, 1, 5, 8, 10]) {
      const now = new Date(Date.UTC(2026, mes, 15));
      expect(relevantHolidayYears(now)).toEqual([2026]);
    }
  });

  it("en diciembre suma el año siguiente", () => {
    // El punto: si se espera a enero, el asistente ofrece turnos el Año
    // Nuevo porque el feriado todavía no está cargado.
    const now = new Date(Date.UTC(2026, 11, 1));
    expect(relevantHolidayYears(now)).toEqual([2026, 2027]);
  });

  it("sigue sumándolo a fin de diciembre", () => {
    const now = new Date(Date.UTC(2026, 11, 31));
    expect(relevantHolidayYears(now)).toEqual([2026, 2027]);
  });

  it("vuelve a un solo año el 1 de enero", () => {
    const now = new Date(Date.UTC(2027, 0, 1));
    expect(relevantHolidayYears(now)).toEqual([2027]);
  });

  it("el año siguiente tiene feriados calculables", async () => {
    // Los años que devuelve relevantHolidayYears tienen que resolver a
    // fechas reales, no a listas vacías.
    const now = new Date(Date.UTC(2026, 11, 15));
    for (const year of relevantHolidayYears(now)) {
      expect((await holidaysForCountry("AR", year)).length).toBeGreaterThan(0);
    }
  });
});

describe("países", () => {
  it("un país sin catálogo devuelve lista vacía", async () => {
    expect(await holidaysForCountry("JP", 2026)).toEqual([]);
    expect(await isSupportedCountry("JP")).toBe(false);
  });

  it("no distingue mayúsculas", async () => {
    expect((await holidaysForCountry("ar", 2026)).length).toBeGreaterThan(0);
    expect(await isSupportedCountry("mx")).toBe(true);
  });

  it("sugiere el país desde la zona horaria", () => {
    expect(suggestCountryFromTimezone("America/Argentina/Buenos_Aires")).toBe("AR");
    expect(suggestCountryFromTimezone("America/Argentina/Cordoba")).toBe("AR");
    expect(suggestCountryFromTimezone("America/Mexico_City")).toBe("MX");
    expect(suggestCountryFromTimezone("America/Cancun")).toBe("MX");
  });

  it("no adivina cuando no sabe", () => {
    expect(suggestCountryFromTimezone("Europe/Madrid")).toBeNull();
    expect(suggestCountryFromTimezone("UTC")).toBeNull();
  });
});
