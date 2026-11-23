import { describe, expect, it } from "vitest";
import { gridLimits } from "../src/services/agenda-grid";

const TZ = "America/Mexico_City"; // UTC-6 todo el año desde 2022
const HORARIO = [{ startMinute: 9 * 60, endMinute: 18 * 60 }];
/** Una hora de pared de México como instante UTC. */
const mx = (hhmm: string, dia = "2026-12-10") => new Date(`${dia}T${hhmm}:00-06:00`);

describe("los límites de la grilla de la Agenda", () => {
  it("sin nada fuera de horario, son los del horario de la clínica", () => {
    expect(gridLimits({ workingHours: HORARIO, timezone: TZ, events: [{ startTime: mx("10:00"), endTime: mx("11:00") }] })).toEqual({
      desdeMinuto: 540, hastaMinuto: 1080,
    });
  });

  it("una cita a las 20:30 (fuera de horario, guardada confirmando) estira la grilla para que se vea", () => {
    const l = gridLimits({ workingHours: HORARIO, timezone: TZ, events: [{ startTime: mx("20:30"), endTime: mx("21:30") }] });
    expect(l.hastaMinuto).toBe(22 * 60);
    expect(l.desdeMinuto).toBe(540);
  });

  it("una cita antes de abrir estira el inicio, redondeado a la hora", () => {
    const l = gridLimits({ workingHours: HORARIO, timezone: TZ, events: [{ startTime: mx("07:15"), endTime: mx("07:45") }] });
    expect(l.desdeMinuto).toBe(7 * 60);
  });

  it("usa la hora de la clínica, no la del servidor (a las 02:00 UTC es 20:00 del día anterior en México)", () => {
    const l = gridLimits({ workingHours: HORARIO, timezone: TZ, events: [{ startTime: new Date("2026-12-11T02:00:00Z"), endTime: new Date("2026-12-11T03:00:00Z") }] });
    expect(l.hastaMinuto).toBe(21 * 60);
  });

  it("un evento que cruza la medianoche se corta en las 24:00", () => {
    const l = gridLimits({ workingHours: HORARIO, timezone: TZ, events: [{ startTime: mx("22:00", "2026-12-10"), endTime: mx("02:00", "2026-12-11") }] });
    expect(l.hastaMinuto).toBe(24 * 60);
  });

  it("sin horario cargado parte de una jornada razonable y también se estira", () => {
    expect(gridLimits({ workingHours: [], timezone: TZ, events: [] })).toEqual({ desdeMinuto: 480, hastaMinuto: 1200 });
    expect(gridLimits({ workingHours: [], timezone: TZ, events: [{ startTime: mx("21:00"), endTime: mx("22:00") }] }).hastaMinuto).toBe(22 * 60);
  });
});
