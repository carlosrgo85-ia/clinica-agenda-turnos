import { describe, expect, it } from "vitest";
import {
  addDaysToDateKey,
  addMinutes,
  clinicWallTimeToUtc,
  dateKeyToUtcMidnight,
  formatWallTime,
  weekdayFromDateKey,
} from "../src/services/time";

/**
 * La hora que dice el paciente es hora de pared de la clínica. Si esto se
 * convierte mal, el turno queda guardado con horas de corrimiento y el
 * recordatorio sale a cualquier hora.
 */
describe("clinicWallTimeToUtc", () => {
  it("convierte desde una zona sin horario de verano", () => {
    // Buenos Aires es UTC-3 todo el año.
    const result = clinicWallTimeToUtc("2026-06-15", "10:00", "America/Argentina/Buenos_Aires");
    expect(result?.toISOString()).toBe("2026-06-15T13:00:00.000Z");
  });

  it("respeta el horario de invierno", () => {
    // Nueva York en enero es EST, UTC-5.
    const result = clinicWallTimeToUtc("2026-01-15", "10:00", "America/New_York");
    expect(result?.toISOString()).toBe("2026-01-15T15:00:00.000Z");
  });

  it("respeta el horario de verano", () => {
    // La misma hora de pared en julio es EDT, UTC-4: una hora menos de
    // offset. Si el cálculo usara un offset fijo, esto daría mal.
    const result = clinicWallTimeToUtc("2026-07-15", "10:00", "America/New_York");
    expect(result?.toISOString()).toBe("2026-07-15T14:00:00.000Z");
  });

  it("trata UTC como caso trivial", () => {
    const result = clinicWallTimeToUtc("2026-06-15", "10:00", "UTC");
    expect(result?.toISOString()).toBe("2026-06-15T10:00:00.000Z");
  });

  it("rechaza una hora que no existe por el cambio de horario", () => {
    // En 2026 el horario de verano de EEUU arranca el 8 de marzo: a las
    // 02:00 los relojes saltan a las 03:00, así que las 02:30 no existen.
    // Devolver un instante cualquiera sería peor que rechazar.
    const result = clinicWallTimeToUtc("2026-03-08", "02:30", "America/New_York");
    expect(result).toBeNull();
  });

  it("acepta la hora del cambio que sí existe", () => {
    const result = clinicWallTimeToUtc("2026-03-08", "04:00", "America/New_York");
    expect(result?.toISOString()).toBe("2026-03-08T08:00:00.000Z");
  });

  it("maneja la medianoche", () => {
    const result = clinicWallTimeToUtc("2026-06-15", "00:00", "America/Argentina/Buenos_Aires");
    expect(result?.toISOString()).toBe("2026-06-15T03:00:00.000Z");
  });

  it("acepta la hora sin cero adelante", () => {
    const result = clinicWallTimeToUtc("2026-06-15", "9:30", "UTC");
    expect(result?.toISOString()).toBe("2026-06-15T09:30:00.000Z");
  });

  it("rechaza formatos que no son fecha u hora", () => {
    expect(clinicWallTimeToUtc("15/06/2026", "10:00", "UTC")).toBeNull();
    expect(clinicWallTimeToUtc("2026-06-15", "10hs", "UTC")).toBeNull();
    expect(clinicWallTimeToUtc("mañana", "10:00", "UTC")).toBeNull();
    expect(clinicWallTimeToUtc("", "", "UTC")).toBeNull();
  });

  it("rechaza valores fuera de rango", () => {
    expect(clinicWallTimeToUtc("2026-13-15", "10:00", "UTC")).toBeNull();
    expect(clinicWallTimeToUtc("2026-06-15", "25:00", "UTC")).toBeNull();
    expect(clinicWallTimeToUtc("2026-06-15", "10:75", "UTC")).toBeNull();
  });
});

describe("formatWallTime", () => {
  it("devuelve la hora de pared en la zona pedida", () => {
    const instant = new Date("2026-06-15T13:00:00.000Z");
    expect(formatWallTime(instant, "America/Argentina/Buenos_Aires")).toBe("10:00");
    expect(formatWallTime(instant, "UTC")).toBe("13:00");
  });
});

describe("addMinutes", () => {
  it("suma minutos sin tocar la zona", () => {
    const start = new Date("2026-06-15T13:00:00.000Z");
    expect(addMinutes(start, 45).toISOString()).toBe("2026-06-15T13:45:00.000Z");
  });

  it("cruza el límite de hora", () => {
    const start = new Date("2026-06-15T13:40:00.000Z");
    expect(addMinutes(start, 30).toISOString()).toBe("2026-06-15T14:10:00.000Z");
  });
});

/**
 * Recorrer días de calendario para enumerar huecos. Se hace sobre la
 * representación date-only porque en UTC no hay horario de verano: sumarle
 * 24hs a un instante local daría mal el día del cambio de hora.
 */
describe("addDaysToDateKey", () => {
  it("avanza un día", () => {
    expect(addDaysToDateKey("2030-06-17", 1)).toBe("2030-06-18");
  });

  it("cruza el fin de mes", () => {
    expect(addDaysToDateKey("2030-06-30", 1)).toBe("2030-07-01");
  });

  it("cruza el fin de año", () => {
    expect(addDaysToDateKey("2030-12-31", 1)).toBe("2031-01-01");
  });

  it("contempla el 29 de febrero de un bisiesto", () => {
    expect(addDaysToDateKey("2032-02-28", 1)).toBe("2032-02-29");
    expect(addDaysToDateKey("2031-02-28", 1)).toBe("2031-03-01");
  });

  it("retrocede con días negativos", () => {
    expect(addDaysToDateKey("2030-01-01", -1)).toBe("2029-12-31");
  });

  it("devuelve null si la fecha no tiene forma de fecha", () => {
    expect(addDaysToDateKey("17/06/2030", 1)).toBeNull();
  });
});

describe("weekdayFromDateKey", () => {
  it("devuelve el día de la semana en castellano", () => {
    expect(weekdayFromDateKey("2030-06-17")).toBe("lunes");
    expect(weekdayFromDateKey("2030-06-22")).toBe("sabado");
    expect(weekdayFromDateKey("2030-06-23")).toBe("domingo");
  });

  it("devuelve null si la fecha no tiene forma de fecha", () => {
    expect(weekdayFromDateKey("lunes")).toBeNull();
  });

  it("rechaza un día imposible en vez de correrlo al mes siguiente", () => {
    // Antes `dateKeyToUtcMidnight()` dejaba que el 31 de febrero cayera en marzo; ahora devuelve null.
    expect(weekdayFromDateKey("2030-02-31")).toBeNull();
  });
});

describe("dateKeyToUtcMidnight rechaza los días que no existen", () => {
  it("devuelve la medianoche UTC de una fecha válida, incluido el 29 de febrero de un año bisiesto", () => {
    expect(dateKeyToUtcMidnight("2030-06-12")?.toISOString()).toBe("2030-06-12T00:00:00.000Z");
    expect(dateKeyToUtcMidnight("2028-02-29")?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(dateKeyToUtcMidnight(" 2030-12-31 ")?.toISOString()).toBe("2030-12-31T00:00:00.000Z");
  });

  it("no corre en silencio al mes siguiente un día imposible", () => {
    for (const k of ["2030-02-31", "2030-02-30", "2030-02-29", "2029-02-29", "2030-04-31", "2030-06-31", "2030-09-31", "2030-11-31"]) {
      expect(dateKeyToUtcMidnight(k), k).toBeNull();
    }
  });

  it("sigue rechazando lo que no es una fecha", () => {
    for (const k of ["", "ayer", "2030-13-01", "2030-00-10", "2030-01-00", "2030-1-5", "2030-06-12T10:00"]) {
      expect(dateKeyToUtcMidnight(k), k).toBeNull();
    }
  });

  it("las funciones que dependen de ella tampoco inventan un día", () => {
    expect(addDaysToDateKey("2030-02-31", 1)).toBeNull();
    expect(weekdayFromDateKey("2030-02-31")).toBeNull();
  });
});
