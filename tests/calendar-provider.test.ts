import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listCalendarBlocks,
  mirrorAppointmentToCalendar,
  removeMirroredEvent,
  resolveCalendarTargetForProfessional,
} from "../src/services/calendar";
import { googleCalendarProvider } from "../src/services/calendar-providers/google";
import type { CalendarTarget } from "../src/services/calendar";

/**
 * `services/calendar.ts` despacha por `target.provider`: quien agenda no sabe
 * qué sistema hay detrás. Acá se verifica el despacho y que el target
 * siempre diga de qué proveedor es.
 */

const target: CalendarTarget = { provider: "google", calendarId: "cal-1", account: null };

afterEach(() => vi.restoreAllMocks());

describe("resolveCalendarTargetForProfessional", () => {
  it("el calendario compartido de la clínica manda sobre el del profesional", () => {
    const t = resolveCalendarTargetForProfessional(
      { sharedCalendarId: "compartido" },
      { googleCalendarId: "personal" }
    );
    expect(t).toMatchObject({ provider: "google", calendarId: "compartido" });
  });

  it("sin compartido usa el personal, con su proveedor", () => {
    const t = resolveCalendarTargetForProfessional(
      { sharedCalendarId: null },
      { googleCalendarId: "personal" }
    );
    expect(t).toMatchObject({ provider: "google", calendarId: "personal" });
  });

  it("devuelve null si no hay ningún calendario enlazado", () => {
    expect(
      resolveCalendarTargetForProfessional({ sharedCalendarId: null }, { googleCalendarId: null })
    ).toBeNull();
  });
});

describe("despacho al proveedor", () => {
  it("mirrorAppointmentToCalendar separa el target del resto y devuelve el id", async () => {
    const spy = vi.spyOn(googleCalendarProvider, "createEvent").mockResolvedValue("evt-1");
    const id = await mirrorAppointmentToCalendar({
      target,
      appointmentId: "a1",
      clinicId: "c1",
      patientName: "Ana",
      professionalName: "Gómez",
      service: "Limpieza",
      startTime: "2030-01-01T10:00:00Z",
      endTime: "2030-01-01T10:30:00Z",
    });
    expect(id).toBe("evt-1");
    expect(spy).toHaveBeenCalledOnce();
    const [recibidoTarget, evento] = spy.mock.calls[0];
    expect(recibidoTarget).toBe(target);
    expect(evento).not.toHaveProperty("target");
    expect(evento).toMatchObject({ appointmentId: "a1", service: "Limpieza" });
  });

  it("removeMirroredEvent y listCalendarBlocks llegan al proveedor", async () => {
    const del = vi.spyOn(googleCalendarProvider, "deleteEvent").mockResolvedValue();
    const list = vi.spyOn(googleCalendarProvider, "listBlocks").mockResolvedValue([]);
    const from = new Date("2030-01-01");
    const to = new Date("2030-01-15");

    await removeMirroredEvent(target, "evt-1");
    await expect(listCalendarBlocks(target, from, to)).resolves.toEqual([]);

    expect(del).toHaveBeenCalledWith(target, "evt-1");
    expect(list).toHaveBeenCalledWith(target, from, to);
  });

  it("un proveedor desconocido falla con un mensaje claro", async () => {
    const raro = { ...target, provider: "outlook" } as unknown as CalendarTarget;
    await expect(removeMirroredEvent(raro, "x")).rejects.toThrow(/desconocido/);
  });
});
