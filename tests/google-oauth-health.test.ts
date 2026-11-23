import { describe, expect, it, vi } from "vitest";
import { runGoogleOAuthHealthCheck, type GoogleOAuthHealthDeps } from "../src/jobs/google-oauth-health";

const CONFIG = { clientId: "id-123456789", clientSecret: "SECRETO-NO-DEBE-SALIR", redirectUri: "http://x/cb", source: "base" as const };

function deps(over: Partial<GoogleOAuthHealthDeps> = {}) {
  const d = {
    getConfig: vi.fn().mockResolvedValue(CONFIG),
    verify: vi.fn().mockResolvedValue("valido"),
    listRecipients: vi.fn().mockResolvedValue(["admin@plataforma.test"]),
    send: vi.fn().mockResolvedValue(undefined),
    recordEvent: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
  return d as typeof d & GoogleOAuthHealthDeps;
}

describe("comprobación diaria de la app de OAuth de Google", () => {
  it("si Google la acepta no avisa ni registra nada", async () => {
    const d = deps();
    expect(await runGoogleOAuthHealthCheck(d)).toBe("valido");
    expect(d.send).not.toHaveBeenCalled();
    expect(d.recordEvent).not.toHaveBeenCalled();
  });

  it("sin app configurada no hay nada que verificar", async () => {
    const d = deps({ getConfig: vi.fn().mockResolvedValue(null) });
    expect(await runGoogleOAuthHealthCheck(d)).toBe("sin_configurar");
    expect(d.verify).not.toHaveBeenCalled();
  });

  it("si Google la rechaza deja un evento en Monitoreo y avisa a los administradores, sin el secreto", async () => {
    const d = deps({ verify: vi.fn().mockResolvedValue("invalido") });
    expect(await runGoogleOAuthHealthCheck(d)).toBe("invalido");
    expect(d.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "google_oauth_invalido", clinicId: null }));
    expect(d.send).toHaveBeenCalledWith(expect.objectContaining({ to: ["admin@plataforma.test"] }));
    expect(JSON.stringify([d.recordEvent.mock.calls, d.send.mock.calls])).not.toContain(CONFIG.clientSecret);
  });

  it("una falla de red no prueba nada sobre el secreto: no avisa ni registra", async () => {
    const d = deps({ verify: vi.fn().mockRejectedValue(new Error("red caída")) });
    expect(await runGoogleOAuthHealthCheck(d)).toBe("no_se_pudo_verificar");
    expect(d.send).not.toHaveBeenCalled();
    expect(d.recordEvent).not.toHaveBeenCalled();
  });

  it("si el mail falla, el evento ya quedó y no se tumba el job", async () => {
    const d = deps({ verify: vi.fn().mockResolvedValue("invalido"), send: vi.fn().mockRejectedValue(new Error("SMTP caído")) });
    await expect(runGoogleOAuthHealthCheck(d)).resolves.toBe("invalido");
    expect(d.recordEvent).toHaveBeenCalled();
  });

  it("sin administradores a quien avisar igual deja el evento y no manda nada", async () => {
    const d = deps({ verify: vi.fn().mockResolvedValue("invalido"), listRecipients: vi.fn().mockResolvedValue([]) });
    expect(await runGoogleOAuthHealthCheck(d)).toBe("invalido");
    expect(d.recordEvent).toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });
});
