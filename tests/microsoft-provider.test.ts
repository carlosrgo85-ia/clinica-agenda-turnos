import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MicrosoftAccount } from "@prisma/client";

const update = vi.fn();
vi.mock("../src/db/client", () => ({
  prisma: {
    microsoftAccount: { update: (...args: unknown[]) => update(...args) },
    // Sin secreto guardado en la base: se usa el del entorno de test.
    platformSecret: { findUnique: async () => null },
  },
}));

import { encryptToken } from "../src/services/crypto";
import { MicrosoftAuthError, getMicrosoftAccessToken } from "../src/services/microsoft-auth";
import { microsoftCalendarProvider, listAvailableMicrosoftCalendars } from "../src/services/calendar-providers/microsoft";
import { resolveCalendarTargetForProfessional } from "../src/services/calendar";
import type { CalendarTarget } from "../src/services/calendar";

/**
 * Proveedor de Microsoft 365 con `fetch` simulado: ningún test habla con
 * Microsoft. Lo que se verifica es lo que se rompe en silencio — la forma de
 * los pedidos a Graph, qué eventos cuentan como bloqueo, y que el refresh
 * token ROTADO se guarde.
 */

function account(overrides: Partial<MicrosoftAccount> = {}): MicrosoftAccount {
  return {
    id: "ms1",
    clinicId: "c1",
    email: "agenda@clinica.com",
    refreshTokenEncrypted: encryptToken("refresh-viejo"),
    accessTokenEncrypted: encryptToken("access-vigente"),
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    scope: "Calendars.ReadWrite",
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const target = (acc = account()): CalendarTarget => ({ provider: "microsoft", calendarId: "cal=1/x", account: acc });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  update.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("getMicrosoftAccessToken", () => {
  it("usa el token guardado mientras no venza, sin llamar a Microsoft", async () => {
    await expect(getMicrosoftAccessToken(account())).resolves.toBe("access-vigente");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refresca el que está por vencer y GUARDA el refresh token nuevo (Microsoft los rota)", async () => {
    fetchMock.mockResolvedValue(
      json({ access_token: "access-nuevo", refresh_token: "refresh-nuevo", expires_in: 3600 })
    );
    const vencida = account({ accessTokenExpiresAt: new Date(Date.now() + 30 * 1000) });

    await expect(getMicrosoftAccessToken(vencida)).resolves.toBe("access-nuevo");

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-viejo");
    const data = update.mock.calls[0][0].data;
    expect(data.refreshTokenEncrypted).toBeTruthy();
    expect(data.refreshTokenEncrypted).not.toBe(vencida.refreshTokenEncrypted);
  });

  it("dos pedidos a la vez comparten un solo refresh (el segundo gastaría el token ya rotado)", async () => {
    fetchMock.mockResolvedValue(json({ access_token: "a2", refresh_token: "r2", expires_in: 3600 }));
    const vencida = account({ accessTokenExpiresAt: null, accessTokenEncrypted: null });

    const [a, b] = await Promise.all([getMicrosoftAccessToken(vencida), getMicrosoftAccessToken(vencida)]);

    expect([a, b]).toEqual(["a2", "a2"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalid_grant significa cuenta revocada", async () => {
    fetchMock.mockResolvedValue(json({ error: "invalid_grant", error_description: "x" }, 400));
    const error = await getMicrosoftAccessToken(account({ accessTokenEncrypted: null })).catch((e) => e);
    expect(error).toBeInstanceOf(MicrosoftAuthError);
    expect(error.revoked).toBe(true);
  });

  it("un error transitorio no marca la cuenta como revocada", async () => {
    fetchMock.mockResolvedValue(json({ error: "temporarily_unavailable" }, 503));
    const error = await getMicrosoftAccessToken(account({ accessTokenEncrypted: null })).catch((e) => e);
    expect(error).toBeInstanceOf(MicrosoftAuthError);
    expect(error.revoked).toBe(false);
  });

  it("una cuenta ya revocada no llama a Microsoft", async () => {
    const error = await getMicrosoftAccessToken(account({ revokedAt: new Date() })).catch((e) => e);
    expect(error.revoked).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createEvent", () => {
  it("crea el evento en el calendario (id escapado), en UTC, ocupado y marcado como nuestro", async () => {
    fetchMock.mockResolvedValue(json({ id: "evt-9" }, 201));

    const id = await microsoftCalendarProvider.createEvent(target(), {
      appointmentId: "a1",
      clinicId: "c1",
      patientName: "Ana",
      professionalName: "Gómez",
      service: "Limpieza",
      startTime: "2030-01-01T10:00:00.000Z",
      endTime: "2030-01-01T10:30:00.000Z",
      timezone: "America/Mexico_City",
    });

    expect(id).toBe("evt-9");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/calendars/cal%3D1%2Fx/events");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer access-vigente");
    const body = JSON.parse(init.body);
    expect(body.start).toEqual({ dateTime: "2030-01-01T10:00:00.000", timeZone: "UTC" });
    expect(body.showAs).toBe("busy");
    expect(body.singleValueExtendedProperties.map((p: { value: string }) => p.value)).toEqual(["a1", "c1"]);
  });

  it("un 401 se reintenta una vez con un token refrescado", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: { code: "InvalidAuthenticationToken" } }, 401))
      .mockResolvedValueOnce(json({ access_token: "access-nuevo", refresh_token: "r2", expires_in: 3600 }))
      .mockResolvedValueOnce(json({ id: "evt-1" }, 201));

    await expect(
      microsoftCalendarProvider.createEvent(target(), {
        appointmentId: "a1", clinicId: "c1", patientName: "Ana", professionalName: "G", service: "S",
        startTime: "2030-01-01T10:00:00.000Z", endTime: "2030-01-01T10:30:00.000Z",
      })
    ).resolves.toBe("evt-1");
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe("Bearer access-nuevo");
  });

  it("rechaza un calendario de otro proveedor", async () => {
    const google = { provider: "google", calendarId: "x", account: null } as CalendarTarget;
    await expect(
      microsoftCalendarProvider.createEvent(google, {} as never)
    ).rejects.toThrow(/Microsoft recibió/);
  });
});

describe("deleteEvent", () => {
  it("un 404 no es un error: el evento ya no estaba", async () => {
    fetchMock.mockResolvedValue(json({ error: { code: "ErrorItemNotFound" } }, 404));
    await expect(microsoftCalendarProvider.deleteEvent(target(), "evt")).resolves.toBeUndefined();
  });

  it("otro error se propaga", async () => {
    fetchMock.mockResolvedValue(json({ error: { code: "ErrorAccessDenied" } }, 403));
    await expect(microsoftCalendarProvider.deleteEvent(target(), "evt")).rejects.toThrow();
  });
});

describe("listBlocks", () => {
  const evento = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    isAllDay: false,
    isCancelled: false,
    showAs: "busy",
    start: { dateTime: "2030-01-01T14:00:00.0000000" },
    end: { dateTime: "2030-01-01T15:00:00.0000000" },
    ...extra,
  });

  it("pide la vista expandida en UTC y recorre las páginas", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({
          value: [evento("a")],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendars/x/calendarView?$skiptoken=1",
        })
      )
      .mockResolvedValueOnce(json({ value: [evento("b")] }));

    const blocks = await microsoftCalendarProvider.listBlocks(target(), new Date("2030-01-01"), new Date("2030-02-01"));

    expect(blocks.map((b) => b.externalEventId)).toEqual(["a", "b"]);
    expect(blocks[0].startTime.toISOString()).toBe("2030-01-01T14:00:00.000Z");
    expect(fetchMock.mock.calls[0][0]).toContain("/calendarView?startDateTime=");
    expect(fetchMock.mock.calls[0][1].headers.Prefer).toBe('outlook.timezone="UTC"');
  });

  it("descarta turnos propios, libres, cancelados y rechazados; conserva tentativos y de día completo", async () => {
    const id = "String {b3a1d5e8-6f2c-4c7a-9d14-2e8f0a7c5b61} Name appointmentId";
    fetchMock.mockResolvedValue(
      json({
        value: [
          evento("propio", { singleValueExtendedProperties: [{ id, value: "a1" }] }),
          evento("libre", { showAs: "free" }),
          evento("cancelado", { isCancelled: true }),
          evento("rechazado", { responseStatus: { response: "declined" } }),
          evento("sin-fin", { end: {} }),
          evento("tentativo", { showAs: "tentative" }),
          evento("vacaciones", { isAllDay: true }),
        ],
      })
    );

    const blocks = await microsoftCalendarProvider.listBlocks(target(), new Date(), new Date());

    expect(blocks.map((b) => b.externalEventId)).toEqual(["tentativo", "vacaciones"]);
    expect(blocks[1].isAllDay).toBe(true);
  });

  it("no sigue un nextLink que no sea de Graph (no le manda el token a otro host)", async () => {
    fetchMock.mockResolvedValue(json({ value: [], "@odata.nextLink": "https://evil.example/steal" }));
    await expect(
      microsoftCalendarProvider.listBlocks(target(), new Date(), new Date())
    ).rejects.toThrow(/URL de Graph inesperada/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("listAvailableMicrosoftCalendars", () => {
  it("solo ofrece los calendarios que se pueden editar", async () => {
    fetchMock.mockResolvedValue(
      json({
        value: [
          { id: "1", name: "Calendario", isDefaultCalendar: true, canEdit: true },
          { id: "2", name: "Feriados", isDefaultCalendar: false, canEdit: false },
        ],
      })
    );
    const calendars = await listAvailableMicrosoftCalendars(account());
    expect(calendars).toEqual([{ id: "1", summary: "Calendario", primary: true, timeZone: null }]);
  });
});

describe("handleAccessError", () => {
  it("marca la cuenta como revocada solo con un error de revocación", async () => {
    update.mockResolvedValue({});
    const revocada = await microsoftCalendarProvider.handleAccessError(
      target(),
      new MicrosoftAuthError("x", true)
    );
    expect(revocada).toEqual({ email: "agenda@clinica.com" });
    expect(update).toHaveBeenCalledOnce();

    update.mockClear();
    await expect(microsoftCalendarProvider.handleAccessError(target(), new Error("red caída"))).resolves.toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("resolveCalendarTargetForProfessional con Microsoft", () => {
  const ms = account();

  it("un profesional de Microsoft usa su cuenta", () => {
    const t = resolveCalendarTargetForProfessional(
      { sharedCalendarId: null },
      { googleCalendarId: "cal", calendarProvider: "microsoft", microsoftAccount: ms }
    );
    expect(t).toMatchObject({ provider: "microsoft", calendarId: "cal", account: ms });
  });

  it("sin cuenta cargada devuelve null: no hay cuenta de servicio de respaldo", () => {
    expect(
      resolveCalendarTargetForProfessional(
        { sharedCalendarId: null },
        { googleCalendarId: "cal", calendarProvider: "microsoft", microsoftAccount: null }
      )
    ).toBeNull();
  });

  it("el calendario compartido de la clínica manda y trae su proveedor", () => {
    const t = resolveCalendarTargetForProfessional(
      { sharedCalendarId: "shared", sharedCalendarProvider: "microsoft", sharedCalendarMicrosoftAccount: ms },
      { googleCalendarId: "personal", calendarProvider: "google" }
    );
    expect(t).toMatchObject({ provider: "microsoft", calendarId: "shared" });
  });
});
