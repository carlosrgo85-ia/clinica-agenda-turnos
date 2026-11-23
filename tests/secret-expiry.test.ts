import { describe, expect, it, vi } from "vitest";
import {
  daysUntil,
  describeDays,
  expiryState,
  isTooFarAhead,
  parseExpiryDate,
  shouldRemindToday,
} from "../src/services/secret-expiry";
import { runSecretExpiryReminders, type SecretReminderDeps } from "../src/jobs/secret-expiry-alerts";
import type { PlatformSecretRecord } from "../src/repositories/platform-secrets.repository";

/**
 * El recordatorio de vencimiento del secreto de la app de Microsoft: todos
 * los días desde 7 días antes, una vez por día, y también después de vencido.
 */

describe("parseExpiryDate", () => {
  it("acepta una fecha real", () => {
    expect(parseExpiryDate("2027-03-15")).toBe("2027-03-15");
    expect(parseExpiryDate(" 2027-03-15 ")).toBe("2027-03-15");
  });

  it("rechaza los días imposibles en vez de correrlos (el 31 de febrero no es el 3 de marzo)", () => {
    expect(parseExpiryDate("2027-02-31")).toBeNull();
    expect(parseExpiryDate("2027-13-01")).toBeNull();
  });

  it("rechaza lo que no es una fecha", () => {
    expect(parseExpiryDate("15/03/2027")).toBeNull();
    expect(parseExpiryDate("")).toBeNull();
    expect(parseExpiryDate(20270315)).toBeNull();
    expect(parseExpiryDate(undefined)).toBeNull();
  });
});

describe("daysUntil / expiryState", () => {
  it("cuenta días de calendario", () => {
    expect(daysUntil("2027-03-15", "2027-03-08")).toBe(7);
    expect(daysUntil("2027-03-15", "2027-03-15")).toBe(0);
    expect(daysUntil("2027-03-15", "2027-03-17")).toBe(-2);
  });

  it("cruza fin de mes y año bisiesto sin errores", () => {
    expect(daysUntil("2028-03-01", "2028-02-28")).toBe(2); // 2028 es bisiesto
    expect(daysUntil("2027-01-02", "2026-12-30")).toBe(3);
  });

  it("la ventana es de 7 días", () => {
    expect(expiryState(8)).toBe("ok");
    expect(expiryState(7)).toBe("por_vencer");
    expect(expiryState(0)).toBe("por_vencer");
    expect(expiryState(-1)).toBe("vencido");
  });

  it("rechaza fechas a más de 3 años (casi seguro un typo)", () => {
    expect(isTooFarAhead("2031-01-01", "2027-01-01")).toBe(true);
    expect(isTooFarAhead("2028-06-01", "2027-01-01")).toBe(false);
  });
});

describe("shouldRemindToday", () => {
  const hoy = "2027-03-10";

  it("no avisa si faltan más de 7 días", () => {
    expect(shouldRemindToday(8, null, hoy)).toBe(false);
  });

  it("avisa desde el día 7, una vez por día", () => {
    expect(shouldRemindToday(7, null, hoy)).toBe(true);
    expect(shouldRemindToday(7, "2027-03-09", hoy)).toBe(true); // ayer
    expect(shouldRemindToday(7, hoy, hoy)).toBe(false); // ya salió hoy
  });

  it("sigue avisando después de vencido", () => {
    expect(shouldRemindToday(-3, "2027-03-09", hoy)).toBe(true);
  });
});

describe("describeDays", () => {
  it("redacta cada caso", () => {
    expect(describeDays(5)).toBe("vence en 5 días");
    expect(describeDays(1)).toBe("vence mañana");
    expect(describeDays(0)).toBe("vence HOY");
    expect(describeDays(-1)).toBe("venció ayer");
    expect(describeDays(-4)).toBe("venció hace 4 días");
  });
});

describe("runSecretExpiryReminders", () => {
  const KEY = "microsoft_oauth_client_secret";

  function setup(
    secret: Partial<PlatformSecretRecord> | null,
    overrides: Partial<SecretReminderDeps> = {},
    today = "2027-03-10"
  ) {
    const secrets: PlatformSecretRecord[] = secret
      ? [{ key: KEY, expiresOn: "2027-03-15", note: null, lastReminderOn: null, hasStoredValue: false, ...secret }]
      : [];
    const send = vi.fn().mockResolvedValue(undefined);
    const markReminded = vi.fn().mockResolvedValue(undefined);
    const deps: SecretReminderDeps = {
      today,
      listSecrets: async () => secrets,
      listRecipients: async () => ["admin@plataforma.com", "otro@plataforma.com"],
      send,
      markReminded,
      ...overrides,
    };
    return { deps, send, markReminded };
  }

  it("a 5 días: manda un solo mail a todos los admins y marca el día", async () => {
    const { deps, send, markReminded } = setup({});
    await expect(runSecretExpiryReminders(deps)).resolves.toEqual([KEY]);

    expect(send).toHaveBeenCalledOnce();
    const mail = send.mock.calls[0][0];
    expect(mail.to).toEqual(["admin@plataforma.com", "otro@plataforma.com"]);
    expect(mail.cuando).toBe("vence en 5 días");
    expect(mail.vencido).toBe(false);
    expect(mail.renewal.length).toBeGreaterThan(0);
    expect(markReminded).toHaveBeenCalledWith(KEY, "2027-03-10");
  });

  it("a más de 7 días no manda nada", async () => {
    const { deps, send } = setup({ expiresOn: "2027-04-01" });
    await expect(runSecretExpiryReminders(deps)).resolves.toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("no repite el mismo día aunque el job corra de nuevo", async () => {
    const { deps, send } = setup({ lastReminderOn: "2027-03-10" });
    await runSecretExpiryReminders(deps);
    expect(send).not.toHaveBeenCalled();
  });

  it("al día siguiente vuelve a avisar", async () => {
    const { deps, send } = setup({ lastReminderOn: "2027-03-10" }, {}, "2027-03-11");
    await runSecretExpiryReminders(deps);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].cuando).toBe("vence en 4 días");
  });

  it("vencido sigue avisando y lo dice", async () => {
    const { deps, send } = setup({}, {}, "2027-03-18");
    await runSecretExpiryReminders(deps);
    const mail = send.mock.calls[0][0];
    expect(mail.vencido).toBe(true);
    expect(mail.cuando).toBe("venció hace 3 días");
  });

  it("si el mail falla NO marca el día: el próximo intento lo reintenta", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, markReminded } = setup({}, { send: vi.fn().mockRejectedValue(new Error("SMTP caído")) });

    await expect(runSecretExpiryReminders(deps)).resolves.toEqual([]);

    expect(markReminded).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("sin administradores a quien avisar no manda ni marca (y lo loguea)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, send, markReminded } = setup({}, { listRecipients: async () => [] });

    await expect(runSecretExpiryReminders(deps)).resolves.toEqual([]);

    expect(send).not.toHaveBeenCalled();
    expect(markReminded).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("un secreto con el valor guardado pero sin seguir el vencimiento no avisa", async () => {
    const { deps, send } = setup({ expiresOn: null, hasStoredValue: true });
    await expect(runSecretExpiryReminders(deps)).resolves.toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("sin fecha registrada no hace nada", async () => {
    const { deps, send } = setup(null);
    await expect(runSecretExpiryReminders(deps)).resolves.toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("ignora una clave que ya no está en el catálogo", async () => {
    const { deps, send } = setup({ key: "otra_cosa" });
    await expect(runSecretExpiryReminders(deps)).resolves.toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});
