import { describe, expect, it } from "vitest";
import { chooseCalendarCredential } from "../src/services/calendar-link";

/**
 * Qué credencial acompaña al calendario al enlazarlo. Lo que se rompe en
 * silencio si queda mal es el espejo (un calendario de Microsoft con la
 * cuenta de Google de otro, o con ninguna).
 */

const enlazando = { calendarBeingSet: true };

describe("chooseCalendarCredential", () => {
  it("deduce Microsoft de la cuenta y suelta la de Google", () => {
    expect(chooseCalendarCredential({ microsoftAccountId: "m1" }, enlazando)).toEqual({
      ok: true,
      provider: "microsoft",
      googleAccountId: null,
      microsoftAccountId: "m1",
    });
  });

  it("deduce Google de la cuenta y suelta la de Microsoft", () => {
    expect(chooseCalendarCredential({ googleAccountId: "g1" }, enlazando)).toEqual({
      ok: true,
      provider: "google",
      googleAccountId: "g1",
      microsoftAccountId: null,
    });
  });

  it("Google con cuenta en null es la cuenta de servicio y es válido", () => {
    expect(chooseCalendarCredential({ provider: "google", googleAccountId: null }, enlazando)).toMatchObject({
      ok: true,
      provider: "google",
      googleAccountId: null,
    });
  });

  it("Microsoft sin cuenta se rechaza al fijar un calendario: no hay cuenta de servicio", () => {
    const r = chooseCalendarCredential({ provider: "microsoft" }, enlazando);
    expect(r).toMatchObject({ ok: false });
    expect(chooseCalendarCredential({ provider: "microsoft", microsoftAccountId: null }, enlazando)).toMatchObject({
      ok: false,
    });
  });

  it("Microsoft sin cuenta es válido si no se está fijando un calendario (solo desenlazar)", () => {
    expect(
      chooseCalendarCredential({ provider: "microsoft" }, { calendarBeingSet: false })
    ).toMatchObject({ ok: true, provider: "microsoft" });
  });

  it("rechaza mezclar las dos cuentas", () => {
    expect(chooseCalendarCredential({ googleAccountId: "g1", microsoftAccountId: "m1" }, enlazando)).toMatchObject({
      ok: false,
    });
    expect(
      chooseCalendarCredential({ provider: "google", microsoftAccountId: "m1" }, enlazando)
    ).toMatchObject({ ok: false });
    expect(
      chooseCalendarCredential({ provider: "microsoft", googleAccountId: "g1" }, enlazando)
    ).toMatchObject({ ok: false });
  });

  it("sin proveedor ni cuenta no toca nada", () => {
    expect(chooseCalendarCredential({}, enlazando)).toEqual({
      ok: true,
      provider: undefined,
      googleAccountId: undefined,
      microsoftAccountId: undefined,
    });
  });

  it("valida los tipos", () => {
    expect(chooseCalendarCredential({ provider: "outlook" }, enlazando)).toMatchObject({ ok: false });
    expect(chooseCalendarCredential({ googleAccountId: 5 }, enlazando)).toMatchObject({ ok: false });
    expect(chooseCalendarCredential({ microsoftAccountId: {} }, enlazando)).toMatchObject({ ok: false });
  });
});
